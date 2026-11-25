#!/usr/bin/env python3
"""AETHER 频道体检：批量检测电台流能否播放、是否卡顿。

判定标准（可通过命令行参数调整）：
  1. 能解析 URL 并完成 HTTP/HTTPS 连接（跟随最多 4 次跳转），状态 200/206；
  2. 返回内容是音频（MIME 或音频魔数），不是错误页；
  3. 首包 8 秒内到达；
  4. 采样窗口内持续有数据，相邻数据块间隔不超过 1.5 秒（视为不卡顿）；
  5. 有效码率 >= 32 kbps，且不低于目录标称码率的 35%。

结果原子写入两个文件：
  data/stream-health.json  完整明细，供排查
  data/stream-bad.json     仅失败电台 id，供前端加载后隐藏

任一文件损坏或过旧时，前端不做过滤（fail-open），不会误伤全部频道。
支持断点续跑：默认跳过 24 小时内已检测过的电台，--force 可全量重检。
"""
import argparse
import http.client
import json
import os
import fcntl
import socket
import ssl
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, 'data')
CATALOG_FILE = os.path.join(DATA_DIR, 'catalog.json')
HEALTH_FILE = os.path.join(DATA_DIR, 'stream-health.json')
BAD_FILE = os.path.join(DATA_DIR, 'stream-bad.json')
LOCK_FILE = os.path.join(DATA_DIR, '.stream-check.lock')

REDIRECTS = {301, 302, 303, 307, 308}
CHUNK = 1024
SSL_CTX = ssl.create_default_context()
USER_AGENT = 'Mozilla/5.0 (compatible; AETHER-StreamCheck/1.0)'


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')


def atomic_write(path, obj):
    """先写临时文件再替换，避免中途退出留下半截 JSON。"""
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(',', ':'))
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def looks_audio(head, ctype):
    """用魔数或 MIME 判断响应体确实是音频，而不是错误 HTML。"""
    if head.startswith(b'ID3'):
        return True
    if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
        return True  # MP3 / AAC 帧同步
    if head.startswith((b'OggS', b'fLaC', b'ADIF', b'\x30\x26\xB2\x75')):
        return True  # Ogg / FLAC / ADIF / ASF(WMA)
    if len(head) >= 12 and head[4:8] == b'ftyp':
        return True  # MP4 / M4A
    ct = ctype.lower()
    return ct.startswith('audio/') or ct in ('application/ogg', 'application/mp3', 'application/aac')


