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
        # `?format=rows` returns the pre-columnar row shape. The dashboard never
        # asks for it; it exists so a script written against the old response
        # does not break silently, and so the encoding can be inspected by hand.
        want_rows = query.get("format", [""])[0].lower() == "rows"

        # json/gzip bytes are pre-encoded and cached alongside the payload —
        # gzip cuts the ~18MB record set by ~97% for low-bandwidth clients,
        # and caching the encoded bytes means repeat requests cost ~ms.
        try:
            if want_rows:
                from api.lib import columnar as _columnar
                from api.lib.build_payload import build_payload as _build
                payload = dict(_build(force_refresh=force_refresh))
                if isinstance(payload.get("records"), dict):
                    payload["records"] = _columnar.decode(payload["records"])
                    payload["encoding"] = "rows"
                json_body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                gzip_body = gzip.compress(json_body, compresslevel=6)
            else:
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
            # Public tier: cacheable again. The payload carries no site
            # identity, so a shared CDN copy exposes nothing a direct request
            # would not.
            self.send_header("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600")
        else:
            self.send_header("Cache-Control", "no-store")
        # The body varies by Accept-Encoding AND by credentials; without this a
        # shared cache may serve a gzip body to a client that never requested
        # one (observed: a plain fetch receiving undecodable bytes).
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Access-Control-Allow-Origin", "*")  # public read-only aggregate data
        self.send_header("X-Content-Type-Options", "nosniff")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
