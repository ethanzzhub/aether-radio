#!/usr/bin/env python3
"""为本地目录中缺失坐标的电台补全推算坐标，并标注来源与可信度。

数据本身来自 Radio Browser，坐标补全使用 GeoNames 的公开地名数据
（cities15000 + admin1CodesASCII，CC-BY 4.0）与 Natural Earth 110m 国界
（public domain），均已放在 scripts/geodata/。

补全分四级，每一级都写入 geoSource 字段，前端可据此区分真实坐标与推算坐标：
  original  原始坐标（Radio Browser 提供，未改动）—— 最高可信
  city      state/地区名精确命中城市（受国家码约束）—— 较高
  admin1    state 命中行政区（州/省），坐标取该区最大城市 —— 中
  country   仅能定位到国家，按人口加权选国内城市并在国界内抖动 —— 低（仅示意）

只有 geo_lat/geo_long 为空的电台才会被补全；已有坐标的坐标与 geoSource 一律保留。
country 级不再使用固定半径的方形抖动（会在地图上形成方块），而是：
  1. 按人口权重从该国 GeoNames 城市中选一个锚点（人口开方，给小城市机会）；
  2. 在锚点附近做确定性抖动（幅度随城市规模变化）；
  3. 用射线法做 point-in-polygon 检测，只接受落在本国国界内的点；
  4. 台湾（countrycode=tw）使用单独的台湾省边界，不作为中国以外区域处理。

用法：
  python3 scripts/fill_coords.py            # 补全并写回 data/catalog.json
  python3 scripts/fill_coords.py --dry-run  # 只统计，不写文件
  python3 scripts/fill_coords.py --no-jitter  # 国家级直接取最大城市中心（不抖动）
"""

import argparse
import hashlib
import json
import math
import random
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "data" / "catalog.json"
GEODATA = ROOT / "scripts" / "geodata"
CITIES = GEODATA / "cities15000.txt"
ADMIN1 = GEODATA / "admin1CodesASCII.txt"
BORDERS = GEODATA / "countries-110m.json"

# 用国家码约束时允许的常见别名误写，避免再出现 Florida→哥伦比亚 这类错配
ADMIN1_ALIASES = {
    ("us", "florida"): "US.FL", ("us", "california"): "US.CA",
    ("us", "new york"): "US.NY", ("us", "texas"): "US.TX",
}


def norm(value):
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    return re.sub(r"\s+", " ", text)


def strip_accents(value):
    """去掉变音符号：Baden-Württemberg 与 GeoNames 的 Baden-Wurttemberg 才能匹配。"""
    decomposed = unicodedata.normalize("NFKD", norm(value))
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def load_geonames():
    cities = []
    for line in CITIES.read_text(encoding="utf-8").splitlines():
        f = line.split("\t")
        if len(f) < 15:
            continue
        try:
            lat, lng = float(f[4]), float(f[5])
        except ValueError:
            continue
        names = {f[1], f[2]} | {n for n in f[3].split(",") if n.strip()}
        keys = set()
        for n in names:
            keys.add(norm(n))
            bare = strip_accents(n)
            if bare:
                keys.add(bare)
        cities.append({
            "names": keys,
            "cc": f[8].lower(),
            "a1": f[10],
            "lat": lat,
            "lng": lng,
            "pop": int(f[14] or 0),
        })

    # 城市名索引：国家约束优先，全局兜底用人口最大者
    city_cc, city_global = {}, {}
    for c in sorted(cities, key=lambda c: -c["pop"]):
        for n in c["names"]:
            city_cc.setdefault((c["cc"], n), c)
            city_global.setdefault(n, c)

    # 按国家归集城市，供 country 级按人口加权采样
    country_cities = {}
    for c in cities:
        country_cities.setdefault(c["cc"], []).append(c)

    # 行政区名 -> (cc, a1)。admin1CodesASCII 每行的 key 是 cc.a1
    admin_names = {}
    for line in ADMIN1.read_text(encoding="utf-8").splitlines():
        f = line.split("\t")
        if len(f) < 2:
            continue
        key = f[0]  # 例如 US.FL
        cc, _, a1 = key.partition(".")
        for n in (f[1], f[2]):
            if n and n.strip():
                admin_names.setdefault((cc.lower(), norm(n)), a1)
                bare = strip_accents(n)
                if bare:
                    admin_names.setdefault((cc.lower(), bare), a1)
    for (cc, name), key in ADMIN1_ALIASES.items():
        _, _, a1 = key.partition(".")
        admin_names.setdefault((cc, name), a1)

    # 每个行政区 / 国家的人口最大城市，用作区域中心
    admin_center, country_center = {}, {}
    for c in sorted(cities, key=lambda c: -c["pop"]):
        if c["a1"]:
            admin_center.setdefault((c["cc"], c["a1"]), c)
        country_center.setdefault(c["cc"], c)

    return city_cc, city_global, admin_names, admin_center, country_center, country_cities


