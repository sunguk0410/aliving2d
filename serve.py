"""Local static server for Capsule Model Studio (npm start).

Serves the editor and the player demos from this folder to this PC only:
requests must come from localhost with a matching Host/Origin, dot-files and
Python/batch sources are never served, and only GET/HEAD are allowed.
"""
import argparse
import mimetypes
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = str(Path(__file__).resolve().parent)

for ext, mime in {'.wasm': 'application/wasm', '.data': 'application/octet-stream',
                  '.binarypb': 'application/octet-stream', '.psd': 'application/octet-stream',
                  '.ipynb': 'application/x-ipynb+json', '.json': 'application/json',
                  '.md': 'text/markdown; charset=utf-8', '.js': 'text/javascript'}.items():
    mimetypes.add_type(mime, ext)


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def same_origin(self):
        host = self.headers.get('Host', '')
        allowed = {f'{name}:{self.server.server_port}' for name in ('localhost', '127.0.0.1', '[::1]')}
        origin = self.headers.get('Origin')
        if host not in allowed or (origin and origin != 'http://' + host):
            self.send_error(403, 'Local same-origin requests only')
            return False
        return True

    def hidden_path(self):
        path = unquote(urlsplit(self.path).path).replace('\\', '/')
        parts = path.split('/')
        return any(p.startswith('.') and p not in ('', '.') for p in parts) or \
            path.lower().rstrip('/').endswith(('.py', '.pyc', '.bat'))

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def do_GET(self):
        if not self.same_origin():
            return
        if self.hidden_path():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.same_origin():
            return
        if self.hidden_path():
            self.send_error(404)
            return
        super().do_HEAD()

    def _not_allowed(self):
        # Drain a small body first: answering before reading it makes Windows reset the connection.
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            size = 0
        if 0 < size <= 1 << 20:
            self.rfile.read(size)
        self.close_connection = True
        self.send_error(405)

    do_POST = do_PUT = do_DELETE = do_PATCH = _not_allowed


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--open-browser', action='store_true')
    parser.add_argument('--camera', action='store_true', help='open the editor with the camera on (?cam=1)')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError as error:
        parser.exit(1, f'Cannot start local server on port {args.port}: {error}\nUse --port to select another port.\n')
    url = f'http://127.0.0.1:{args.port}/'
    print('Capsule Model Studio: ' + url)
    print('Player demos: ' + url + 'engine/demo/')
    if args.open_browser:
        webbrowser.open(url + ('?cam=1' if args.camera else ''))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
