"""Parses a raw Kobo submission (JSON dict) from the real CCCM service-mapping
form into structured rows — one row per (sector, agency) assessed. No DB/
session/framework dependency — trivially unit-testable.

Every lookup is by KEY SUFFIX (see `find_by_suffix`) rather than a fixed full
path, because the form has been redeployed with different group nesting over
time (`repeat_cccm_cluster` vs `group_cccm_cluster/repeat_cccm_cluster` vs
`group_service_mapping/group_cccm_cluster/repeat_cccm_cluster` all appear
across real submissions) — this is what "support form-version changes" means
in practice for this form.
"""

from __future__ import annotations

import datetime as dt
import json
import os
from dataclasses import dataclass, field
from functools import lru_cache

from api.lib.field_mapping import (
    CLUSTER_FIELD_SUFFIX,
    OTHER_SENTINEL,
    REPEAT_GROUP_SUFFIX,
    SECTOR_DEFS,
    SITE_FIELD_SUFFIXES,
    activities_field_suffix,
    additional_field_suffixes,
    agency_field_suffix,
    agency_new_field_suffix,
    coverage_from_yes_no,
    parse_geopoint,
)

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# AUTHORITATIVE: keyed on the Kobo FORM's p-codes — the values submissions
# actually carry. See scripts/build_admin_reference.py for why this replaced
# the shapefile-derived lookup (the two schemes disagree; SO2302 is Afgooye in
# the form but "Mogadishu Dayniile" in the shapefile, so Afgooye submissions
# were silently published as "Daynile").
_ADMIN_REF_PATH = os.path.join(_PROJECT_ROOT, "data", "admin-reference.json")
# Legacy shapefile-derived lookup, kept only as a fallback for p-codes the form
# does not define, so an unknown code degrades to a name rather than vanishing.
_PCODES_PATH = os.path.join(_PROJECT_ROOT, "data", "admin-pcodes.json")
# Kobo submits the choice-list CODE ("acted"); the dashboard must show the
# official LABEL ("ACTED"). Generated from the form's `organization` list.
_ORGS_PATH = os.path.join(_PROJECT_ROOT, "data", "organizations.json")


