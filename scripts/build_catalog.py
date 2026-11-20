#!/usr/bin/env python3
"""从 Radio Browser 公共目录拉取全量电台，清洗后写成本地目录 data/catalog.json。

radio.garden 的数据同样源自 Radio Browser / community 目录；直连其站点会被
Cloudflare 拦截，因此这里从源头取数据，自行做策展式清洗，结果离线可用。

清洗内容：
  - 只保留前端真正需要的字段，剔除 20+ 个冗余字段，体积压到原来的 1/4
  - 去空白/控制字符、去重（按 stationuuid）
  - 丢弃无有效 http(s) 流、名称为空的电台
  - 坐标校验：空/越界/(0,0) 一律视为无坐标
  - 编码标准化：只保留前端可解码的常见编码，避免播放时才发现不支持
  - HTTPS 优先：同一电台若 url 与 url_resolved 协议不同，优先 https
  - 标签去重、限量、小写化
  - 按 votes 降序，输出含生成时间与统计的元信息

用法：
  python3 scripts/build_catalog.py                # 全量拉取并写入
  python3 scripts/build_catalog.py --limit 10000  # 只取前 1 万（调试用）
  python3 scripts/build_catalog.py --from-cache   # 用上次下载的原始数据重跑清洗
"""

import argparse
import concurrent.futures
import datetime
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASES = [
    "https://de1.api.radio-browser.info",
    "https://nl1.api.radio-browser.info",
    "https://fi1.api.radio-browser.info",
]
ROOT = Path(__file__).resolve().parent.parent
RAW_CACHE = ROOT / "data" / "catalog.raw.json"
OUTPUT = ROOT / "data" / "catalog.json"
BATCH = 5000
PAGE_SIZE = BATCH
MAX_WORKERS = 4
UA = "AETHER-CatalogBuilder/1.0 (local catalog build)"

# 前端 normalize()/usable() 真正消费的字段
KEEP = (
    "stationuuid", "name", "url", "url_resolved", "favicon", "country", "countrycode",
    "state", "language", "tags", "votes", "clickcount", "codec", "bitrate",
    "geo_lat", "geo_long", "homepage", "lastcheckok",
)
SUPPORTED_CODEC = {"MP3", "AAC", "AAC+", "OGG", "OPUS", "FLAC", "UNKNOWN"}
TAG_MAX = 8
CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")


def http_json(url, timeout=60, retries=3):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.load(res)
        except Exception as exc:  # noqa: BLE001 - 网络重试，错误统一记录
            last = exc
            if attempt + 1 < retries:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"请求失败 {url}: {last}")


def fetch_page(offset, limit):
    params = urllib.parse.urlencode({
        "hidebroken": "true",
        "order": "votes",
        "reverse": "true",
        "limit": str(limit),
        "offset": str(offset),
    })
    last = None
    for idx, base in enumerate(BASES):
        try:
            return http_json(f"{base}/json/stations/search?{params}")
        except Exception as exc:  # noqa: BLE001 - 镜像回退
            last = exc
    raise RuntimeError(f"offset={offset} 全部镜像失败: {last}")


def fetch_all(limit):
    stats = http_json(f"{BASES[0]}/json/stats", timeout=20)
    total = int(stats.get("stations", 0))
    if total <= 0:
        raise RuntimeError("无法读取目录总量")
    target = min(total, limit) if limit else total
    offsets = list(range(0, target, PAGE_SIZE))
    print(f"[fetch] 目录总量 {total:,} 本次目标 {target:,} 分 {len(offsets)} 页并发拉取")

    records = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(fetch_page, off, min(PAGE_SIZE, target - off)): off for off in offsets}
        for fut in concurrent.futures.as_completed(futures):
            off = futures[fut]
            try:
                page = fut.result()
            except Exception as exc:  # noqa: BLE001
                print(f"[fetch] offset={off} 失败，跳过: {exc}", file=sys.stderr)
                continue
            records.extend({k: row.get(k) for k in KEEP} for row in page)
            print(f"[fetch] offset={off:>6} 取得 {len(page):>5} 条，累计 {len(records):>6}")
    return records, total, stats


def clean_text(value, maxlen=200):
    if value is None:
        return ""
    text = CTRL_RE.sub(" ", str(value)).strip()
    return text[:maxlen]


def valid_url(value):
    if not isinstance(value, str):
        return ""
    value = value.strip()
    return value if re.match(r"^https?://", value, re.I) else ""


def coord(value, limit):
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or abs(number) > limit:
        return None
    return number


