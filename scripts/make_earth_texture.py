#!/usr/bin/env python3
"""从原始地球贴图生成暗色「夜间地球」贴图。

界面走 Radio Garden 式暗色路线，需要一张海洋近黑、大陆只留暗轮廓的贴图，
让绿色电台光点成为画面唯一高光。直接调 CSS 滤镜会把光点一起压暗，
因此在这里离线生成贴图，运行时零成本。

用法：
    python3 scripts/make_earth_texture.py
    python3 scripts/make_earth_texture.py --input assets/earth-blue-marble.jpg
    python3 scripts/make_earth_texture.py --brightness 0.85   # 整体调亮/调暗

生成结果：assets/earth-night.jpg（2048×1024，约 150 KB）
依赖：Pillow
"""
import argparse
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_INPUT = os.path.join(ROOT, 'assets', 'earth-blue-marble.jpg')
DEFAULT_OUTPUT = os.path.join(ROOT, 'assets', 'earth-night.jpg')

# 输入灰度 → 输出灰度 的分段映射。原始贴图偏暗（中位灰度约 33），
# 海洋集中在 0–18，陆地 20–140。映射后海洋锁死在近黑，陆地只到中暗。
KNOTS = [(0, 0), (18, 3), (45, 26), (90, 54), (140, 80), (255, 104)]

# duotone 系数：三通道接近，只留一点绿意 → 中性石墨大陆，
# 不再整颗发绿，绿色只出现在电台光点上
DUOTONE = (0.66, 0.80, 0.76)

# 极区压暗比例（贴图上下各 10%），避免冰盖成为画面最亮处
# 海洋额外压暗系数（保留色相路线）
OCEAN_GAIN = 0.55

POLAR_BAND = 0.10
POLAR_MIN = 0.45


def build_lut(table, gain=1.0):
    return [min(255, int(v * gain)) for v in table]


def curve_lut(brightness=1.0):
    lut = []
    for i in range(256):
        out = KNOTS[-1][1]
        for k in range(len(KNOTS) - 1):
            x0, y0 = KNOTS[k]
            x1, y1 = KNOTS[k + 1]
            if x0 <= i <= x1:
                out = y0 + (y1 - y0) * (i - x0) / (x1 - x0)
                break
        lut.append(min(255, int(out * brightness)))
    return lut


def main():
    ap = argparse.ArgumentParser(description='生成暗色地球贴图')
    ap.add_argument('--input', default=DEFAULT_INPUT)
    ap.add_argument('--output', default=DEFAULT_OUTPUT)
    ap.add_argument('--size', type=int, default=2048, help='输出宽度，默认 2048')
    ap.add_argument('--brightness', type=float, default=1.0,
                    help='整体亮度倍率，>1 更亮、<1 更暗（默认 1.0）')
    ap.add_argument('--quality', type=int, default=84)
    ap.add_argument('--duotone', action='store_true',
                    help='使用旧的青绿 duotone 路线（整颗球偏石墨灰）')
    args = ap.parse_args()

    if not os.path.exists(args.input):
        sys.exit('找不到输入贴图：%s' % args.input)

    src = Image.open(args.input).convert('RGB')
    lut = curve_lut(args.brightness)

    if args.duotone:
        # 旧路线：转灰度再染青绿 → 整颗球是石墨灰，容易看成「蒙了一层灰」
        gray = src.convert('L').point(lut)
        r = gray.point(build_lut([v * DUOTONE[0] for v in range(256)]))
        g = gray.point(build_lut([v * DUOTONE[1] for v in range(256)]))
        b = gray.point(build_lut([v * DUOTONE[2] for v in range(256)]))
        img = Image.merge('RGB', (r, g, b))
    else:
        # 默认路线：保留原始色相，只按亮度压暗 → 深色但仍是「真实地球」
        # （海洋深蓝近黑、陆地暗褐/暗绿），不再是均匀灰
        small = src.resize((1024, max(1, round(1024 * src.height / src.width))), Image.LANCZOS)
        px = small.load()
        w0, h0 = small.size
        for y in range(h0):
            for x in range(w0):
                R, G, B = px[x, y]
                luma = (R * 299 + G * 587 + B * 114) // 1000
                if luma <= 1:
                    px[x, y] = (0, 0, 0)
                    continue
                k = lut[min(255, luma)] / luma
                # 海洋（蓝通道占优）再压一档：Radio Garden 的海面是近黑深青，
                # 保留原色相时蓝大理石的海太亮，会把绿色光点的对比压掉
                if B > R and B >= G:
                    k *= OCEAN_GAIN
                nr, ng, nb = int(R * k), int(G * k), int(B * k)
                px[x, y] = (min(255, nr), min(255, ng), min(255, nb))
        img = small

    height = max(1, round(args.size * src.height / src.width))
    img = img.resize((args.size, height), Image.LANCZOS)

    # 极区压暗
    w, h = img.size
    band = max(1, int(h * POLAR_BAND))
    px = img.load()
    for y in range(h):
        if y < band:
            k = POLAR_MIN + (1 - POLAR_MIN) * (y / band)
        elif y > h - 1 - band:
            k = POLAR_MIN + (1 - POLAR_MIN) * ((h - 1 - y) / band)
        else:
            continue
        for x in range(w):
            R, G, B = px[x, y]
            px[x, y] = (int(R * k), int(G * k), int(B * k))

    img.save(args.output, 'JPEG', quality=args.quality, optimize=True, progressive=True)
    print('已生成 %s  %dx%d  %d KB'
          % (args.output, img.size[0], img.size[1],
             os.path.getsize(args.output) // 1024))
    print('提示：改完刷新页面即可；球体另有材质压暗（见 app.js 的 globeMaterial），'
          '若贴图整体调亮，同步调低材质 color 才不会发灰。')


if __name__ == '__main__':
    main()
