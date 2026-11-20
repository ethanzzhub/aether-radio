#!/usr/bin/env python3
"""AETHER 本地服务：静态站点 + 共享状态存储。

只监听 127.0.0.1，供本机所有浏览器共用同一份收藏与设置：
    GET  /api/state   -> 读取 .data/state.json（不存在则返回 {}）
    PUT  /api/state   -> 整体写入（先写临时文件再原子替换）

其余路径按普通静态文件从项目根目录读取。
"""
import json
import os
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


def main():
    port = int(os.environ.get('AETHER_PORT', '8765'))
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('AETHER serving %s\nhttp://127.0.0.1:%d' % (ROOT, port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
