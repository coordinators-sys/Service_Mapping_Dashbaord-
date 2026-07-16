"""Field-name mapping for the REAL CCCM Cluster Somalia service-mapping Kobo
form (asset apWf3JYW4hCFRE3pwwafwn), confirmed by inspecting live submissions
on 2026-07-16 — this is not a placeholder guess.

Form shape per sector: a Yes/No "cluster_<key>" question, followed by a
repeat group "repeat_<key>" (one instance per agency active in that sector)
holding "agency_<key>" (+ "agency_<key>_new" free-text when "other" is
picked), activities, and focal-point contact fields.

The form has been re-deployed at least twice with different group nesting
(bare `repeat_cccm_cluster`, `group_cccm_cluster/repeat_cccm_cluster`, and
`group_service_mapping/group_cccm_cluster/repeat_cccm_cluster` all appear
across submissions) — every lookup here is by KEY SUFFIX, not full path, so
version drift doesn't break parsing. See `find_by_suffix` in transformations.py.
"""

from __future__ import annotations

SECTOR_DEFS = [
    # (canonical sector name, field-key stem)
    ("CCCM", "cccm"),
    ("General Protection", "pro"),  # cluster_protection / repeat_protection_cluster / agency_pro
    ("Child Protection", "cp"),
    ("GBV", "gbv"),
    ("HLP", "hlp"),
    ("Shelter/NFI", "snfi"),
    ("WASH", "wash"),
    ("Health", "health"),
    ("Food Security and Livelihoods", "fsl"),
    ("Nutrition", "nutrition"),
    ("Education", "education"),
]

# cluster_<X> presence question's suffix, per sector stem (irregular: not
# every sector uses "cluster_<stem>" verbatim, e.g. protection uses
# "cluster_protection" not "cluster_pro").
CLUSTER_FIELD_SUFFIX = {
    "cccm": "cluster_cccm",
    "pro": "cluster_protection",
    "cp": "cluster_protection_cp",
    "gbv": "cluster_protection_gbv",
    "hlp": "cluster_protection_hlp",
    "snfi": "cluster_snfi",
    "wash": "cluster_wash",
    "health": "cluster_health",
    "fsl": "cluster_fsl",
    "nutrition": "cluster_nutrition",
    "education": "cluster_education",
}

# Repeat-group key suffix per sector stem (irregular: protection's repeat is
# "repeat_protection_cluster", not "repeat_pro").
REPEAT_GROUP_SUFFIX = {
    "cccm": "repeat_cccm_cluster",
    "pro": "repeat_protection_cluster",
    "cp": "repeat_cp_aor",
    "gbv": "repeat_gbv_aor",
    "hlp": "repeat_hlp_aor",
    "snfi": "repeat_snfi",
    "wash": "repeat_wash",
    "health": "repeat_health",
    "fsl": "repeat_foodsecurity",
    "nutrition": "repeat_nutrition",
    "education": "repeat_education",
}

SITE_FIELD_SUFFIXES = {
    "region_pcode": "group_general_info/region",
    "district_pcode": "group_general_info/district",
    "site_name_select": "group_general_info/site_name",
    "site_name_new": "group_general_info/site_name_new",
    "site_name_other": "group_general_info/site_name_other",
    "gps": "group_general_info/GPS_device_input_002",
}

# select-one "other" sentinel value used throughout this form.
OTHER_SENTINEL = "other"


def agency_field_suffix(stem: str) -> str:
    return f"agency_{stem}"


def agency_new_field_suffix(stem: str) -> str:
    return f"agency_{stem}_new"


def activities_field_suffix(stem: str) -> str:
    return f"activities_{stem}"


def additional_field_suffixes(stem: str) -> list[str]:
    return [f"additional_{stem}_1", f"additional_{stem}_2", f"additional_{stem}_3"]


def coverage_from_yes_no(value) -> str:
    """Blank/None/anything but an explicit yes/no is 'unknown' — never 'no'."""
    if value is None:
        return "unknown"
    key = str(value).strip().lower()
    if key == "yes":
        return "covered"
    if key == "no":
        return "not_covered"
    return "unknown"


def parse_geopoint(value: str | None) -> tuple[float | None, float | None]:
    """ODK geopoint format: 'lat lon altitude accuracy' space-separated."""
    if not value:
        return None, None
    parts = str(value).split()
    if len(parts) < 2:
        return None, None
    try:
        return float(parts[0]), float(parts[1])
    except ValueError:
        return None, None
