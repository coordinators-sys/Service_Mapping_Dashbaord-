"""Core payload builder shared by the Vercel serverless handler
(api/service-mapping.py) and the local dev server (scripts/dev_server.py) —
kept as a plain function so both can call it identically and it stays
directly unit-testable.
"""

from __future__ import annotations

import datetime as dt
import gzip
import json
import logging
import os
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from api.lib import settings
from api.lib.indicators import coverage_from_counts
from api.lib.kobo_client import KoboAPIError, KoboClient
from api.lib.site_matching import get_master_site_index
from api.lib.transformations import parse_submission
from api.lib.validation import compute_record_quality_status, run_all_checks
from api.lib.zite_client import ZiteManagerError, fetch_report
from api.lib.zite_transform import transform_zite_records

logger = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_MASTER_SITES_CSV = os.path.join(_PROJECT_ROOT, "data", "master-sites.csv")

_COVERAGE_LABEL = {"covered": "Yes", "not_covered": "No", "unknown": "Unknown"}

# Sentinel/placeholder values observed in the real agency_<sector> field —
# "nil" alone accounts for 1,385 of ~9,000 non-blank agency values in a real
# export, clearly meaning "no agency selected" rather than a real name.
_AGENCY_SENTINEL_VALUES = {"nil", "none", "n/a", "na", "no", "yes", "-", "nan", ""}

_cache: dict = {"payload": None, "built_at": 0.0}
_refresh_lock = threading.Lock()


def _normalize_agencies(records: list[dict]) -> None:
    """Mutates records in place: drops sentinel "agency" values (nil/none/
    yes/no/...) back to None, and collapses case-variant duplicates of the
    same real agency (e.g. 'nrc' vs 'NRC') to whichever casing appears most
    often — otherwise every KPI/chart that counts "active agencies" silently
    double-counts the same organization.
    """
    variants_by_key: dict[str, Counter] = {}
    for r in records:
        agency = r.get("agency")
        if not agency:
            continue
        key = agency.strip().lower()
        if key in _AGENCY_SENTINEL_VALUES:
            continue
        variants_by_key.setdefault(key, Counter())[agency.strip()] += 1

    canonical = {key: counter.most_common(1)[0][0] for key, counter in variants_by_key.items()}

    for r in records:
        agency = r.get("agency")
        if not agency:
            continue
        key = agency.strip().lower()
        r["agency"] = canonical.get(key)  # None for sentinel values


