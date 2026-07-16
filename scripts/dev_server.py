"""Local development server — mimics Vercel's routing (static files + the
/api/service-mapping Python function) without requiring the Vercel CLI.

Usage: python scripts/dev_server.py [port]
"""

from __future__ import annotations

import gzip
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)

from api.lib.build_payload import get_payload_encoded  # noqa: E402

_MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript",
    ".json": "application/json", ".geojson": "application/json", ".png": "image/png",
    ".csv": "text/csv", ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/service-mapping":
            query = parse_qs(urlparse(self.path).query)
            force_refresh = query.get("refresh", ["false"])[0].lower() == "true"
            json_body, gzip_body = get_payload_encoded(force_refresh=force_refresh)
            use_gzip = "gzip" in self.headers.get("Accept-Encoding", "")
            body = gzip_body if use_gzip else json_body
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            if use_gzip:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/":
            path = "/index.html"
        file_path = os.path.normpath(os.path.join(_PROJECT_ROOT, path.lstrip("/")))
        if not file_path.startswith(_PROJECT_ROOT) or not os.path.isfile(file_path):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        ext = os.path.splitext(file_path)[1]
        with open(file_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", _MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # keep stdout clean; errors still raise


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Dev server running at http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