def probe(station, args):
    """检测单座电台，返回精简结果对象。"""
    stamp = int(time.time())
    url = str(station.get('url_resolved') or station.get('url') or '').strip()
    if not url.lower().startswith(('http://', 'https://')):
        return {'o': 0, 't': stamp, 'r': 'nourl'}

    current = url
    conn = None
    resp = None
    started = time.monotonic()
    result = None
    try:
        # 跟随跳转，最多 4 次
        for _ in range(5):
            parsed = urlparse(current)
            scheme = parsed.scheme.lower()
            if scheme not in ('http', 'https') or not parsed.hostname:
                return {'o': 0, 't': stamp, 'r': 'badurl'}
            host = parsed.hostname
            port = parsed.port or (443 if scheme == 'https' else 80)
            path = parsed.path or '/'
            if parsed.query:
                path += '?' + parsed.query

            if scheme == 'https':
                conn = http.client.HTTPSConnection(host, port, timeout=args.connect_timeout, context=SSL_CTX)
            else:
                conn = http.client.HTTPConnection(host, port, timeout=args.connect_timeout)
            conn.request('GET', path, headers={
                'User-Agent': USER_AGENT,
                'Accept': 'audio/*,*/*;q=0.8',
                'Range': 'bytes=0-'
            })
            resp = conn.getresponse()
            status = resp.status
            if status in REDIRECTS:
                location = resp.getheader('Location')
                resp.read()
                conn.close()
                conn = None
                resp = None
                if not location:
                    return {'o': 0, 't': stamp, 'r': 'redirect'}
                current = urljoin(current, location)
                continue
            break
        else:
            return {'o': 0, 't': stamp, 'r': 'redirect'}

        if status not in (200, 206):
            return {'o': 0, 't': stamp, 'c': status, 'r': 'http'}
        ctype = resp.getheader('Content-Type', '') or ''

        buf = bytearray()
        first_at = None
        last_at = None
        stalls = 0
        timed_out = False
        # 每次 read 前收紧 socket 超时，避免慢速滴流拖过总时限
        while True:
            now = time.monotonic()
            if now - started >= args.timeout:
                break
            if conn and conn.sock:
                try:
                    conn.sock.settimeout(min(args.connect_timeout, max(0.5, args.timeout - (now - started))))
                except OSError:
                    pass
            try:
                chunk = resp.read(CHUNK)
            except (socket.timeout, TimeoutError):
                timed_out = True
                break
            except (OSError, http.client.HTTPException, ssl.SSLError):
                return {'o': 0, 't': stamp, 'r': 'read'}
            now = time.monotonic()
            if not chunk:
                break
            if first_at is None:
                first_at = now
            elif last_at is not None and now - last_at > args.stall_seconds:
                stalls += 1
            last_at = now
            buf.extend(chunk)
            if len(buf) >= args.min_bytes and (now - first_at) >= args.sample_seconds:
                break

        head = bytes(buf[:64])
        if not looks_audio(head, ctype):
            code = 'ctype'
        elif first_at is None or len(buf) < args.min_bytes:
            code = 'timeout' if timed_out else 'short'
        elif (first_at - started) > args.first_byte_max:
            code = 'slowstart'
        elif stalls:
            code = 'stall'
        else:
            elapsed = max(last_at - first_at, 0.1)
            kbps = len(buf) * 8 / elapsed / 1000.0
            declared = float(station.get('bitrate') or 0)
            if kbps < args.min_kbps:
                code = 'slow'
            elif declared > 0 and kbps < declared * args.declared_ratio:
                code = 'slow'
            else:
                return {
                    'o': 1, 't': stamp, 'c': status,
                    'k': round(kbps), 'e': round(first_at - started, 1)
                }
        return {'o': 0, 't': stamp, 'c': status, 'r': code,
                'k': round(len(buf) * 8 / max((last_at or now) - (first_at or started), 0.1) / 1000.0)}
    except (socket.gaierror, ConnectionRefusedError, ConnectionResetError,
            socket.timeout, TimeoutError, ssl.SSLError, OSError,
            http.client.HTTPException, ValueError) as exc:
        if os.environ.get('AETHER_CHECK_DEBUG'):
            print('DEBUG', url, repr(exc), file=sys.stderr)
        reason = 'dns' if isinstance(exc, socket.gaierror) else (
            'ssl' if isinstance(exc, ssl.SSLError) else (
                'timeout' if isinstance(exc, (socket.timeout, TimeoutError)) else (
                    'refused' if isinstance(exc, ConnectionRefusedError) else 'error')))
        return {'o': 0, 't': stamp, 'r': reason}
    finally:
        try:
            if resp is not None:
                resp.close()
        except Exception:
            pass
        try:
            if conn is not None:
                conn.close()
        except Exception:
            pass


def load_json(path, fallback):
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return fallback


def save_results(results, meta, catalog_total):
    bad = [sid for sid, info in results.items() if not info.get('o')]
    atomic_write(HEALTH_FILE, {
        'meta': dict(meta, checked=len(results), ok=len(results) - len(bad),
                     bad=len(bad), catalog=catalog_total,
                     complete=len(results) >= catalog_total),
        'results': results
    })
    atomic_write(BAD_FILE, {
        'meta': {'generatedAt': meta.get('generatedAt'), 'checked': len(results),
                 'bad': len(bad), 'catalog': catalog_total},
        'bad': bad
    })


