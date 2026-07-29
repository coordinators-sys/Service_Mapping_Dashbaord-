"""Vercel Python serverless function: GET /api/service-mapping

Returns clean, pre-matched, pre-validated service-mapping records as JSON.
The Kobo token is read from the environment on the server and never appears
in this response or anywhere the browser can see it.
"""

from __future__ import annotations

import base64
import gzip
import hmac
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


def _authorized(auth_header: str) -> bool:
    """Independent access check — TEMPORARY, EXPIRES 2026-08-12.

    `middleware.js` already gates every route, but this endpoint IS the
    exposure: it is the only thing that serves site names, Site IDs and
    coordinates. Edge middleware on a `framework: null` project is a platform
    behaviour rather than something this repo controls, so the data is gated
    here too. If the middleware ever stops applying, the payload must not
    quietly become public again.

    Accepts either the partner Basic credential, or the Bearer token Vercel
    sends on scheduled invocations (so the daily refresh keeps working — see
    the note in vercel.json). Fails CLOSED when nothing is configured.
    """
    user = os.environ.get("DASHBOARD_BASIC_AUTH_USER")
    password = os.environ.get("DASHBOARD_BASIC_AUTH_PASSWORD")
    cron_secret = os.environ.get("CRON_SECRET")
    if not user or not password:
        return False

    header = (auth_header or "").strip()

    if cron_secret and header.startswith("Bearer "):
        return hmac.compare_digest(header[7:], cron_secret)

    if not header.lower().startswith("basic "):
        return False
    try:
        decoded = base64.b64decode(header[6:].strip()).decode("utf-8")
    except Exception:
        return False
    got_user, _, got_password = decoded.partition(":")
    # Both comparisons always run: short-circuiting reveals whether the
    # username alone was right.
    user_ok = hmac.compare_digest(got_user, user)
    password_ok = hmac.compare_digest(got_password, password)
    return user_ok and password_ok


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if not _authorized(self.headers.get("Authorization", "")):
            body = json.dumps({
                "error": "unauthorized",
                "message": "Partner access required. Contact the CCCM Cluster Somalia coordination team.",
            }).encode("utf-8")
            self.send_response(401)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("WWW-Authenticate", 'Basic realm="CCCM Somalia Service Mapping — partner access"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

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
            # TEMPORARY (expires 2026-08-12): while the payload is partner-tier
            # it must never sit in a shared CDN cache, where it could be
            # replayed to a client that never authenticated. Public caching
            # returns with the aggregate artefact in PR #1.
            self.send_header("Cache-Control", "private, no-store")
        else:
            self.send_header("Cache-Control", "no-store")
        # The body varies by Accept-Encoding AND by credentials; without this a
        # shared cache may serve a gzip body to a client that never requested
        # one (observed: a plain fetch receiving undecodable bytes).
        self.send_header("Vary", "Accept-Encoding, Authorization")
        # CORS removed with the access gate: the payload is no longer public
        # read-only data, so it must not be readable cross-origin by any page.
        self.send_header("X-Content-Type-Options", "nosniff")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
