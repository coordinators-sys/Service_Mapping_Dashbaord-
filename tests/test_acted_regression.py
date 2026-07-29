"""Permanent regression fixtures: the six ACTED submissions from the July 2026
reporting round.

These are real Kobo submissions verified against
CCCM_CLUSTER_-_SERVICE_MAPPING_2025_-_all_versions_-_English_en_-_2026-07-29.
Each one previously exposed a distinct class of failure:

  33907313 Luuq            district-level assessment lost from site-focused KPIs
  33962858 Laas Caanood    site reference unmatched, treated as a critical error
  33962863 Laas Caanood    second site at the same district — must stay distinct
  34224509 Baidoa          district mis-normalised, catchment CA12 silently lost
  34578212 Xudur           catchment level with no catchment in the source
  34667410 Afgooye         published under the WRONG DISTRICT ("Daynile")

The Afgooye case was the headline defect: p-code SO2302 is Afgooye in the Kobo
form but "Mogadishu Dayniile" in the UNDP shapefile the old lookup was built
from, so the record was never missing — it was mislabelled.

    python -m pytest tests/test_acted_regression.py -q
"""

from __future__ import annotations

import pytest

from api.lib.build_payload import _build_clean_records

VERSION = "vP2bWimkW76xrcQurQ24HY"


def submission(**over):
    """A Kobo-API-shaped raw submission with the fields the parser reads."""
    raw = {
        "_id": over.pop("_id"),
        "_uuid": over.pop("uuid"),
        "meta/rootUuid": "uuid:" + over.pop("root", over.get("_uuid", "")),
        "__version__": VERSION,
        "_submission_time": over.pop("submitted"),
        "_submitted_by": "acted_enum",
        "organization_updating": over.pop("partner", "ACTED"),
        "group_general_info/level": over.pop("level"),
        "group_general_info/region": over.pop("region"),
        "group_general_info/district": over.pop("district"),
        "cluster_cccm": "yes",
    }
    if "catchment" in over:
        raw["group_general_info/subdistrict"] = over.pop("catchment")
    if "site" in over:
        raw["group_general_info/site_name"] = over.pop("site")
    raw.update(over)
    return raw


SIX = {
    33907313: submission(
        _id=33907313, uuid="fde1b4bd-6fe3-4786-81fa-54fae36b17e2",
        root="fde1b4bd-6fe3-4786-81fa-54fae36b17e2",
        submitted="2026-07-15T07:30:46", level="District Level",
        region="SO26", district="SO2606"),
    33962858: submission(
        _id=33962858, uuid="30b31622-3cf6-440c-8a05-616db23b02d9",
        root="30b31622-3cf6-440c-8a05-616db23b02d9",
        submitted="2026-07-15T14:16:30", level="Site Level",
        region="SO14", district="SO1401", site="ACTEDSO1401_55"),
    33962863: submission(
        _id=33962863, uuid="cf47ca31-fda7-4f7f-8cae-713076c357bc",
        root="cf47ca31-fda7-4f7f-8cae-713076c357bc",
        submitted="2026-07-15T14:16:32", level="Site Level",
        region="SO14", district="SO1401", site="ACTEDSO1401_56"),
    34224509: submission(
        _id=34224509, uuid="bf6982e7-057a-4207-a22d-3884c8470e28",
        root="bf6982e7-057a-4207-a22d-3884c8470e28",
        submitted="2026-07-20T09:27:15", level="Catchment Level",
        region="SO24", district="SO2401", catchment="CA12"),
    34578212: submission(
        _id=34578212, uuid="1795db1b-c2cd-4ace-8ef8-c2204d08bfc9",
        root="1795db1b-c2cd-4ace-8ef8-c2204d08bfc9",
        submitted="2026-07-26T08:00:53", level="Catchment Level",
        region="SO25", district="SO2501"),
    34667410: submission(
        _id=34667410, uuid="a7424a33-c035-4eaa-8b67-19376d7896e9",
        root="a7424a33-c035-4eaa-8b67-19376d7896e9",
        submitted="2026-07-27T13:39:54", level="District Level",
        region="SO23", district="SO2302"),
}

TERMINAL_STATES = {"published", "published_with_warning", "quarantined", "superseded", "rejected"}


