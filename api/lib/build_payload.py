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
import re
import threading
import time
from collections import Counter
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor

from api.lib import settings
from api.lib.indicators import coverage_from_counts
from api.lib.kobo_client import KoboAPIError, KoboClient
from api.lib.site_matching import get_master_site_index
from api.lib.field_classification import assert_publishable, scrub_free_text
from api.lib.publication import REASON_CODES, classify, evaluate, explain
from api.lib.transformations import parse_submission
from api.lib.validation import compute_record_quality_status, run_all_checks
from api.lib.zite_client import ZiteManagerError, fetch_report
from api.lib.zite_transform import transform_zite_records

logger = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_MASTER_SITES_CSV = os.path.join(_PROJECT_ROOT, "data", "master-sites.csv")

# Temporary CCCM Site ID (…-T####) = site pending Site ID Generator registration.
_TEMP_ID_RE = re.compile(r"-T\d+$", re.IGNORECASE)

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


@lru_cache(maxsize=1)
def _reconciliation_register() -> dict:
    """raw site reference -> its row in data/site-reconciliation.json.

    The register is the audit trail for site references that carry no approved
    master-site ID. Unresolved rows attach an owner and a status to the record
    so the exception is assigned to somebody rather than merely displayed;
    resolved rows carry an approved official ID and are applied as aliases.
    """
    path = os.path.join(_PROJECT_ROOT, "data", "site-reconciliation.json")
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return {
        str(e.get("raw_site_reference", "")).strip().upper(): e
        for e in data.get("entries", [])
        if e.get("raw_site_reference")
    }


def _resolve_catchment(raw_value, district):
    """Match a submitted catchment against the district-qualified catchment
    labels the dashboard uses ("Baidoa · CA12"). Exact code match WITHIN the
    declared district only - never a fuzzy guess across districts, because CA
    codes repeat (CA01 exists in Baidoa, Kismaayo and Daynile).
    """
    if not raw_value or not district:
        return None
    index = get_master_site_index(_MASTER_SITES_CSV)
    # Kobo submits the catchment as districtPcode+code ("SO2401CA12"); the
    # dashboard labels are district-qualified ("Baidoa · CA12"). Strip the
    # p-code prefix so the two forms can be compared.
    want_code = re.sub(r"^SO\d{4,6}", "", str(raw_value).strip(), flags=re.IGNORECASE).upper()
    if not want_code:
        return None
    want_district = str(district).strip().lower()
    for site in index.sites:
        if not site.catchment:
            continue
        if (site.district or "").strip().lower() != want_district:
            continue
        label = site.catchment.split("·")[-1].strip().upper()
        if label == want_code or label.split("_")[0] == want_code:
            return site.catchment
    return None


def _version_sort_key(raw):
    return (str(raw.get("_submission_time") or ""),
            str(raw.get("__version__") or ""),
            raw.get("_id") or 0)


def _superseded_uuids(raw_submissions):
    """UUIDs of non-current versions.

    Logical key = meta/rootUuid when present, else _uuid. The newest version
    wins; older ones are marked superseded and RETAINED (never deleted) so the
    audit trail survives. Re-importing the same payload is idempotent.
    """
    by_key = {}
    for raw in raw_submissions:
        key = raw.get("meta/rootUuid") or raw.get("_uuid") or raw.get("meta/instanceID")
        if not key:
            continue
        cur = by_key.get(key)
        if cur is None or _version_sort_key(raw) > _version_sort_key(cur):
            by_key[key] = raw
    winners = set(id(r) for r in by_key.values())
    return set(str(r.get("_uuid")) for r in raw_submissions
               if id(r) not in winners and r.get("_uuid"))

