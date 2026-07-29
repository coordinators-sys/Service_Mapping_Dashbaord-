"""The ZiteManager provider directory is a reference source, not assessments.

Its rows carry a `submissionUuid`, so the assessment KPI was counting them and
reading roughly threefold high (8,446 shown against 2,718 real assessments).
They must be excluded from the assessment grain while still holding an explicit
terminal state, because "no record is left unclassified" applies to every
source, not only to Kobo.
"""

from __future__ import annotations

import json
import os

from api.lib.zite_transform import transform_zite_records

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RAW = {
    "Contact ID": "ZM-1001",
    "Site ID": "CCCM-BDA-SO2401-01-0028",
    "Site Name": "Buulo Cusbo",
    "Organization": "IOM",
    "Contact Information/Cluster": "WASH",
    "Status": "Active",
    "Region Information/First Level Region ID": "SO2401",
    "Region Information/First Level Region Name": "Baidoa",
    "Updated Date/Date": "2026-06-14",
    # PII that must never reach the payload
    "Contact Information/Contact Name": "Redacted Person",
    "Contact Information/Phone Number": "+252000000000",
    "Contact Information/Email": "person@example.org",
}


def build_one() -> dict:
    records = transform_zite_records([RAW])
    assert records, "the fixture must produce at least one clean record"
    return records[0]


def test_directory_row_reaches_an_explicit_terminal_state():
    rec = build_one()
    assert rec["publicationStatus"] == "published"
    assert rec["reasonCodes"] == []
    assert rec["qualitySeverity"] == "none"


def test_directory_row_declares_no_assessor_and_no_reporting_level():
    """Nobody conducted a directory entry, and it states no reporting level.
    Leaving both empty is what keeps it out of the assessment grain."""
    rec = build_one()
    assert rec["reportingPartner"] is None
    assert rec["scopeType"] is None
    assert rec["dataSource"] == "zitemanager"


def test_no_personal_data_survives_the_transform():
    rec = build_one()
    blob = json.dumps(rec).lower()
    for leaked in ("redacted person", "252000000000", "person@example.org"):
        assert leaked not in blob, f"PII reached the public payload: {leaked}"


def test_retired_org_code_is_reviewed_configuration_not_code():
    aliases = json.load(
        open(os.path.join(ROOT, "data", "name-aliases.json"), encoding="utf-8")
    )
    assert aliases["agency"]["pmwd"] == "PMWDO"
