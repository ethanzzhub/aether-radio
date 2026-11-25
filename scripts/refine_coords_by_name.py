#!/usr/bin/env python3
"""根据电台名称中含有的地名，复核并修正低可信度的推算坐标。

背景：fill_coords.py 只利用 state/国家码推算位置，国家级坐标是国界内的
确定性随机点，与实际发射地可能相差数百公里。许多电台名称本身带有城市名
（如 "Radio Pakistan Lahore"、"LBC London"、"XY FM Surabaya"），也是可用线索。

保守规则：
  - 只处理 geoSource 为 country / admin1 的推算点；original 与 city 一律不动；
  - 国家码约束下匹配 GeoNames 城市，去音调、去通用电台词后按词长生成候选；
  - 双词及以上城市要求人口 >= 5 万，单词城市要求 >= 20 万，避免小镇同名误判；
  - 命中后标记 geoSource=nameCity，并写入 nameHint 记录命中的名称片段；
  - 写回前保留 data/catalog.before-name-refine.json 备份，可用 --undo 撤销。

用法：
  python3 scripts/refine_coords_by_name.py --dry-run   # 先看命中质量
  python3 scripts/refine_coords_by_name.py             # 写回 catalog.json
  python3 scripts/refine_coords_by_name.py --undo      # 从备份恢复
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fill_coords import load_geonames, strip_accents, CATALOG, ROOT  # noqa: E402

BACKUP = ROOT / "data" / "catalog.before-name-refine.json"

# 电台名里的通用词，不能当作地名线索
STOP = set("""
radio fm am tv news music musical hits hit classic classics gold greatest
mix mixed live station stations stereo network networks the of and for your
my a an in on at to with from by is it this that new old hot cool best super
ultra mega prime time world international national local community public
digital hd web online only all play playing signal señal nacional nační
sveriges radio yle bbc cnn voice voices people today news talk sport sports
cafe cafe' jazz blues rock pop dance techno house metal folk soul reggae
latin india indie opera religious christian islamicEN gospell 90s 80s 70s
""".lower().split())

# 已知误判词：GeoNames 里有同名城市，但在电台名中通常不是地名。
# 两字母的州/省缩写尤其危险：Granby QC 会被误当成魁北克市，La Tricolor 会被
# 误当成洛杉矶；但电台名里出现这些缩写通常指行政区或西语冠词，不是城市。
DENY = {
    "maa", "motown", "top", "super", "star", "love",
    "la", "qc", "bc", "ab", "on", "ns", "nb", "mb", "sk", "yt", "nt", "nu",
    "pa", "tx", "ny", "ca", "fl", "il", "wa", "or", "ga", "al", "az", "oh",
}


def candidates(name):
    """返回 (候选词, 词数) 列表，长词优先。"""
    text = strip_accents(name)
    text = re.sub(r"[\[\](){}<>\"'`.,;:!?/\\|+&@]", " ", text)
    text = re.sub(r"\b\d+(?:\.\d+)?\b", " ", text)
    tokens = [w for w in text.split() if len(w) > 1 and w not in STOP and w not in DENY]
    out = []
    for n in (3, 2, 1):
        for i in range(len(tokens) - n + 1):
            out.append((" ".join(tokens[i:i + n]), n))
    return out


def find_city(name, cc, city_cc):
    """在给定国家内找最可信的城市命中，返回 (hint, city) 或 None。"""
    best = None
    for hint, n in candidates(name):
        hit = city_cc.get((cc, hint))
        if not hit:
            continue
        if (n >= 2 and hit["pop"] < 50000) or (n == 1 and hit["pop"] < 200000):
            continue
        score = n * 10_000_000 + hit["pop"]
        if best is None or score > best[0]:
            best = (score, hint, hit)
    return (best[1], best[2]) if best else None


def main():
    ap = argparse.ArgumentParser(description="按电台名称复核推算坐标")
    ap.add_argument("--dry-run", action="store_true", help="只统计不写回")
    ap.add_argument("--undo", action="store_true", help="从备份恢复 catalog.json")
    ap.add_argument("--examples", type=int, default=12, help="打印的样例数量")
    args = ap.parse_args()

    if args.undo:
        if not BACKUP.exists():
            print("没有找到备份文件：%s" % BACKUP, file=sys.stderr)
            return 1
        shutil.copyfile(BACKUP, CATALOG)
        print("[undo] 已从 %s 恢复 catalog.json" % BACKUP.name)
        return 0

    payload = json.loads(CATALOG.read_text(encoding="utf-8"))
    city_cc, _city_global, _admin_names, _admin_center, _country_center, _country_cities = load_geonames()
    levels = payload.get("meta", {}).get("geoFill", {}).get("levels", {})

    changed = 0
    examples = []
    tally = {}
    for s in payload["stations"]:
        src = s.get("geoSource")
        if src not in ("country", "admin1"):
            continue
        cc = (s.get("countrycode") or "").lower()
        if not cc:
            continue
        hit = find_city(s.get("name", ""), cc, city_cc)
        if not hit:
            continue
        hint, city = hit
        if src == "admin1" and s.get("state"):
            # 行政级已有州/省线索：仅当名称城市同属一个大区时才回修，
            # 避免把 "Radio X Miami" 这类全国性节目名错配到迈阿密。
            a1 = _admin_names.get((cc, strip_accents(s.get("state"))))
            if a1 and city["a1"] and city["a1"] != a1:
                continue
        s["geo_lat"], s["geo_long"] = city["lat"], city["lng"]
        s["geoSource"] = "nameCity"
        s["nameHint"] = hint
        changed += 1
        tally[src] = tally.get(src, 0) + 1
        levels[src] = max(0, levels.get(src, 0) - 1)
        levels["nameCity"] = levels.get("nameCity", 0) + 1
        if len(examples) < args.examples:
            examples.append((s["name"][:42], cc, src, hint, city["lat"], city["lng"]))

    print("[stats] 回修 %d 座（country %d / admin1 %d）" % (changed, tally.get("country", 0), tally.get("admin1", 0)))
    print("[levels] %s" % levels)
    for e in examples:
        print("  %-42s %-3s %-7s <- %s  (%.3f, %.3f)" % e)

    if args.dry_run:
        print("[dry-run] 未写文件")
        return 0
    if not changed:
        print("[done] 无变更")
        return 0

    if not BACKUP.exists():
        shutil.copyfile(CATALOG, BACKUP)
        print("[backup] %s" % BACKUP.name)
    payload["meta"]["geoFill"]["levels"] = levels
    payload["meta"]["geoFill"]["sources"] += "; station-name city hints (GeoNames)"
    payload["meta"]["geoFill"]["nameRefine"] = {
        "changed": changed,
        "bySource": tally,
        "rules": "country/admin1 only; country-constrained GeoNames city; "
                 "2+ tokens pop>=50k, 1 token pop>=200k; admin1 requires matching region"
    }
    tmp = CATALOG.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(CATALOG)
    print("[done] 写回 %s  %.2f MB" % (CATALOG.name, CATALOG.stat().st_size / 1024 / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
