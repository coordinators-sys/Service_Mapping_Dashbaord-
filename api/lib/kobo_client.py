"""Kobo API v2 client — server-side only. The token never leaves this
module: api/service-mapping.py calls iter_submissions() and returns cleaned
records to the browser, never the raw Kobo response or the token itself.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime

import httpx

from api.lib import settings

logger = logging.getLogger(__name__)

_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_MAX_RETRIES = 3
_PAGE_SIZE = 1000


class KoboAPIError(RuntimeError):
    pass


@dataclass
class KoboPage:
    results: list[dict]
    count: int
    has_more: bool


class KoboClient:
    def __init__(self):
        if not settings.KOBO_API_TOKEN:
            raise KoboAPIError("KOBO_API_TOKEN is not set")
        self._client = httpx.Client(
            base_url=settings.KOBO_BASE_URL,
            headers={"Authorization": f"Token {settings.KOBO_API_TOKEN}"},
            timeout=30.0,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "KoboClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        last_exc: Exception | None = None
        for attempt in range(1, _MAX_RETRIES + 1):
            try:
                response = self._client.request(method, url, **kwargs)
            except httpx.TransportError as exc:
                last_exc = exc
                logger.warning("Kobo transport error (attempt %s): %s", attempt, exc)
            else:
                if response.status_code not in _RETRYABLE_STATUS:
                    if response.status_code >= 400:
                        raise KoboAPIError(f"Kobo API returned {response.status_code}: {response.text[:300]}")
                    return response
                last_exc = KoboAPIError(f"Kobo API returned retryable status {response.status_code}")
            if attempt < _MAX_RETRIES:
                time.sleep(min(2**attempt, 10))
        raise KoboAPIError(f"Kobo API request failed after {_MAX_RETRIES} attempts") from last_exc

    def fetch_page(self, start: int, limit: int, since: datetime | None) -> KoboPage:
        url = f"/api/v2/assets/{settings.KOBO_ASSET_UID}/data/"
        params: dict = {"start": start, "limit": limit, "sort": json.dumps({"_submission_time": 1})}
        if since is not None:
            params["query"] = json.dumps({"_submission_time": {"$gt": since.isoformat()}})
        payload = self._request("GET", url, params=params).json()
        results = payload.get("results", [])
        count = payload.get("count", len(results))
        return KoboPage(results=results, count=count, has_more=start + len(results) < count)

    def iter_submissions(self, since: datetime | None = None) -> Iterator[dict]:
        start = 0
        while True:
            page = self.fetch_page(start=start, limit=_PAGE_SIZE, since=since)
            yield from page.results
            start += len(page.results)
            if not page.has_more or not page.results:
                break
            time.sleep(0.15)
