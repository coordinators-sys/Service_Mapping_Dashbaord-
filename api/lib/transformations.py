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
_PCODES_PATH = os.path.join(_PROJECT_ROOT, "data", "admin-pcodes.json")


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
    name = _load_pcodes()["regions"].get(pcode, pcode)
    return canonical_name("region", name)


def resolve_district(pcode: str | None) -> tuple[str | None, str | None]:
    """Returns (district_name, region_name) — district lookup also gives us
    its parent region, useful when only the district pcode is present."""
    if not pcode:
        return None, None
    entry = _load_pcodes()["districts"].get(pcode)
    if not entry:
        return canonical_name("district", pcode), None
    return canonical_name("district", entry["name"]), resolve_region(entry.get("region_code"))


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
        region=region_name,
        district=district_name,
        reporting_period=_reporting_period_from(submission_time),
        latitude=lat,
        longitude=lon,
        rows=rows,
    )
