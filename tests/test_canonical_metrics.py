"""Server-side canonical metrics, the reconciliation register and the two
exception workflows.

The API publishes the metrics rather than leaving a consumer to infer the
analytical grain from the record list, and the dashboard recomputes the same
definitions client-side (assets/js/semantic.js). If the two ever disagree the
dashboard and the API are telling different stories, so the ACTED July fixture
is asserted against BOTH.
"""

from __future__ import annotations

import json
import os

from api.lib.build_payload import _build_clean_records, _canonical_metrics
from api.lib.transformations import form_site_label
from api.lib.site_matching import get_master_site_index
from tests.test_acted_regression import SIX

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def register() -> dict:
    with open(os.path.join(ROOT, "data", "site-reconciliation.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    return {e["raw_site_reference"]: e for e in data["entries"]}


# ---------------------------------------------------------------------------
# Metrics


def test_acted_july_metrics_match_the_verified_figures():
    m = _canonical_metrics(_build_clean_records(list(SIX.values())))
    assert m["assessments"] == 6
    assert m["districts_assessed"] == 5
    assert m["resolved_catchments_assessed"] == 1
    assert m["unresolved_catchment_assessments"] == 1
    assert m["site_level_assessments"] == 2
    assert m["matched_master_sites"] == 0
    assert m["reporting_partners"] == 1
    assert m["assessments_with_warnings"] == 3
    assert m["quality"] == {"published": 3, "published_with_warning": 3, "quarantined": 0}


def test_matched_sites_and_site_level_assessments_are_distinct_metrics():
    """Two site-flavoured numbers that legitimately disagree. Publishing them
    under one label is what made the dashboard look self-contradictory."""
    m = _canonical_metrics(_build_clean_records(list(SIX.values())))
    assert m["site_level_assessments"] == 2
    assert m["matched_master_sites"] == 0


def test_a_probable_name_match_is_not_a_matched_master_site():
    records = [{
        "dataSource": "kobo", "submissionUuid": "u1", "publicationStatus": "published",
        "scopeType": "site", "district": "Baidoa", "reasonCodes": [],
        "matchedSiteCode": "CCCM-SO2401-0001", "matchStatus": "probable_name_match",
    }]
    assert _canonical_metrics(records)["matched_master_sites"] == 0


# ---------------------------------------------------------------------------
# Issue 2 — Laas Caanood reconciliation


def test_the_form_code_resolves_to_the_site_name_the_enumerator_selected():
    """Step 3 of the matching hierarchy. Without this the reference is an
    opaque code and the name tiers have nothing to work with."""
    assert form_site_label("ACTEDSO1401_55") == "Adhi Cadeeye"
    assert form_site_label("ACTEDSO1401_56") == "Guumays"


def test_an_unknown_form_code_yields_no_name_rather_than_echoing_itself():
    """A code returned as a 'name' would be fed to the name-matching tiers as
    though it were one."""
    assert form_site_label("NOT-A-REAL-CODE") is None


def test_neither_laas_caanood_reference_matches_the_master_list():
    """The evidence behind the register: exhausting the hierarchy, including
    the recovered names, still yields no trusted match."""
    index = get_master_site_index()
    for code in ("ACTEDSO1401_55", "ACTEDSO1401_56"):
        result = index.match(code, form_site_label(code), None, None, district="Laas Caanood")
        assert result.site is None, f"{code} must not be bound to a master site"
        assert result.match_status == "unmatched"


def test_both_references_are_recorded_in_the_reconciliation_register():
    entries = register()
    for code in ("ACTEDSO1401_55", "ACTEDSO1401_56"):
        assert code in entries, "an unresolved reference must be assigned, not merely displayed"
        e = entries[code]
        assert e["status"] == "unresolved"
        assert e["owner"], "every open exception needs an owner"
        assert e["official_site_id"] is None, "never invent a site ID"
        assert e["district"] == "Laas Caanood"
        assert len(e["evidence"]) >= 6, "the matching hierarchy must be recorded, not summarised"


def test_the_register_never_asserts_a_match_without_approval():
    """Guards the file itself: a resolved row must carry its provenance."""
    for entry in register().values():
        if entry["official_site_id"]:
            assert entry["match_method"], "a resolved row must say HOW it was matched"
            assert entry["approved_by"], "and who approved it"
            assert entry["confidence"], "and with what confidence"
            assert entry["status"] == "resolved"


def test_unresolved_references_carry_their_owner_onto_the_record():
    raw = dict(SIX[33962858])
    rec = _build_clean_records([raw])[0]
    assert "UNMATCHED_MASTER_SITE" in rec["reasonCodes"]
    assert rec["reconciliationStatus"] == "unresolved"
    assert rec["reconciliationOwner"]


# ---------------------------------------------------------------------------
# Issue 3 — Xudur missing-catchment exception


def test_xudur_stays_counted_visible_and_unguessed():
    records = _build_clean_records([SIX[34578212]])
    rec = records[0]
    assert rec["district"] == "Xudur"
    assert rec["scopeType"] == "catchment", "the declared scope is preserved"
    assert rec["catchment"] is None, "never invent a catchment"
    assert "MISSING_REQUIRED_CATCHMENT" in rec["reasonCodes"]
    assert rec["publicationStatus"] == "published_with_warning"
    assert rec["qualitySeverity"] == "medium", "district context is trustworthy, the child geography is not"

    m = _canonical_metrics(records)
    assert m["assessments"] == 1, "counted as an assessment"
    assert m["resolved_catchments_assessed"] == 0, "but not as a resolved catchment"
    assert m["unresolved_catchment_assessments"] == 1, "and reported as the exception it is"


def test_a_corrected_kobo_version_resolves_the_warning_automatically():
    """Source corrections take precedence: a newer version supplying the
    catchment supersedes the flagged one with no manual mapping."""
    original = SIX[34578212]
    corrected = dict(original)
    corrected["_id"] = 39999999
    corrected["_uuid"] = "11111111-2222-3333-4444-555555555555"
    corrected["_submission_time"] = "2026-07-28T10:00:00"
    corrected["group_general_info/subdistrict"] = "SO2501CA01"

    by_id = {}
    for r in _build_clean_records([original, corrected]):
        by_id.setdefault(int(r["sourceId"]), r)

    assert by_id[34578212]["publicationStatus"] == "superseded", "the flagged version is retained for audit"
    fixed = by_id[39999999]
    assert "MISSING_REQUIRED_CATCHMENT" not in fixed["reasonCodes"]
    assert fixed["catchmentRaw"] == "SO2501CA01", "the submitted value is preserved verbatim"