@lru_cache(maxsize=1)
def _load_admin_reference() -> dict:
    if not os.path.isfile(_ADMIN_REF_PATH):
        return {"regions": {}, "districts": {}}
    with open(_ADMIN_REF_PATH, encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def _load_organizations() -> dict:
    if not os.path.isfile(_ORGS_PATH):
        return {}
    with open(_ORGS_PATH, encoding="utf-8") as f:
        return json.load(f).get("organizations", {})


def organization_label(code):
    """Official label for a Kobo organisation code; unknown codes pass
    through unchanged so nothing is lost."""
    if not code:
        return code
    key = str(code).strip()
    return _load_organizations().get(key) or _load_organizations().get(key.lower()) or key


@lru_cache(maxsize=1)
def _load_pcodes() -> dict:
    if not os.path.isfile(_PCODES_PATH):
        return {"regions": {}, "districts": {}}
    with open(_PCODES_PATH, encoding="utf-8") as f:
        return json.load(f)


_ALIASES_PATH = os.path.join(_PROJECT_ROOT, "data", "name-aliases.json")


@lru_cache(maxsize=1)
def _load_aliases() -> dict:
    if not os.path.isfile(_ALIASES_PATH):
        return {"district": {}, "region": {}, "agency": {}}
    with open(_ALIASES_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return {k: v for k, v in data.items() if not k.startswith("_")}


def canonical_name(kind: str, value: str | None) -> str | None:
    """Map a raw admin/agency name to its single official spelling via the
    reviewed alias table (data/name-aliases.json). Unlisted values pass
    through unchanged — nothing is silently merged."""
    if not value:
        return value
    return _load_aliases().get(kind, {}).get(str(value).strip().lower(), value)


def resolve_region(pcode: str | None) -> str | None:
    if not pcode:
        return None
    entry = _load_admin_reference()["regions"].get(pcode)
    if entry:
        return canonical_name("region", entry["name"])
    name = _load_pcodes()["regions"].get(pcode, pcode)
    return canonical_name("region", name)


def resolve_district(pcode: str | None) -> tuple[str | None, str | None]:
    """Returns (district_name, region_name) — district lookup also gives us
    its parent region, useful when only the district pcode is present.

    Resolution order: the authoritative form-derived reference first, then the
    legacy shapefile lookup, then the raw p-code. An unrecognised p-code is
    never dropped — it degrades to the code itself so the record stays
    traceable and shows up as an unresolved admin value in review.
    """
    if not pcode:
        return None, None
    entry = _load_admin_reference()["districts"].get(pcode)
    if entry:
        region = entry.get("regionName") or resolve_region(entry.get("regionCode"))
        return canonical_name("district", entry["name"]), region
    legacy = _load_pcodes()["districts"].get(pcode)
    if legacy:
        return canonical_name("district", legacy["name"]), resolve_region(legacy.get("region_code"))
    return canonical_name("district", pcode), None


def district_is_resolved(pcode: str | None) -> bool:
    """True when the p-code is a known administrative unit (not a bare code
    echoed back). Drives the UNRESOLVED_DISTRICT data-quality reason code."""
    if not pcode:
        return False
    return pcode in _load_admin_reference()["districts"] or pcode in _load_pcodes()["districts"]



# Controlled reporting-level vocabulary. Anything outside this map is NOT
# coerced to a default — parse_submission returns None and the record is
# flagged UNKNOWN_REPORTING_LEVEL downstream.
_REPORTING_LEVEL_MAP = {
    "district level": "district",
    "district": "district",
    "catchment level": "catchment",
    "catchment": "catchment",
    "site level": "site",
    "site": "site",
}


def _normalize_reporting_level(value: str | None) -> str | None:
    if not value:
        return None
    return _REPORTING_LEVEL_MAP.get(" ".join(str(value).strip().lower().split()))

def find_by_suffix(raw: dict, suffix: str):
    """Returns the value of the first key in `raw` that equals `suffix` or
    ends with '/' + suffix. Tolerates arbitrary group-nesting drift."""
    if suffix in raw:
        return raw[suffix]
    for key, value in raw.items():
        if key.endswith("/" + suffix):
            return value
    return None


def find_repeat_group(raw: dict, suffix: str) -> list[dict]:
    """Returns a list of "repeat instance" dicts for the given group suffix.

    NOTE: despite being named "repeat_<sector>" in the XLSForm, this group is
    NOT exported as a JSON array by this Kobo deployment — its fields
    (agency_<x>, activities_<x>, ...) appear as flattened scalar keys at the
    submission's top level (confirmed against live submissions on
    2026-07-16). We treat the submission itself as "instance 0". A true list
    is still handled as a fallback in case a future export format changes
    this back to nested arrays.
    """
    value = find_by_suffix(raw, suffix)
    if isinstance(value, list):
        return value
    return [raw]


@dataclass
class SectorAgencyRow:
    sector: str
    coverage_status: str  # "covered" | "not_covered" | "unknown"
    agency: str | None
    activity: str | None


@dataclass
class ParsedSubmission:
    submission_uuid: str
    submission_time: dt.datetime
    submitted_by: str | None
    site_id_raw: str | None  # the CCCM Site ID if the form's site_name select gave one directly
    site_name_raw: str | None  # free-text name when site_name was "other"
    # The form's reporting level: "site" | "catchment" | "district" (question
    # `level`). site_name is only ASKED at site level, so a catchment/district
    # submission legitimately has no site reference — it must be labelled an
    # area-level report, not treated as a failed site match.
    reporting_level: str | None
    reporting_level_raw: str | None
    reporting_level_inferred: bool
    # Lineage — every published record must be traceable to its raw source.
    source_id: str | None            # Kobo _id
    source_root_uuid: str | None     # meta/rootUuid (logical key across versions)
    source_version: str | None       # __version__
    submitted_by: str | None
    # Raw administrative values, retained BESIDE the normalized ones so a
    # reviewer can always see what the partner actually submitted.
    region_pcode: str | None
    district_pcode: str | None
    district_resolved: bool
    catchment_raw: str | None
    reporting_partner: str | None
    region: str | None
    district: str | None
    reporting_period: str | None
    latitude: float | None
    longitude: float | None
    rows: list[SectorAgencyRow] = field(default_factory=list)


def _reporting_period_from(submission_time: dt.datetime) -> str:
    """Monthly reporting cycle (YYYY-MM) — the service-mapping report is
    updated every month, so periods, trend charts, and period-over-period
    comparisons all operate on calendar months."""
    return f"{submission_time.year}-{submission_time.month:02d}"


def _repeat_item_value(item: dict, suffix: str):
    """Repeat-group items carry the SAME group-prefix drift as top-level
    fields, so reuse suffix matching on the item dict itself."""
    return find_by_suffix(item, suffix)


def _agency_name_from_repeat_item(item: dict, stem: str) -> str | None:
    raw_value = _repeat_item_value(item, agency_field_suffix(stem))
    if raw_value and str(raw_value).strip().lower() != OTHER_SENTINEL:
        return str(raw_value).strip()
    other_value = _repeat_item_value(item, agency_new_field_suffix(stem))
    return str(other_value).strip() if other_value else raw_value


def _activity_from_repeat_item(item: dict, stem: str) -> str | None:
    codes = _repeat_item_value(item, activities_field_suffix(stem))
    extras = [
        str(_repeat_item_value(item, suffix)).strip()
        for suffix in additional_field_suffixes(stem)
        if _repeat_item_value(item, suffix)
    ]
    parts = []
    if codes:
        parts.append(str(codes).strip())
    parts.extend(extras)
    return "; ".join(parts) if parts else None


def parse_submission(raw: dict) -> ParsedSubmission:
    submission_uuid = raw.get("_uuid") or raw.get("meta/instanceID", "")
    submission_time_raw = raw.get("_submission_time")
    submission_time = (
        dt.datetime.fromisoformat(submission_time_raw) if submission_time_raw else dt.datetime.utcnow()
    )

    region_pcode = find_by_suffix(raw, SITE_FIELD_SUFFIXES["region_pcode"])
    district_pcode = find_by_suffix(raw, SITE_FIELD_SUFFIXES["district_pcode"])
    district_name, region_from_district = resolve_district(district_pcode)
    region_name = resolve_region(region_pcode) or region_from_district

    site_name_select = find_by_suffix(raw, SITE_FIELD_SUFFIXES["site_name_select"])
    site_id_raw = None
    site_name_raw = None
    if site_name_select and str(site_name_select).strip().lower() != OTHER_SENTINEL:
        site_id_raw = str(site_name_select).strip()
    else:
        site_name_raw = (
            find_by_suffix(raw, SITE_FIELD_SUFFIXES["site_name_new"])
            or find_by_suffix(raw, SITE_FIELD_SUFFIXES["site_name_other"])
        )

    lat, lon = parse_geopoint(find_by_suffix(raw, SITE_FIELD_SUFFIXES["gps"]))

    # Reporting level ("site" / "catchment" / "district"). Suffix-matched like
    # every other field so group-prefix drift can't hide it. Only the three
    # controlled values are accepted; anything else stays raw and is flagged
    # downstream rather than silently defaulting to site level.
    level_value = find_by_suffix(raw, SITE_FIELD_SUFFIXES["level"])
    reporting_level_raw = str(level_value).strip() if level_value else None
    reporting_level = _normalize_reporting_level(reporting_level_raw)
    # The `level` question is only asked for service mapping, so facility
    # mapping and older form versions carry no level at all (17k+ historical
    # submissions). Quarantining those would hide a third of the archive. If a
    # submission names a SITE, its grain is not ambiguous - it is a site
    # observation. That inference is recorded with its own reason code and is
    # therefore explicit, not a silent default; with no level AND no site the
    # grain really is unknown and the record is held for review.
    level_inferred = False

    # Reporting partner = the agency that CONDUCTED the assessment.
    partner_value = find_by_suffix(raw, SITE_FIELD_SUFFIXES["reporting_partner"])
    reporting_partner = str(partner_value).strip() if partner_value else None
    if reporting_partner and reporting_partner.lower() == OTHER_SENTINEL:
        other = find_by_suffix(raw, SITE_FIELD_SUFFIXES["reporting_partner_other"])
        reporting_partner = str(other).strip() if other else None
    reporting_partner = canonical_name("agency", organization_label(reporting_partner))

    # Catchment straight from the SOURCE (never inferred from a matched site).
    catchment_value = find_by_suffix(raw, SITE_FIELD_SUFFIXES["catchment"])
    catchment_raw = str(catchment_value).strip() if catchment_value else None

    if reporting_level is None and (site_id_raw or site_name_raw):
        reporting_level = "site"
        level_inferred = True


    rows: list[SectorAgencyRow] = []
    for sector_name, stem in SECTOR_DEFS:
        coverage_status = coverage_from_yes_no(find_by_suffix(raw, CLUSTER_FIELD_SUFFIX[stem]))
        repeat_items = find_repeat_group(raw, REPEAT_GROUP_SUFFIX[stem])

        if coverage_status == "covered" and repeat_items:
            for item in repeat_items:
                rows.append(
                    SectorAgencyRow(
                        sector=sector_name,
                        coverage_status="covered",
                        agency=_agency_name_from_repeat_item(item, stem),
                        activity=_activity_from_repeat_item(item, stem),
                    )
                )
        else:
            # not covered / unknown, or covered=yes but no repeat instance
            # was actually filled in (defensive — shouldn't normally happen).
            rows.append(SectorAgencyRow(sector=sector_name, coverage_status=coverage_status, agency=None, activity=None))

    return ParsedSubmission(
        submission_uuid=submission_uuid,
        submission_time=submission_time,
        submitted_by=raw.get("_submitted_by"),
        site_id_raw=site_id_raw,
        site_name_raw=site_name_raw,
        reporting_level=reporting_level,
        reporting_level_raw=reporting_level_raw,
        reporting_level_inferred=level_inferred,
        source_id=str(raw.get("_id")) if raw.get("_id") is not None else None,
        source_root_uuid=(raw.get("meta/rootUuid") or raw.get("meta/instanceID") or None),
        source_version=raw.get("__version__"),
        region_pcode=str(region_pcode).strip() if region_pcode else None,
        district_pcode=str(district_pcode).strip() if district_pcode else None,
        district_resolved=district_is_resolved(district_pcode),
        catchment_raw=catchment_raw,
        reporting_partner=reporting_partner,
        region=region_name,
        district=district_name,
        reporting_period=_reporting_period_from(submission_time),
        latitude=lat,
        longitude=lon,
        rows=rows,
    )