def clean_tags(raw):
    if not raw:
        return []
    seen, result = set(), []
    for part in str(raw).split(","):
        tag = clean_text(part, 40).lower()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        result.append(tag)
        if len(result) >= TAG_MAX:
            break
    return result


def best_url(record):
    """优先 HTTPS 的可播放流；url_resolved 通常是最终地址，优先采用。"""
    candidates = [valid_url(record.get("url_resolved")), valid_url(record.get("url"))]
    https = [u for u in candidates if u.lower().startswith("https://")]
    return https[0] if https else next((u for u in candidates if u), "")


def normalize(record):
    station_id = clean_text(record.get("stationuuid"), 64)
    name = clean_text(record.get("name"), 120)
    url = best_url(record)
    if not station_id or not name or not url:
        return None

    lat = coord(record.get("geo_lat"), 90)
    lng = coord(record.get("geo_long"), 180)
    has_geo = lat is not None and lng is not None and not (lat == 0 and lng == 0)
    codec = clean_text(record.get("codec"), 24).upper() or "UNKNOWN"
    # 组合编码（如 AAC,H.264）无法可靠判断浏览器是否支持，按 UNKNOWN 放行
    if codec not in SUPPORTED_CODEC:
        codec = "UNKNOWN"

    favicon = valid_url(record.get("favicon"))
    homepage = valid_url(record.get("homepage"))
    return {
        "stationuuid": station_id,
        "name": name,
        "url_resolved": url,
        "favicon": favicon,
        "country": clean_text(record.get("country"), 80),
        "countrycode": clean_text(record.get("countrycode"), 8).lower(),
        "state": clean_text(record.get("state"), 80),
        "language": clean_text(record.get("language"), 80).lower(),
        "tags": ",".join(clean_tags(record.get("tags"))),
        "votes": int(record.get("votes") or 0),
        "clickcount": int(record.get("clickcount") or 0),
        "codec": codec,
        "bitrate": int(record.get("bitrate") or 0),
        "geo_lat": lat if has_geo else None,
        "geo_long": lng if has_geo else None,
        "homepage": homepage,
        "lastcheckok": str(record.get("lastcheckok")) == "1",
    }


def build(records, source_total, stats):
    seen = set()
    stations = []
    dropped = {"duplicate": 0, "invalid": 0}
    for record in records:
        station_id = clean_text(record.get("stationuuid"), 64)
        if station_id and station_id in seen:
            dropped["duplicate"] += 1
            continue
        if station_id:
            seen.add(station_id)
        item = normalize(record)
        if item is None:
            dropped["invalid"] += 1
            continue
        stations.append(item)

    stations.sort(key=lambda s: (-s["votes"], s["name"]))
    with_geo = sum(1 for s in stations if s["geo_lat"] is not None)
    https = sum(1 for s in stations if s["url_resolved"].lower().startswith("https://"))
    countries = len({s["countrycode"] for s in stations if s["countrycode"]})

    payload = {
        "meta": {
            "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "source": "; ".join(BASES),
            "sourceTotal": source_total,
            "fetched": len(records),
            "kept": len(stations),
            "withGeo": with_geo,
            "httpsStreams": https,
            "countries": countries,
            "dropped": dropped,
            "sourceStats": stats,
        },
        "stations": stations,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    return payload


def main():
    parser = argparse.ArgumentParser(description="构建 AETHER 本地电台目录")
    parser.add_argument("--limit", type=int, default=0, help="只取前 N 座（默认全量）")
    parser.add_argument("--from-cache", action="store_true", help="用 data/catalog.raw.json 重跑清洗")
    args = parser.parse_args()

    if args.from_cache:
        if not RAW_CACHE.exists():
            print(f"缓存不存在：{RAW_CACHE}", file=sys.stderr)
            return 1
        cached = json.loads(RAW_CACHE.read_text(encoding="utf-8"))
        records, source_total, stats = cached["records"], cached["sourceTotal"], cached["stats"]
    else:
        records, source_total, stats = fetch_all(args.limit)
        RAW_CACHE.parent.mkdir(parents=True, exist_ok=True)
        RAW_CACHE.write_text(
            json.dumps({"records": records, "sourceTotal": source_total, "stats": stats}, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"[cache] 原始拉取结果已存 {RAW_CACHE}")

    payload = build(records, source_total, stats)
    size = OUTPUT.stat().st_size
    print(f"[done] 写入 {OUTPUT}  保留 {payload['meta']['kept']:,} 座  "
          f"带坐标 {payload['meta']['withGeo']:,}  HTTPS {payload['meta']['httpsStreams']:,}  "
          f"国家 {payload['meta']['countries']}  体积 {size / 1024 / 1024:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
