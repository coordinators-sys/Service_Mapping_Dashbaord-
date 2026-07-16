"""Data-quality checks operating on clean record dicts (the same shape
api/service-mapping.py returns to the browser) — no ORM/DB dependency.

`compute_record_quality_status` assigns one of critical/warning/info/passed
to a single record (surfaced as its `dataQualityStatus` field). `run_all_checks`
aggregates counts across the whole batch for the API summary.
"""

from __future__ import annotations

import datetime as dt

from api.lib.settings import STALE_SUBMISSION_DAYS

SOMALIA_BBOX = dict(min_lat=-2.0, max_lat=12.5, min_lon=40.5, max_lon=51.5)


def _in_somalia(lat: float | None, lon: float | None) -> bool:
    if lat is None or lon is None:
        return False
    return SOMALIA_BBOX["min_lat"] <= lat <= SOMALIA_BBOX["max_lat"] and SOMALIA_BBOX["min_lon"] <= lon <= SOMALIA_BBOX["max_lon"]


def compute_record_quality_status(record: dict, as_of: dt.date | None = None) -> str:
    """Single-record severity: critical > warning > info > passed."""
    as_of = as_of or dt.date.today()

    if record.get("matchStatus") in ("unmatched", "needs_review"):
        return "critical"

    lat, lon = record.get("latitude"), record.get("longitude")
    if lat is None or lon is None:
        return "warning"
    if not _in_somalia(lat, lon):
        return "critical"

    if record.get("coverageStatus") == "Unknown" and record.get("agency"):
        return "info"

    last_updated = record.get("lastUpdated")
    if last_updated:
        try:
            updated_date = dt.date.fromisoformat(str(last_updated)[:10])
            if (as_of - updated_date).days > STALE_SUBMISSION_DAYS:
                return "info"
        except ValueError:
            pass

    return "passed"


def run_all_checks(records: list[dict]) -> dict:
    """Aggregate data-quality counts across a batch of clean records."""
    counts = {"critical": 0, "warning": 0, "information": 0, "passed": 0}
    severity_key = {"critical": "critical", "warning": "warning", "info": "information", "passed": "passed"}

    unmatched = 0
    missing_coords = 0
    outside_somalia = 0
    stale = 0

    for record in records:
        status = record.get("dataQualityStatus") or compute_record_quality_status(record)
        counts[severity_key.get(status, "passed")] += 1

        if record.get("matchStatus") in ("unmatched", "needs_review"):
            unmatched += 1
        if record.get("latitude") is None or record.get("longitude") is None:
            missing_coords += 1
        elif not _in_somalia(record.get("latitude"), record.get("longitude")):
            outside_somalia += 1
        last_updated = record.get("lastUpdated")
        if last_updated:
            try:
                updated_date = dt.date.fromisoformat(str(last_updated)[:10])
                if (dt.date.today() - updated_date).days > STALE_SUBMISSION_DAYS:
                    stale += 1
            except ValueError:
                pass

    return {
        "severityCounts": counts,
        "unmatchedRecords": unmatched,
        "missingCoordinates": missing_coords,
        "coordinatesOutsideSomalia": outside_somalia,
        "staleRecords": stale,
    }


def sites_with_no_kobo_report(all_site_ids: set[str], reported_site_ids: set[str]) -> set[str]:
    return all_site_ids - reported_site_ids