@pytest.fixture(scope="module")
def built():
    """source _id -> one representative published record."""
    records = _build_clean_records(list(SIX.values()))
    by_id: dict[int, dict] = {}
    for r in records:
        by_id.setdefault(int(r["sourceId"]), r)
    return by_id, records


def test_all_six_reach_an_explicit_terminal_state(built):
    by_id, records = built
    assert set(by_id) == set(SIX), "every source submission must appear in the output"
    for r in records:
        assert r["publicationStatus"] in TERMINAL_STATES


def test_reporting_partner_is_acted_for_all_six(built):
    by_id, _ = built
    for sid, rec in by_id.items():
        assert rec["reportingPartner"] == "ACTED", f"{sid} lost its reporting partner"


def test_provider_rows_do_not_overwrite_the_reporting_partner(built):
    """reportingPartner comes from `organization_updating`, never from the
    agency_<sector> repeat groups (which are SERVICE PROVIDERS)."""
    by_id, _ = built
    rec = by_id[34667410]
    assert rec["reportingPartner"] == "ACTED"
    assert "reportingPartner" in rec and "agency" in rec, "the two roles stay separate fields"


def test_afgooye_publishes_under_afgooye_not_daynile(built):
    """The headline defect: SO2302 is Afgooye in the form, but the old
    shapefile-derived lookup called it 'Mogadishu Dayniile' -> 'Daynile'."""
    rec = built[0][34667410]
    assert rec["district"] == "Afgooye"
    assert rec["region"] == "Lower Shabelle"
    assert rec["districtRaw"] == "SO2302"


def test_afgooye_and_luuq_publish_as_district_level_without_fake_sites(built):
    by_id, _ = built
    for sid, district in ((34667410, "Afgooye"), (33907313, "Luuq")):
        rec = by_id[sid]
        assert rec["scopeType"] == "district"
        assert rec["district"] == district
        assert rec["matchedSiteCode"] is None, "a district assessment must not invent a site"
        assert rec["siteCodeRaw"] is None
        assert rec["publicationStatus"] == "published"
        assert rec["reasonCodes"] == []


def test_baidoa_is_normalised_and_retains_catchment_ca12(built):
    rec = built[0][34224509]
    assert rec["district"] == "Baidoa", "Baydhaba must normalise to the master-list spelling"
    assert rec["districtRaw"] == "SO2401"
    assert rec["catchmentRaw"] == "CA12", "the submitted catchment must be preserved"
    assert rec["catchment"] and "CA12" in rec["catchment"]
    assert rec["scopeType"] == "catchment"


def test_xudur_visible_with_missing_catchment_warning_and_no_guess(built):
    rec = built[0][34578212]
    assert rec["district"] == "Xudur"
    assert rec["scopeType"] == "catchment"
    assert rec["catchment"] is None, "never invent a catchment"
    assert rec["catchmentRaw"] is None
    assert "MISSING_REQUIRED_CATCHMENT" in rec["reasonCodes"]
    assert rec["publicationStatus"] == "published_with_warning", "visible, not dropped"
    assert rec["qualityExplanation"]


def test_the_two_laas_caanood_sites_stay_distinct(built):
    by_id, _ = built
    a, b = by_id[33962858], by_id[33962863]
    assert a["siteCodeRaw"] == "ACTEDSO1401_55"
    assert b["siteCodeRaw"] == "ACTEDSO1401_56"
    assert a["siteCodeRaw"] != b["siteCodeRaw"], "must not be merged"
    for rec in (a, b):
        assert rec["scopeType"] == "site"
        assert rec["district"] == "Laas Caanood"
        # Unresolved against the master list, but retained and visible.
        assert "UNRESOLVED_SITE" in rec["reasonCodes"]
        assert rec["publicationStatus"] == "published_with_warning"


def test_five_conducted_districts_are_represented(built):
    _, records = built
    districts = {r["district"] for r in records}
    assert {"Luuq", "Laas Caanood", "Baidoa", "Xudur", "Afgooye"} <= districts


def test_every_record_carries_source_lineage(built):
    _, records = built
    for r in records:
        assert r["sourceId"], "Kobo _id must survive to the published record"
        assert r["sourceRootUuid"], "logical key must survive"
        assert r["sourceVersion"] == VERSION