def _build_clean_records(raw_submissions: list[dict]) -> list[dict]:
    index = get_master_site_index(_MASTER_SITES_CSV)
    records: list[dict] = []
    superseded = _superseded_uuids(raw_submissions)

    for raw in raw_submissions:
        parsed = parse_submission(raw)
        match = index.match(
            parsed.site_id_raw, parsed.site_name_raw, parsed.latitude, parsed.longitude,
            district=parsed.district,
        )
        # Catchment/district-level submissions never ask for a site (the form
        # only shows site_name at site level), so "no site reference" is the
        # DESIGNED outcome there — label it an area-level report rather than a
        # failed site match. Only genuine site-level blanks stay "unmatched".
        match_status = match.match_status
        if (
            match_status == "unmatched"
            and not parsed.site_id_raw
            and not parsed.site_name_raw
            and parsed.reporting_level in ("catchment", "district")
        ):
            match_status = "area_level_report"

        # --- geographic grain -------------------------------------------------
        # Publish at the grain the partner DECLARED. Identifiers that are not
        # relevant to that grain stay null; none are ever invented.
        scope_type = parsed.reporting_level
        site_reference = parsed.site_id_raw or parsed.site_name_raw
        # Catchment comes from the SOURCE first. Reading it only from a matched
        # site is what silently dropped CA12 from Baidoa 34224509, because a
        # catchment-level assessment has no site to read it from.
        catchment_raw = parsed.catchment_raw
        catchment_resolved = None
        if scope_type == "site" and match.site:
            catchment_resolved = match.site.catchment
        elif catchment_raw:
            catchment_resolved = _resolve_catchment(catchment_raw, parsed.district)
        published_catchment = catchment_resolved or catchment_raw

        # --- validation and terminal state ------------------------------------
        reason_codes = evaluate(
            scope_type=scope_type,
            scope_inferred=parsed.reporting_level_inferred,
            district=parsed.district,
            district_resolved=parsed.district_resolved,
            catchment_raw=catchment_raw,
            catchment_resolved=bool(catchment_resolved),
            site_reference=site_reference,
            site_matched=bool(match.site),
            has_logical_key=bool(parsed.source_root_uuid or parsed.submission_uuid),
        )
        publication_status, severity = classify(reason_codes)
        if parsed.submission_uuid in superseded:
            publication_status, severity = "superseded", "low"
            reason_codes = list(reason_codes) + ["SUPERSEDED_VERSION"]

        reconciliation = None
        if "UNMATCHED_MASTER_SITE" in reason_codes and parsed.site_id_raw:
            reconciliation = _reconciliation_register().get(str(parsed.site_id_raw).strip().upper())

        for row in parsed.rows:
            record = {
                "submissionUuid": parsed.submission_uuid,
                "reportingDate": _iso(parsed.submission_time),
                "reportingPeriod": parsed.reporting_period,
                "region": (match.site.region if match.site else parsed.region) or "",
                "district": (match.site.district if match.site else parsed.district) or "",
                "catchment": published_catchment,
                "catchmentRaw": catchment_raw,
                # --- declared grain, organisation roles, lineage, state ---
                "scopeType": scope_type,
                "reportingLevelRaw": parsed.reporting_level_raw,
                "reportingPartner": parsed.reporting_partner,
                "sourceId": parsed.source_id,
                "sourceRootUuid": parsed.source_root_uuid,
                "sourceVersion": parsed.source_version,
                "districtRaw": parsed.district_pcode,
                "regionRaw": parsed.region_pcode,
                "publicationStatus": publication_status,
                "qualitySeverity": severity,
                "reasonCodes": reason_codes,
                "siteCodeRaw": parsed.site_id_raw,
                "siteNameRaw": parsed.site_name_raw,
                "matchedSiteCode": match.site.cccm_site_id if match.site else None,
                "matchedSiteName": match.site.site_name if match.site else None,
                "matchStatus": match_status,
                # Ownership of an unmatched site reference. Present only when
                # the reference is genuinely unresolved, so a row in the data
                # quality view always names who has to act on it.
                "reconciliationStatus": reconciliation.get("status") if reconciliation else None,
                "reconciliationOwner": reconciliation.get("owner") if reconciliation else None,
                "reconciliationNote": reconciliation.get("resolution_note") if reconciliation else None,
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
    pending = 0
    for site in index.sites:
        d = site.district or "—"
        by_district[d] = by_district.get(d, 0) + 1
        # A temporary id (…-T####) marks a site the Site ID Generator has not
        # registered yet ("TEMPORARY - pending Site ID Generator registration").
        # Verified against the master list: the T-code pattern and that record
        # status select exactly the same 2,688 sites, so either is authoritative.
        if _TEMP_ID_RE.search(site.cccm_site_id or ""):
            pending += 1
    total = len(index.sites)
    return {
        "total": total,
        "approved": total - pending,
        "pendingRegistration": pending,
        "byDistrict": by_district,
    }


# Match methods that constitute a TRUSTED tie to the master list. A probable
# name match is explicitly NOT one: it is a candidate awaiting review.
_TRUSTED_MATCH = {
    "matched_by_site_code",
    "matched_by_official_name",
    "matched_by_alternative_name",
    "matched_by_gps",
    "matched_by_name_gps",
}


def _dataset_version(records: list[dict]) -> str:
    """A stable identifier for THIS published dataset: the newest submission it
    contains plus its size. Two runs over identical source data produce the
    same version, so a consumer can tell a genuine refresh from a re-fetch."""
    newest = max((r.get("reportingDate") or "" for r in records), default="")
    return f"{newest or 'empty'}+{len(records)}"


def _canonical_metrics(records: list[dict]) -> dict:
    """Unfiltered headline metrics, published so a consumer does not have to
    infer the analytical grain from the record list.

    Every name states its grain. The dashboard applies the user's filters and
    recomputes these client-side with the identical definitions (see
    canonicalMetrics in assets/js/semantic.js); this block is the same
    arithmetic over the whole dataset, and is what an API consumer or a
    reconciliation check reads.
    """
    current, districts, catchments, partners = {}, set(), set(), set()
    site_level = unresolved_catchments = warnings = 0
    matched_sites, providers = set(), set()
    seen_quarantined = set()

    for r in records:
        if r.get("dataSource") == "zitemanager":
            # A provider-directory entry is not an assessment: nobody conducted
            # it. It still contributes to service-provider presence below.
            if r.get("coverageStatus") == "Yes" and r.get("agency"):
                providers.add(r["agency"])
            if r.get("matchedSiteCode") and r.get("matchStatus") in _TRUSTED_MATCH:
                matched_sites.add(r["matchedSiteCode"])
            continue
        key = r.get("submissionUuid") or r.get("sourceRootUuid") or r.get("sourceId")
        status = r.get("publicationStatus")
        if key and status == "quarantined":
            seen_quarantined.add(key)
        if key and status in ("published", "published_with_warning") and key not in current:
            current[key] = r
        if r.get("coverageStatus") == "Yes" and r.get("agency"):
            providers.add(r["agency"])
        if r.get("matchedSiteCode") and r.get("matchStatus") in _TRUSTED_MATCH:
            matched_sites.add(r["matchedSiteCode"])

    for r in current.values():
        if r.get("district"):
            districts.add(r["district"])
        if r.get("reportingPartner"):
            partners.add(r["reportingPartner"])
        if r.get("scopeType") == "site":
            site_level += 1
        elif r.get("scopeType") == "catchment":
            codes = r.get("reasonCodes") or []
            if r.get("catchment") and not ({"MISSING_REQUIRED_CATCHMENT", "UNRESOLVED_CATCHMENT"} & set(codes)):
                catchments.add(f"{r.get('district')} | {r.get('catchment')}")
            else:
                unresolved_catchments += 1
        if r.get("publicationStatus") == "published_with_warning":
            warnings += 1

    return {
        "assessments": len(current),
        "districts_assessed": len(districts),
        "resolved_catchments_assessed": len(catchments),
        "unresolved_catchment_assessments": unresolved_catchments,
        "site_level_assessments": site_level,
        "matched_master_sites": len(matched_sites),
        "reporting_partners": len(partners),
        "active_service_providers": len(providers),
        "assessments_with_warnings": warnings,
        "quality": {
            "published": len(current) - warnings,
            "published_with_warning": warnings,
            "quarantined": len(seen_quarantined),
        },
    }


def _compact(records: list[dict]) -> list[dict]:
    """Drop keys whose value carries no information.

    JSON has no cheap null: every empty field still costs its key name on every
    one of ~36k records. `matchDistanceMeters` alone is empty on 99% of them.
    Readers already treat a missing key and an explicit null identically (all
    record-level checks are loose `== null` or `|| default`), so removing them
    is lossless — the payload shrinks by roughly a quarter with no change to
    what any consumer can read.
    """
    out = []
    for r in records:
        out.append({k: v for k, v in r.items() if v is not None and v != "" and v != []})
    # THE WRITE BOUNDARY. Nothing may be added to a record between this point
    # and serialisation.
    #
    # Operator free text is scrubbed first (the standing rule permits a scrub in
    # place of exclusion), then EVERYTHING is asserted clean. A personal-data
    # value surviving in a structured field is a hard failure, not something to
    # redact quietly: it means something upstream is putting it there.
    scrubbed = scrub_free_text(out)
    if scrubbed:
        logger.warning("field-classification: redacted personal data from %d free-text value(s)", scrubbed)
    assert_publishable(out)
    return out


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
            "records": _compact(records),
            "summary": _summarize(records),
            "metrics": _canonical_metrics(records),
            # Explanations are published ONCE as a catalog instead of repeated
            # on every record. The text is identical for a given reason code and
            # was costing ~3.7 MB across the payload; the client joins the two.
            "reasonCodeCatalog": {code: explain(code) for code in REASON_CODES},
            "masterSites": _master_sites_summary(),
            "generatedAt": dt.datetime.utcnow().isoformat() + "Z",
            # Explicit freshness so a consumer can judge staleness without
            # having to know that generatedAt means "last successful sync".
            "freshness": {
                "last_kobo_sync": dt.datetime.utcnow().isoformat() + "Z",
                "published_dataset_version": _dataset_version(records),
            },
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