def main():
    ap = argparse.ArgumentParser(description='检测电台流可播放性与卡顿情况')
    ap.add_argument('--workers', type=int, default=120, help='并发数（默认 120）')
    ap.add_argument('--sample-seconds', type=float, default=2.5, help='有效数据采样秒数（默认 2.5）')
    ap.add_argument('--first-byte-max', type=float, default=8.0, help='首包最长等待秒数（默认 8）')
    ap.add_argument('--stall-seconds', type=float, default=1.5, help='数据间隔超过该秒数视为卡顿（默认 1.5）')
    ap.add_argument('--connect-timeout', type=float, default=6.0, help='单次连接/读取超时秒数（默认 6）')
    ap.add_argument('--timeout', type=float, default=16.0, help='单座电台总时限秒数（默认 16）')
    ap.add_argument('--min-bytes', type=int, default=4096, help='采样至少读取字节数（默认 4096）')
    ap.add_argument('--min-kbps', type=float, default=32, help='有效码率下限（默认 32）')
    ap.add_argument('--declared-ratio', type=float, default=0.35, help='有效码率/标称码率下限（默认 0.35）')
    ap.add_argument('--max-age-hours', type=float, default=24, help='结果有效期，期内跳过（默认 24）')
    ap.add_argument('--limit', type=int, default=0, help='本轮最多新检测多少座（0=全部）')
    ap.add_argument('--flush', type=int, default=500, help='每完成多少座落盘一次（默认 500）')
    ap.add_argument('--force', action='store_true', help='忽略有效期，全部重检')
    ap.add_argument('--quiet', action='store_true', help='不输出进度')
    args = ap.parse_args()

    # 进程级互斥：手动运行与 server.py 的定时调度不会互相叠加
    os.makedirs(DATA_DIR, exist_ok=True)
    lock_fh = open(LOCK_FILE, 'w', encoding='utf-8')
    try:
        fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('已有体检进程在运行，本次退出', file=sys.stderr)
        return 1

    catalog = load_json(CATALOG_FILE, None)
    if not catalog or not isinstance(catalog.get('stations'), list):
        print('读取 catalog.json 失败', file=sys.stderr)
        return 1
    stations = [s for s in catalog['stations'] if s.get('stationuuid')]
    total = len(stations)
    if not total:
        print('目录中没有带 stationuuid 的电台', file=sys.stderr)
        return 1

    health = load_json(HEALTH_FILE, {})
    results = health.get('results') if isinstance(health.get('results'), dict) else {}
    cutoff = time.time() - args.max_age_hours * 3600
    if args.force:
        results = {}
    fresh = set()
    for s in stations:
        info = results.get(s['stationuuid'])
        if isinstance(info, dict) and info.get('t', 0) >= cutoff:
            fresh.add(s['stationuuid'])
    pending = [s for s in stations if s['stationuuid'] not in fresh]
    if args.limit:
        pending = pending[:args.limit]

    meta = {
        'generatedAt': now_iso(),
        'version': 1,
        'sampleSeconds': args.sample_seconds,
        'stallSeconds': args.stall_seconds,
        'minKbps': args.min_kbps,
        'workers': args.workers
    }
    if not args.quiet:
        print('待检测 %d / %d 座（已有有效期结果 %d 座，并发 %d）'
              % (len(pending), total, len(fresh), args.workers), file=sys.stderr, flush=True)

    done = 0
    ok_count = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(probe, s, args): s['stationuuid'] for s in pending}
        for fut in as_completed(futures):
            sid = futures[fut]
            try:
                info = fut.result()
            except Exception as exc:
                if os.environ.get('AETHER_CHECK_DEBUG'):
                    print('DEBUG-FUTURE', repr(exc), file=sys.stderr, flush=True)
                info = {'o': 0, 't': int(time.time()), 'r': 'error'}
            results[sid] = info
            done += 1
            ok_count += 1 if info.get('o') else 0
            if done % args.flush == 0:
                save_results(results, meta, total)
                if not args.quiet:
                    print('进度 %d/%d，可播放 %d' % (done, len(pending), ok_count),
                          file=sys.stderr, flush=True)

    save_results(results, meta, total)
    if not args.quiet:
        bad = sum(1 for v in results.values() if not v.get('o'))
        print('完成：本次检测 %d 座，可播放 %d 座，累计标记失效 %d / %d 座'
              % (done, ok_count, bad, len(results)), file=sys.stderr, flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
