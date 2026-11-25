#!/usr/bin/env python3
"""AETHER 本地服务：静态站点 + 共享状态存储 + 频道体检调度。

只监听回环地址（IPv4 127.0.0.1 与 IPv6 ::1 各起一份），供本机所有浏览器
共用同一份收藏与设置：
    GET  /api/state   -> 读取 .data/state.json（不存在则返回 {}）
    PUT  /api/state   -> 整体写入（先写临时文件再原子替换）

同时监听 IPv6 是因为新版浏览器把 localhost 优先解析为 ::1，只绑 IPv4 会让
http://localhost:8765 直接被拒。

其余路径按普通静态文件从项目根目录读取。后台线程每天凌晨定时运行
scripts/check_streams.py，把不可播放/卡顿的电台从页面上隐藏。
"""
import datetime
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, '.data')
STATE_FILE = os.path.join(DATA_DIR, 'state.json')
STATE_PATH = '/api/state'
MAX_BODY = 2 * 1024 * 1024  # 状态文件不会很大，超过 2MB 视为异常
LOCK = threading.Lock()

CHECK_SCRIPT = os.path.join(ROOT, 'scripts', 'check_streams.py')
CHECK_RESULT = os.path.join(ROOT, 'data', 'stream-bad.json')
CHECK_LOG_DIR = os.path.join(ROOT, '.logs')
CHECK_LOCK = threading.Lock()

# AETHER_HEALTH_AUTORUN=0 可关闭自动体检
# AETHER_HEALTH_HOUR / AETHER_HEALTH_MINUTE 指定每天体检的本地时间，默认 03:00
HEALTH_AUTORUN = os.environ.get('AETHER_HEALTH_AUTORUN', '1') != '0'
HEALTH_INITIAL_DELAY = float(os.environ.get('AETHER_HEALTH_INITIAL_DELAY', '90'))
HEALTH_WORKERS = os.environ.get('AETHER_HEALTH_WORKERS', '120')


def _env_int(name, default, lo, hi):
    try:
        return min(hi, max(lo, int(os.environ.get(name, default))))
    except ValueError:
        return default


HEALTH_HOUR = _env_int('AETHER_HEALTH_HOUR', 3, 0, 23)
HEALTH_MINUTE = _env_int('AETHER_HEALTH_MINUTE', 0, 0, 59)


def health_result_age():
    """返回体检结果距今的秒数；文件不存在返回 None。"""
    try:
        return time.time() - os.path.getmtime(CHECK_RESULT)
    except OSError:
        return None


def run_health_check():
    """串行执行一次体检，日志追加到 .logs/stream-check.log。"""
    if not CHECK_LOCK.acquire(blocking=False):
        print('频道体检已在运行，跳过本次调度', flush=True)
        return
    try:
        os.makedirs(CHECK_LOG_DIR, exist_ok=True)
        log_path = os.path.join(CHECK_LOG_DIR, 'stream-check.log')
        cmd = [sys.executable, CHECK_SCRIPT, '--workers', HEALTH_WORKERS]
        print('频道体检开始：%s' % time.strftime('%Y-%m-%d %H:%M:%S'), flush=True)
        with open(log_path, 'a', encoding='utf-8') as log:
            log.write('\n===== %s =====\n' % time.strftime('%Y-%m-%d %H:%M:%S'))
            log.flush()
            subprocess.run(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=False)
        print('频道体检结束：%s' % time.strftime('%Y-%m-%d %H:%M:%S'), flush=True)
    except OSError as exc:
        print('频道体检启动失败：%s' % exc, flush=True)
    finally:
        CHECK_LOCK.release()


def seconds_until_daily(now=None):
    """距离下一次本地体检时刻（默认每天 03:00）的秒数。"""
    now = now or datetime.datetime.now()
    target = now.replace(hour=HEALTH_HOUR, minute=HEALTH_MINUTE,
                         second=0, microsecond=0)
    if target <= now:
        target += datetime.timedelta(days=1)
    return (target - now).total_seconds()


def health_scheduler(stop):
    """每天凌晨固定时刻体检一次；仅在从未体检过时于启动后补跑一次。"""
    if health_result_age() is None:
        if stop.wait(HEALTH_INITIAL_DELAY):
            return
        run_health_check()
    while not stop.wait(seconds_until_daily()):
        run_health_check()


def read_state():
    try:
        with open(STATE_FILE, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(payload):
    """先写 .tmp 再 os.replace，避免进程中途退出留下半截 JSON。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = STATE_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, STATE_FILE)


class Handler(SimpleHTTPRequestHandler):
    server_version = 'AetherLocal/1.0'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---------- 响应工具 ----------
    def end_headers(self):
        # 本地开发用：避免浏览器缓存旧文件，改完刷新即生效
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_json(self, code, obj, with_body=True):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if with_body:
            self.wfile.write(body)

    def route(self):
        return self.path.split('?', 1)[0]

    # ---------- 路由 ----------
    def do_GET(self):
        if self.route() == STATE_PATH:
            with LOCK:
                self.send_json(HTTPStatus.OK, read_state())
            return
        super().do_GET()

    def do_HEAD(self):
        if self.route() == STATE_PATH:
            with LOCK:
                self.send_json(HTTPStatus.OK, read_state(), with_body=False)
            return
        super().do_HEAD()

    def do_PUT(self):
        if self.route() != STATE_PATH:
            self.send_json(HTTPStatus.NOT_FOUND, {'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'invalid content-length'})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'invalid json'})
            return
        if not isinstance(payload, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'object expected'})
            return

        payload['updatedAt'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        try:
            with LOCK:
                write_state(payload)
        except OSError as exc:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {'error': str(exc)})
            return
        self.send_json(HTTPStatus.OK, {'ok': True, 'updatedAt': payload['updatedAt']})

    do_POST = do_PUT

    # ---------- 日志：只在 API 出错时留痕 ----------
    def log_message(self, fmt, *args):
        if self.route().startswith('/api/'):
            super().log_message(fmt, *args)


class V6HTTPServer(ThreadingHTTPServer):
    """IPv6 回环服务：与 IPv4 版共用同一端口的不同协议族。"""
    address_family = socket.AF_INET6
    daemon_threads = True


def main():
    port = int(os.environ.get('AETHER_PORT', '8765'))
    host = os.environ.get('AETHER_HOST', '127.0.0.1')

    servers = []
    v4 = ThreadingHTTPServer((host, port), Handler)
    v4.daemon_threads = True
    servers.append(v4)

    v6 = None
    try:
        v6 = V6HTTPServer(('::1', port), Handler)
        servers.append(v6)
    except OSError as exc:
        print('IPv6 回环未启用（%s），仅 IPv4 可用' % exc, flush=True)

    print('AETHER serving %s' % ROOT, flush=True)
    print('  http://127.0.0.1:%d  (IPv4)' % port, flush=True)
    if v6 is not None:
        print('  http://localhost:%d    (IPv6 ::1 已就绪)' % port, flush=True)

    for extra in servers[1:]:
        threading.Thread(target=extra.serve_forever, daemon=True,
                         name='aether-v6').start()

    stop_health = threading.Event()
    if HEALTH_AUTORUN:
        threading.Thread(target=health_scheduler, args=(stop_health,), daemon=True,
                         name='aether-health').start()
        print('频道体检调度已启动（每天 %02d:%02d，日志 .logs/stream-check.log）'
              % (HEALTH_HOUR, HEALTH_MINUTE), flush=True)

    try:
        v4.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_health.set()
        for s in servers:
            s.server_close()


if __name__ == '__main__':
    main()