def prepare_ring(ring):
    """把一个边界环归一化：跨 ±180 经线时整体平移到正经一侧，并算 bbox。"""
    lngs = [p[0] for p in ring]
    shifted = max(lngs) - min(lngs) > 180
    pts = [(p[0] + 360 if shifted and p[0] < 0 else p[0], p[1]) for p in ring]
    minx, maxx = min(x for x, _ in pts), max(x for x, _ in pts)
    miny, maxy = min(y for _, y in pts), max(y for _, y in pts)
    return {
        "pts": pts,
        "minx": minx, "maxx": maxx, "miny": miny, "maxy": maxy,
        "shifted": shifted,
        "area": (maxx - minx) * (maxy - miny),
    }


def load_borders():
    """加载国界；台湾省作为独立采样区域，同时并入中国边界。"""
    data = json.loads(BORDERS.read_text(encoding="utf-8"))
    countries = {cc: [prepare_ring(r) for r in e["rings"]]
                 for cc, e in data["countries"].items()}
    regions = {name: [prepare_ring(r) for r in e["rings"]]
               for name, e in data["regions"].items()}
    return countries, regions


def point_in_ring(lng, lat, ring):
    """射线法判断点是否在多边形内（含边界近似）。"""
    inside = False
    pts = ring["pts"]
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > lat) != (yj > lat):
            xint = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lng < xint:
                inside = not inside
        j = i
    return inside


def in_region(lng, lat, rings):
    for ring in rings:
        x = lng + 360 if ring["shifted"] and lng < 0 else lng
        if x < ring["minx"] or x > ring["maxx"] or lat < ring["miny"] or lat > ring["maxy"]:
            continue
        if point_in_ring(x, lat, ring):
            return True
    return False


def sample_in_region(station_id, cc, rings, country_cities, no_jitter):
    """在国界内取一个确定性坐标；失败时逐步回退到城市中心。"""
    seed = int.from_bytes(hashlib.sha256(station_id.encode("utf-8")).digest()[:8], "big")
    rng = random.Random(seed)
    cities = country_cities.get(cc, [])
    if not cities:
        return None
    if no_jitter:
        capital = max(cities, key=lambda c: c["pop"])
        return round(capital["lat"], 4), round(capital["lng"], 4)

    # 人口开方加权：人口多的城市机会更大，小城市也有代表性
    weights = [math.sqrt(c["pop"]) + 1 for c in cities]
    center = rng.choices(cities, weights=weights, k=1)[0]
    span = min(0.7, 0.05 + 0.05 * math.log10(center["pop"] + 10))
    for _ in range(40):
        lat = center["lat"] + rng.uniform(-span, span)
        lng = center["lng"] + rng.uniform(-span, span) / max(0.2, math.cos(math.radians(lat)))
        if -85 <= lat <= 85 and in_region(lng, lat, rings):
            return round(lat, 4), round(lng, 4)

    # 城市锚点或抖动点落在 110m 简化边界外（多为岛屿/飞地），退到整个国界内采样：
    # 按每个边界环的 bbox 面积加权选环，再在该环 bbox 内做拒绝采样，保证点在界内。
    areas = [r["area"] for r in rings]
    for _ in range(200):
        ring = rng.choices(rings, weights=areas, k=1)[0]
        lat = rng.uniform(ring["miny"], ring["maxy"])
        x = rng.uniform(ring["minx"], ring["maxx"])
        lng = x - 360 if ring["shifted"] and x > 180 else x
        if in_region(lng, lat, rings):
            return round(lat, 4), round(lng, 4)
    # 理论不可达：若仍失败，返回国界内第一个顶点微偏移
    r = rings[0]
    return round((r["miny"] + r["maxy"]) / 2, 4), round((r["minx"] + r["maxx"]) / 2, 4)


