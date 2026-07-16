"""Client for IOM's ZiteManager service-provider contact registry — a
secondary data source distinct from Kobo. Returns raw records exactly as the
API gives them; PII stripping and clean-record shaping happens in
zite_transform.py, never here.

The report URL (which embeds an access key) is read from the environment
only — see settings.ZITEMANAGER_REPORT_URL — and is never hardcoded.
"""

from __future__ import annotations

import httpx

from api.lib import settings


class ZiteManagerError(RuntimeError):
    pass


def fetch_report() -> list[dict]:
    if not settings.ZITEMANAGER_REPORT_URL:
        raise ZiteManagerError("ZITEMANAGER_REPORT_URL is not set")
    try:
        response = httpx.get(settings.ZITEMANAGER_REPORT_URL, timeout=60.0)
    except httpx.TransportError as exc:
        raise ZiteManagerError(f"ZiteManager request failed: {exc}") from exc

    if response.status_code >= 400:
        raise ZiteManagerError(f"ZiteManager returned {response.status_code}")

    data = response.json()
    if not isinstance(data, list):
        raise ZiteManagerError("Unexpected ZiteManager response shape (expected a JSON list)")
    return data