def _iso(value: dt.datetime | dt.date | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()


def _build_clean_records(raw_submissions: list[dict]) -> list[dict]:
    index = get_master_site_index(_MASTER_SITES_CSV)
    records: list[dict] = []

    for raw in raw_submissions:
        parsed = parse_submission(raw)
        match = index.match(
            parsed.site_id_raw, parsed.site_name_raw, parsed.latitude, parsed.longitude,
            district=parsed.district,
        )

        for row in parsed.rows:
            record = {
                "submissionUuid": parsed.submission_uuid,
                "reportingDate": _iso(parsed.submission_time),
                "reportingPeriod": parsed.reporting_period,
                "region": (match.site.region if match.site else parsed.region) or "",
                "district": (match.site.district if match.site else parsed.district) or "",
                "catchment": match.site.catchment if match.site else None,
                "siteCodeRaw": parsed.site_id_raw,
                "siteNameRaw": parsed.site_name_raw,
                "matchedSiteCode": match.site.cccm_site_id if match.site else None,
                "matchedSiteName": match.site.site_name if match.site else None,
                "matchStatus": match.match_status,
                "matchDistanceMeters": match.match_distance_meters,
                "latitude": match.site.latitude if match.site else parsed.latitude,
                "longitude": match.site.longitude if match.site else parsed.longitude,
                "agency": row.agency,
                "partnerType": None,  # not captured by the real form — agency-to-partner-type mapping needs a lookup table
                "sector": row.sector,
                "service": None,  # the real form has no per-service breakdown, only per-sector
                "activity": row.activity,
                "coverageStatus": _COVERAGE_LABEL.get(row.coverage_status, "Unknown"),
                "operationalStatus": None,
                "lastUpdated": _iso(parsed.submission_time),
                "dataQualityStatus": None,  # filled below
                "dataSource": "kobo",
            }
            record["dataQualityStatus"] = compute_record_quality_status(record)
            records.append(record)

    return records


def _mask_sensitive_sectors(records: list[dict]) -> None:
    """Strip provider identity from sensitive sectors in the PUBLIC payload.

    Coverage status (Yes/No/Unknown) is retained so sector statistics remain
    correct; only WHO provides the service (agency, activity detail) is
    masked. Applied server-side deliberately — client-side masking would
    still ship the names in the JSON. Configured via MASK_SENSITIVE_SECTORS
    (default: GBV) pending a formal CCCM data-protection decision.
    """
    if not settings.MASK_SENSITIVE_SECTORS:
        return
    sensitive = set(settings.MASK_SENSITIVE_SECTORS)
    for r in records:
        if r.get("sector") in sensitive:
            if r.get("agency"):
                r["agency"] = "Provider present (masked)"
            if r.get("activity"):
                r["activity"] = None


def _fetch_zite_records() -> list[dict]:
    """Best-effort: a ZiteManager outage should never take down the whole
    dashboard — Kobo data still renders if this fails."""
    if not settings.ZITEMANAGER_REPORT_URL:
        return []
    try:
        raw = fetch_report()
    except ZiteManagerError:
        logger.exception("ZiteManager fetch failed — continuing with Kobo data only")
        return []
    records = transform_zite_records(raw)
    for record in records:
        record["dataQualityStatus"] = compute_record_quality_status(record)
    return records


def _master_sites_summary() -> dict:
    """Master-list denominators for the reporting-completeness section.

    NOTE on methodology: this is the FULL master list, not a per-round
    "expected to report" cohort — no reporting-round scope configuration
    exists yet, so the frontend labels the rate as "share of master-list
    sites reported" rather than claiming an expected-reporting rate.
    """
    index = get_master_site_index(_MASTER_SITES_CSV)
    by_district: dict[str, int] = {}
    for site in index.sites:
        d = site.district or "—"
        by_district[d] = by_district.get(d, 0) + 1
    return {"total": len(index.sites), "byDistrict": by_district}


def _summarize(records: list[dict]) -> dict:
    assessed_sites = {r["matchedSiteCode"] or r["siteCodeRaw"] for r in records if r.get("matchedSiteCode") or r.get("siteCodeRaw")}
    active_agencies = {r["agency"] for r in records if r.get("agency") and r.get("coverageStatus") == "Yes"}
    regions = {r["region"] for r in records if r.get("region")}
    districts = {r["district"] for r in records if r.get("district")}

    sector_coverage = {}
    for sector in settings.SECTORS:
        sector_rows = [r for r in records if r.get("sector") == sector]
        covered = sum(1 for r in sector_rows if r["coverageStatus"] == "Yes")
        not_covered = sum(1 for r in sector_rows if r["coverageStatus"] == "No")
        unknown = sum(1 for r in sector_rows if r["coverageStatus"] == "Unknown")
        result = coverage_from_counts(covered, not_covered, unknown)
        sector_coverage[sector] = {
            "covered": result.covered,
            "notCovered": result.not_covered,
            "unknown": result.unknown,
            "reportableTotal": result.reportable_total,
            "coveragePct": round(result.coverage_pct, 1) if result.coverage_pct is not None else None,
        }

    quality = run_all_checks(records)

    return {
        "assessedSites": len(assessed_sites),
        "activeAgencies": len(active_agencies),
        "regionsCovered": len(regions),
        "districtsCovered": len(districts),
        "sectorCoverage": sector_coverage,
        "dataQuality": quality,
        "totalRecords": len(records),
    }


def _fetch_kobo_raw() -> list[dict]:
    with KoboClient() as client:
        return list(client.iter_submissions())


def _build_fresh_payload() -> dict:
    if not settings.KOBO_API_TOKEN or not settings.KOBO_ASSET_UID:
        return {
            "records": [],
            "summary": _summarize([]),
            "generatedAt": dt.datetime.utcnow().isoformat() + "Z",
            "source": "no-kobo-credentials",
        }

    try:
        # Kobo and ZiteManager are independent systems — fetch them in
        # parallel instead of sequentially (saves the full latency of the
        # slower source on every cold build).
        with ThreadPoolExecutor(max_workers=2) as pool:
            kobo_future = pool.submit(_fetch_kobo_raw)
            zite_future = pool.submit(_fetch_zite_records)
            raw_submissions = kobo_future.result()
            zite_records = zite_future.result()

        records = _build_clean_records(raw_submissions)
        records += zite_records
        _normalize_agencies(records)  # across BOTH sources, so the same org isn't double-counted
        _mask_sensitive_sectors(records)  # AFTER normalization so masking can't be undone by it
        sources_used = sorted({r["dataSource"] for r in records}) or ["kobo"]
        return {
            "records": records,
            "summary": _summarize(records),
            "masterSites": _master_sites_summary(),
            "generatedAt": dt.datetime.utcnow().isoformat() + "Z",
            "source": "+".join(sources_used),
        }
    except KoboAPIError as exc:
        return {
            "records": [],
            "summary": _summarize([]),
            "masterSites": _master_sites_summary(),
            "generatedAt": dt.datetime.utcnow().isoformat() + "Z",
            "source": "error",
            "error": str(exc),
        }


def _refresh_cache_async() -> None:
    """Background refresh so the request that noticed the cache expired
    doesn't have to wait for it. The lock keeps concurrent requests from
    stampeding Kobo with duplicate rebuilds."""
    if not _refresh_lock.acquire(blocking=False):
        return  # a refresh is already running
    def _run():
        try:
            payload = _build_fresh_payload()
            _cache.update(payload=payload, built_at=time.time())
        except Exception:
            logger.exception("Background payload refresh failed")
        finally:
            _refresh_lock.release()
    threading.Thread(target=_run, daemon=True).start()


def build_payload(force_refresh: bool = False) -> dict:
    """Returns {"records": [...], "summary": {...}, "generatedAt": iso, "source": str}.

    Stale-while-revalidate: a fresh cache is returned as-is; an EXPIRED cache
    is still returned immediately (users never wait ~10s for a live Kobo
    pull) while a background thread rebuilds it. Only the very first request
    of a cold process — or an explicit ?refresh=true — pays the full build.
    """
    now = time.time()
    cached = _cache["payload"]
    is_fresh = cached is not None and (now - _cache["built_at"]) < settings.CACHE_TTL_SECONDS

    if force_refresh:
        payload = _build_fresh_payload()
        _cache.update(payload=payload, built_at=time.time())
        return payload

    if cached is not None:
        if not is_fresh:
            _refresh_cache_async()  # serve stale now, refresh behind the scenes
        return cached

    payload = _build_fresh_payload()
    _cache.update(payload=payload, built_at=time.time())
    return payload


# Serialization + gzip of the ~18MB payload costs ~0.7s per request — cache
# the encoded bytes alongside the payload, keyed by generatedAt, so cached
# responses are served in milliseconds.
_encoded_cache: dict = {"generatedAt": None, "json": None, "gzip": None}
_encode_lock = threading.Lock()


def get_payload_encoded(force_refresh: bool = False) -> tuple[bytes, bytes]:
    """Returns (json_bytes, gzip_bytes) for the current payload."""
    payload = build_payload(force_refresh=force_refresh)
    generated_at = payload.get("generatedAt")
    with _encode_lock:
        if _encoded_cache["generatedAt"] != generated_at:
            body = json.dumps(payload).encode("utf-8")
            _encoded_cache.update(generatedAt=generated_at, json=body, gzip=gzip.compress(body, compresslevel=6))
        return _encoded_cache["json"], _encoded_cache["gzip"]
