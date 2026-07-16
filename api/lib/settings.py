"""Lightweight environment-based configuration for the serverless API.

No framework/DB dependency — this is meant to run inside a stateless Vercel
Python function, so everything here is read straight from env vars with
sane local-dev defaults.
"""

from __future__ import annotations

import os


def _load_dotenv_file() -> None:
    """Minimal .env loader for local dev only. Vercel injects real env vars
    directly in production, so this never runs there — it just means running
    `python scripts/dev_server.py` locally picks up a project-root `.env`
    without needing python-dotenv as a runtime dependency.
    """
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".env")
    if not os.path.isfile(env_path):
        return
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


_load_dotenv_file()

KOBO_BASE_URL = os.environ.get("KOBO_BASE_URL", "https://kf.kobo.iom.int")
KOBO_ASSET_UID = os.environ.get("KOBO_ASSET_UID", "")
KOBO_API_TOKEN = os.environ.get("KOBO_API_TOKEN", "")
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "300"))
SITE_MATCH_DISTANCE_METERS = float(os.environ.get("SITE_MATCH_DISTANCE_METERS", "150"))
APP_ENV = os.environ.get("APP_ENV", "development")

# Optional secondary data source: IOM's ZiteManager service-provider contact
# registry (a different system from Kobo — see api/lib/zite_client.py).
ZITEMANAGER_REPORT_URL = os.environ.get("ZITEMANAGER_REPORT_URL", "")

SECTORS = (
    "CCCM",
    "General Protection",
    "Child Protection",
    "GBV",
    "HLP",
    "Food Security and Livelihoods",
    "Health",
    "Education",
    "Nutrition",
    "Shelter/NFI",
    "WASH",
)

PRIORITY_SECTORS = ("Health", "WASH", "General Protection", "Shelter/NFI")

PARTNER_TYPES = (
    "United Nations",
    "International NGO",
    "National NGO",
    "Government",
    "Local authority",
    "Other",
)

PRIORITY_WEIGHTS = {
    "service_gap": 0.35,
    "population": 0.20,
    "data_freshness": 0.15,
    "flood_risk": 0.15,
    "agency_capacity": 0.15,
}

STALE_SUBMISSION_DAYS = 180
