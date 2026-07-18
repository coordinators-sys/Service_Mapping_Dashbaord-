"""Catchment/district-level submissions must be labelled area_level_report,
not unmatched — the form only asks for a site at site level, so 'no site
reference' is the DESIGNED outcome there (Service_Mapping_Tool_v6 xlsform:
site_name is relevant only when level='site' or main='fm').

    python -m pytest tests/test_area_level.py -q
"""

from __future__ import annotations

from api.lib.build_payload import _build_clean_records


def raw_submission(level=None, site_select=None):
    raw = {
        "_uuid": "test-uuid-1",
        "_submission_time": "2026-06-15T08:00:00",
        "group_general_info/region": "SO24",
        "group_general_info/district": "SO2401",
    }
    if level is not None:
        raw["group_general_info/level"] = level
    if site_select is not None:
        raw["group_general_info/site_name"] = site_select
    return raw


def statuses(records):
    return {r["matchStatus"] for r in records}


def test_catchment_level_without_site_is_area_report_not_unmatched():
    recs = _build_clean_records([raw_submission(level="catchment")])
    assert recs, "sector rows expected"
    assert statuses(recs) == {"area_level_report"}


def test_district_level_without_site_is_area_report():
    recs = _build_clean_records([raw_submission(level="district")])
    assert statuses(recs) == {"area_level_report"}


def test_site_level_without_site_reference_stays_unmatched():
    # At SITE level a missing site reference is a genuine data problem.
    recs = _build_clean_records([raw_submission(level="site")])
    assert statuses(recs) == {"unmatched"}


def test_no_level_at_all_stays_unmatched():
    # Unknown level -> don't assume; keep the conservative label.
    recs = _build_clean_records([raw_submission()])
    assert statuses(recs) == {"unmatched"}


def test_catchment_level_with_a_real_site_id_still_matches_it():
    # If a site WAS somehow captured, the match must win over the area label.
    recs = _build_clean_records([raw_submission(level="catchment", site_select="CCCM-SO2302-0001")])
    assert statuses(recs) == {"matched_by_site_code"}
    assert recs[0]["matchedSiteCode"] == "CCCM-SO2302-0001"
