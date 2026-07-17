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


def _env(name: str, default: str = "") -> str:
    """Env read hardened against copy/paste artifacts from hosting UIs
    (e.g. Vercel's env-var form): surrounding whitespace/quotes, and
    multi-line values (double-pasted lines put a literal '\\n' INSIDE the
    stored value, which strip() alone can't fix — that made httpx reject
    KOBO_BASE_URL with InvalidURL in production). Every config value this
    app uses is single-line by nature, so taking the first non-empty line
    is always correct here."""
    raw = os.environ.get(name, default)
    for line in raw.splitlines():
        line = line.strip().strip('"').strip("'")
        if line:
            return line
    return ""


KOBO_BASE_URL = _env("KOBO_BASE_URL", "https://kf.kobo.iom.int")
KOBO_ASSET_UID = _env("KOBO_ASSET_UID")
KOBO_API_TOKEN = _env("KOBO_API_TOKEN")
CACHE_TTL_SECONDS = int(_env("CACHE_TTL_SECONDS", "300"))
SITE_MATCH_DISTANCE_METERS = float(_env("SITE_MATCH_DISTANCE_METERS", "150"))
APP_ENV = _env("APP_ENV", "development")

# Optional secondary data source: IOM's ZiteManager service-provider contact
# registry (a different system from Kobo — see api/lib/zite_client.py).
ZITEMANAGER_REPORT_URL = _env("ZITEMANAGER_REPORT_URL")

# Protection safeguard: sectors whose provider identity is masked in the
# PUBLIC payload (agency + activity replaced; coverage Yes/No/Unknown kept so
# aggregate statistics still work). Conservative default is GBV — naming the
# GBV provider at an exact site location on a public dashboard is a
# protection risk. CCCM coordination can widen ("GBV,Child Protection"),
# or disable entirely (MASK_SENSITIVE_SECTORS="") once a policy is agreed.
MASK_SENSITIVE_SECTORS = tuple(
    s.strip() for s in _env("MASK_SENSITIVE_SECTORS", "GBV").split(",") if s.strip()
)

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