def main():
    parser = argparse.ArgumentParser(description="补全电台推算坐标")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写入")
    parser.add_argument("--no-jitter", action="store_true", help="国家级坐标不抖动")
    args = parser.parse_args()

    payload = json.loads(CATALOG.read_text(encoding="utf-8"))
    stations = payload["stations"]
    city_cc, city_global, admin_names, admin_center, country_center, country_cities = load_geonames()
    countries, regions = load_borders()

    stats = {"original": 0, "city": 0, "admin1": 0, "country": 0, "unresolved": 0}
    for s in stations:
        if s.get("geo_lat") is not None and s.get("geo_long") is not None:
            s["geoSource"] = "original"
            stats["original"] += 1
            continue

        cc = (s.get("countrycode") or "").lower()
        state = norm(s.get("state"))
        state_bare = strip_accents(state)

        # 先查行政区：像 Missouri / California 这类州名在 GeoNames 城市库里
        # 也可能有同名居民点，必须让 admin1 优先，否则会把整个州错配到某个小镇。
        a1 = (admin_names.get((cc, state)) or admin_names.get((cc, state_bare))) if state and cc else None
        center = admin_center.get((cc, a1)) if a1 else None
        if center:
            s["geo_lat"], s["geo_long"] = center["lat"], center["lng"]
            s["geoSource"] = "admin1"
            stats["admin1"] += 1
            continue

        # 1) 城市级：state 精确命中城市，严格国家约束
        hit = (city_cc.get((cc, state)) or city_cc.get((cc, state_bare))) if state else None
        if hit and (not cc or hit["cc"] == cc):
            s["geo_lat"], s["geo_long"] = hit["lat"], hit["lng"]
            s["geoSource"] = "city"
            stats["city"] += 1
            continue

        # 3) 国家级：按人口加权选国内城市，国界内确定性抖动
        #    台湾用台湾省边界，不作为中国以外区域处理
        rings = (regions.get(cc) or countries.get(cc)) if cc else None
        point = sample_in_region(s["stationuuid"], cc, rings, country_cities, args.no_jitter) if rings else None
        if point is None:
            capital = country_center.get(cc)
            if capital:
                point = (capital["lat"], capital["lng"])
        if point:
            s["geo_lat"], s["geo_long"] = point
            s["geoSource"] = "country"
            stats["country"] += 1
            continue

        stats["unresolved"] += 1

    total = len(stations)
    with_geo = sum(1 for s in stations if s.get("geo_lat") is not None)
    print(f"[stats] {stats}")
    print(f"[result] 有坐标 {with_geo}/{total} ({round(with_geo/total*100,1)}%)  "
          f"推算 {stats['city']+stats['admin1']+stats['country']:,}  "
          f"仍无坐标 {stats['unresolved']:,}")

    if not args.dry_run:
        payload["meta"]["geoFill"] = {
            "generatedAt": payload["meta"].get("generatedAt"),
            "sources": "GeoNames cities15000 + admin1CodesASCII (CC-BY 4.0); "
                       "Natural Earth 110m borders (public domain)",
            "levels": stats,
            "withGeo": with_geo,
        }
        payload["meta"]["withGeo"] = with_geo
        CATALOG.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        print(f"[done] 写回 {CATALOG}  {CATALOG.stat().st_size / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    main()
