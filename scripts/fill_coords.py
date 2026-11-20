#!/usr/bin/env python3
"""为本地目录中缺失坐标的电台补全推算坐标，并标注来源与可信度。

数据本身来自 Radio Browser，坐标补全使用 GeoNames 的公开地名数据
（cities15000 + admin1CodesASCII，CC-BY 4.0），已放在 scripts/geodata/。

补全分四级，每一级都写入 geoSource 字段，前端可据此区分真实坐标与推算坐标：
  original  原始坐标（Radio Browser 提供，未改动）—— 最高可信
  city      state/地区名精确命中城市（受国家码约束）—— 较高
  admin1    state 命中行政区（州/省），坐标取该区最大城市 —— 中
  country   仅能定位到国家，坐标取该国最大城市 + 确定性抖动 —— 低（仅示意）

只有 geo_lat/geo_long 为空的电台才会被补全；已有坐标的坐标与 geoSource 一律保留。

用法：
  python3 scripts/fill_coords.py            # 补全并写回 data/catalog.json
  python3 scripts/fill_coords.py --dry-run  # 只统计，不写文件
  python3 scripts/fill_coords.py --no-jitter  # 国家级不抖动（点会重叠在国家中心）
"""

import argparse
import hashlib
import json
import math
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "data" / "catalog.json"
GEODATA = ROOT / "scripts" / "geodata"
CITIES = GEODATA / "cities15000.txt"
ADMIN1 = GEODATA / "admin1CodesASCII.txt"

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

    return city_cc, city_global, admin_names, admin_center, country_center


def jitter(station_id, lat, lng):
    """国家级坐标抖动：在 ±1.2° 范围内按 id 哈希确定落点，避免全国堆在一点。"""
    digest = hashlib.sha256(station_id.encode("utf-8")).digest()
    a = int.from_bytes(digest[0:4], "big") / 2**32 * 2 - 1
    b = int.from_bytes(digest[4:8], "big") / 2**32 * 2 - 1
    lat = max(-85.0, min(85.0, lat + a * 1.2))
    lng = (lng + b * 1.2 + 180) % 360 - 180
    return round(lat, 4), round(lng, 4)


def main():
    parser = argparse.ArgumentParser(description="补全电台推算坐标")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写入")
    parser.add_argument("--no-jitter", action="store_true", help="国家级坐标不抖动")
    args = parser.parse_args()

    payload = json.loads(CATALOG.read_text(encoding="utf-8"))
    stations = payload["stations"]
    city_cc, city_global, admin_names, admin_center, country_center = load_geonames()

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

        # 3) 国家级：取该国人口最大城市，按 id 哈希抖动
        capital = country_center.get(cc)
        if capital:
            lat, lng = capital["lat"], capital["lng"]
            if not args.no_jitter:
                lat, lng = jitter(s["stationuuid"], lat, lng)
            s["geo_lat"], s["geo_long"] = lat, lng
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
            "sources": "GeoNames cities15000 + admin1CodesASCII (CC-BY 4.0)",
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