def test_no_submission_is_silently_dropped(built):
    """The reconciliation invariant, at submission grain."""
    by_id, _ = built
    assert len(by_id) == len(SIX)
    for sid in SIX:
        assert by_id[sid]["publicationStatus"] in TERMINAL_STATES


def test_newer_version_supersedes_older_and_older_is_retained():
    """Re-submitting the same logical record must not duplicate it, and the
    superseded version must still be present for audit."""
    first = SIX[34667410]
    second = dict(first)
    second["_id"] = 34999999
    second["_uuid"] = "99999999-0000-0000-0000-000000000000"
    second["_submission_time"] = "2026-07-28T09:00:00"
    records = _build_clean_records([first, second])
    states = {int(r["sourceId"]): r["publicationStatus"] for r in records}
    assert states[34999999] == "published", "newest version wins"
    assert states[34667410] == "superseded", "older version retained, not deleted"


def test_reprocessing_the_same_payload_is_idempotent():
    before = _build_clean_records(list(SIX.values()))
    after = _build_clean_records(list(SIX.values()))
    assert len(before) == len(after)
    assert {r["sourceId"] for r in before} == {r["sourceId"] for r in after}


# ---------------------------------------------------------------------------
# Defects found only against REAL production data — synthetic fixtures used the
# already-clean values, so these three slipped through the first pass.


def test_organisation_code_resolves_to_official_label():
    """Kobo submits the choice-list CODE ("acted"); the dashboard must show the
    LABEL ("ACTED"). Production published a lower-case code."""
    raw = dict(SIX[34667410])
    raw["organization_updating"] = "acted"
    rec = _build_clean_records([raw])[0]
    assert rec["reportingPartner"] == "ACTED"


def test_catchment_pcode_prefix_is_stripped_and_resolved():
    """Real submissions send districtPcode+code ("SO2401CA12"), not "CA12";
    the un-stripped value failed to resolve and raised UNRESOLVED_CATCHMENT."""
    raw = dict(SIX[34224509])
    raw["group_general_info/subdistrict"] = "SO2401CA12"
    rec = _build_clean_records([raw])[0]
    assert rec["catchmentRaw"] == "SO2401CA12", "raw value retained verbatim"
    assert rec["catchment"] and "CA12" in rec["catchment"]
    assert "UNRESOLVED_CATCHMENT" not in rec["reasonCodes"]


def test_missing_level_with_a_site_is_inferred_and_flagged_not_quarantined():
    """The `level` question is only asked for service mapping, so 17k+ archived
    submissions carry none. Quarantining them would hide a third of the record
    set; naming a site makes the grain unambiguous, and the inference is
    recorded explicitly rather than defaulted silently."""
    raw = dict(SIX[33962858])
    raw.pop("group_general_info/level")
    rec = _build_clean_records([raw])[0]
    assert rec["scopeType"] == "site"
    assert "REPORTING_LEVEL_INFERRED" in rec["reasonCodes"]
    assert "UNKNOWN_REPORTING_LEVEL" not in rec["reasonCodes"]
    assert rec["publicationStatus"] != "quarantined"


def test_missing_level_and_no_site_stays_unknown_and_is_held():
    """With no level AND no site the grain really is undefined — that must
    still be quarantined, so the inference above cannot become a blanket
    default."""
    raw = dict(SIX[34667410])
    raw.pop("group_general_info/level")
    rec = _build_clean_records([raw])[0]
    assert rec["scopeType"] is None
    assert "UNKNOWN_REPORTING_LEVEL" in rec["reasonCodes"]
    assert rec["publicationStatus"] == "quarantined"


def test_retired_organisation_code_maps_to_its_official_label():
    """`pmwd` is the pre-v6 code for PMWDO. Handled in the reviewed alias table,
    not in code, so retired codes stay auditable configuration."""
    raw = dict(SIX[34667410])
    raw["organization_updating"] = "pmwd"
    assert _build_clean_records([raw])[0]["reportingPartner"] == "PMWDO"


def test_unknown_organisation_code_passes_through_rather_than_being_dropped():
    raw = dict(SIX[34667410])
    raw["organization_updating"] = "zzz-not-a-real-org"
    assert _build_clean_records([raw])[0]["reportingPartner"] == "zzz-not-a-real-org"
