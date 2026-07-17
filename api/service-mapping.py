"""Vercel Python serverless function: GET /api/service-mapping

Returns clean, pre-matched, pre-validated service-mapping records as JSON.
The Kobo token is read from the environment on the server and never appears
in this response or anywhere the browser can see it.
"""

from __future__ import annotations

import gzip
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from api.lib.build_payload import get_payload_encoded  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        force_refresh = query.get("refresh", ["false"])[0].lower() == "true"

        # json/gzip bytes are pre-encoded and cached alongside the payload —
        # gzip cuts the ~18MB record set by ~97% for low-bandwidth clients,
        # and caching the encoded bytes means repeat requests cost ~ms.
        try:
            json_body, gzip_body = get_payload_encoded(force_refresh=force_refresh)
            status = 200
        except Exception as exc:  # last-resort guard — never leak the traceback or the token to the CLIENT
            # ...but DO print it to stderr, which Vercel captures in Logs — otherwise
            # a real server-side crash is invisible and unfixable from the outside.
            print(f"[service-mapping] request failed: {exc!r}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            json_body = json.dumps({"error": "internal_error", "message": "Failed to build service-mapping payload."}).encode("utf-8")
            gzip_body = gzip.compress(json_body)
            status = 500

        use_gzip = "gzip" in self.headers.get("Accept-Encoding", "")
        body = gzip_body if use_gzip else json_body

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        # Only cache SUCCESS. A cached 500 (s-maxage) kept serving the old
        # crash from the CDN for 5 minutes after each fix was deployed.
        if status == 200:
            self.send_header("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600")
        else:
            self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
