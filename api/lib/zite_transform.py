"""Transforms raw ZiteManager service-provider contact records into the same
clean-record shape Kobo submissions produce (data/build_payload.py merges
both). Deliberately drops every PII field ("Contact Name", "Phone Number",
"Email", "Whatsapp", "Notes") — this dashboard has no auth/RBAC yet, so
nothing that identifies an individual focal point may reach the public API.

ZiteManager has no GPS and a Site ID format incompatible with the CCCM master
list ("CCCM-BDA-SO2401-01-0028" vs "CCCM-SO2401-0001"), so site matching here
is by Site Name only (see site_matching.py's official/alternative/fuzzy-name
tiers — the GPS tier is simply never reached for this source).

ZiteManager's "Protection" cluster does not distinguish Child Protection/
GBV/HLP the way the Kobo form does — it's mapped to "General Protection"
only, which will understate coverage for those three sectors if a site's
*only* record of protection service is a ZiteManager one.
"""

from __future__ import annotations

import datetime as dt

from api.lib.site_matching import get_master_site_index
from api.lib.transformations import resolve_district

CLUSTER_TO_SECTOR = {
    "CCCM": "CCCM",
    "Protection": "General Protection",
    "Child Protection": "Child Protection",
    "GBV": "GBV",
    "HLP": "HLP",
    "Nutrition": "Nutrition",
    "Health": "Health",
    "Education": "Education",
    "Food Security & Livelihoods": "Food Security and Livelihoods",
    "WASH": "WASH",
    "Shelter & NFI": "Shelter/NFI",
}

# "Flagged" means "under data-quality review" in ZiteManager, not confirmed
# active or confirmed gone — treated as unknown, same rule as a blank Kobo
# answer: never silently promoted to Yes or No.
STATUS_TO_COVERAGE = {"active": "covered", "inactive": "not_covered"}


def _coverage_from_status(status: str | None) -> str:
    if not status:
        return "unknown"
    return STATUS_TO_COVERAGE.get(str(status).strip().lower(), "unknown")


def _reporting_period_from(date_str: str | None) -> str | None:
    """Monthly reporting cycle (YYYY-MM), same convention as the Kobo source."""
    if not date_str:
        return None
    try:
        d = dt.date.fromisoformat(str(date_str)[:10])
    except ValueError:
        return None
    return f"{d.year}-{d.month:02d}"


def _coverage_label(internal_status: str) -> str:
    return {"covered": "Yes", "not_covered": "No", "unknown": "Unknown"}.get(internal_status, "Unknown")


def transform_zite_records(raw_records: list[dict]) -> list[dict]:
    index = get_master_site_index()
    clean: list[dict] = []

    for raw in raw_records:
        site_name = raw.get("Site Name")

        # ZiteManager's "First Level Region" is actually district-level (e.g.
        # "Baidoa") — resolve the real region via the pcode lookup rather than
        # misusing that name as both fields. Resolved up front so the district
        # can DISAMBIGUATE name-only matches (site names repeat across the
        # country; without this a "Tawakal" record could bind to the wrong
        # district's Tawakal).
        district_pcode = raw.get("Region Information/First Level Region ID")
        resolved_district_name, resolved_region = resolve_district(district_pcode)
        district_hint = resolved_district_name or raw.get("Region Information/First Level Region Name")

        match = index.match(None, site_name, None, None, district=district_hint)

        sector = CLUSTER_TO_SECTOR.get((raw.get("Contact Information/Cluster") or "").strip())
        if sector is None:
            continue  # unrecognized cluster value — skip rather than mis-tag a sector

        coverage_internal = _coverage_from_status(raw.get("Status"))
        updated_date = raw.get("Updated Date/Date") or raw.get("Created Date/Date")
        agency = (raw.get("Organization") or "").strip() or None

        if match.site:
            region, district = match.site.region, match.site.district
        else:
            district = district_hint
            region = resolved_region

        clean.append(
            {
                "submissionUuid": f"zite-{raw.get('Contact ID', '')}",
                "reportingDate": updated_date,
                "reportingPeriod": _reporting_period_from(updated_date),
                "region": region or "",
                "district": district or "",
                "catchment": match.site.catchment if match.site else None,
                "siteCodeRaw": raw.get("Site ID"),
                "siteNameRaw": site_name,
                "matchedSiteCode": match.site.cccm_site_id if match.site else None,
                "matchedSiteName": match.site.site_name if match.site else None,
                "matchStatus": match.match_status,
                "matchDistanceMeters": match.match_distance_meters,
                "latitude": match.site.latitude if match.site else None,
                "longitude": match.site.longitude if match.site else None,
                "agency": agency,
                "partnerType": None,
                "sector": sector,
                "service": None,
                "activity": raw.get("Contact Information/Activities") or None,
                "coverageStatus": _coverage_label(coverage_internal),
                "operationalStatus": raw.get("Status"),
                "lastUpdated": updated_date,
                "dataQualityStatus": None,  # filled by validation.compute_record_quality_status downstream
                "dataSource": "zitemanager",
            }
        )

    return clean
