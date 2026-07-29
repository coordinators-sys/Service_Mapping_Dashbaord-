"""Standing rule: no personal data in any client artefact, in any tier, ever.

These tests are the enforcement. They exist because the guarantee today is a
property of how the code happens to be written — nobody parses the focal-point
fields — and a property nobody tests is one that regresses the first time
somebody adds a field in a hurry.

The register (data/field-classification.yml) carries the rationale a human
reads; api/lib/field_classification.py carries the list the build enforces. A
test binds them so the register cannot quietly become decorative.
"""

from __future__ import annotations

import json
import os

import pytest
import yaml

from api.lib.field_classification import (
    APPROVED_EXCEPTION_OWNERS,
    FREE_TEXT_FIELDS,
    PARTNER_FIELDS,
    PUBLIC_FIELDS,
    PUBLISHED_FIELDS,
    FieldClassificationError,
    assert_publishable,
    drop_excluded_free_text,
    personal_data_hits,
    scrub_free_text,
    unclassified_fields,
)
from api.lib.build_payload import _build_clean_records, _compact
from tests.test_acted_regression import SIX

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(scope="module")
def register() -> dict:
    with open(os.path.join(ROOT, "data", "field-classification.yml"), encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def names(entries) -> set[str]:
    """Field names from a register section (list of single-key mappings)."""
    out = set()
    for entry in entries or []:
        if isinstance(entry, dict):
            out.update(entry.keys())
        elif isinstance(entry, str):
            out.add(entry)
    return out


# ---------------------------------------------------------------------------
# The register and the enforced list must agree.


def test_register_and_enforced_allowlist_do_not_drift(register):
    assert names(register["public"]) == set(PUBLIC_FIELDS), (
        "data/field-classification.yml and PUBLIC_FIELDS disagree — the register "
        "documents a decision the build is not enforcing, or vice versa"
    )
    assert names(register["partner"]) == set(PARTNER_FIELDS)


def test_register_declares_a_version_and_an_approver(register):
    """A classification decision without provenance cannot be audited."""
    assert register["version"]
    assert register["effective_date"]
    assert register["approved_by"]


def test_public_and_partner_tiers_do_not_overlap():
    """A field is public or partner, never both — otherwise the public
    artefact's contents depend on which list is consulted."""
    assert not (PUBLIC_FIELDS & PARTNER_FIELDS)


def test_site_identifiers_are_never_public():
    """The protection control, distinct from the privacy one: site name, ID and
    coordinates carry the exposure quantified on 2026-07-29."""
    for field in ("matchedSiteCode", "matchedSiteName", "siteCodeRaw", "siteNameRaw",
                  "latitude", "longitude"):
        assert field in PARTNER_FIELDS
        assert field not in PUBLIC_FIELDS, f"{field} must never reach an unauthenticated client"


# ---------------------------------------------------------------------------
# The allowlist must be an allowlist.


def test_an_unclassified_field_is_refused():
    """The whole point of opt-in: forgetting to classify fails safe."""
    records = [{"district": "Baidoa", "cfm_focal_name": "a person"}]
    assert unclassified_fields(records) == {"cfm_focal_name"}
    with pytest.raises(FieldClassificationError, match="cfm_focal_name"):
        assert_publishable(records)


def test_the_refusal_names_the_field_but_never_quotes_the_value():
    """A leak report that quotes the leak just moves it into the logs."""
    secret = "aamina@example.org"
    records = [{"district": "Baidoa", "some_new_field": secret}]
    with pytest.raises(FieldClassificationError) as excinfo:
        assert_publishable(records)
    assert secret not in str(excinfo.value)


@pytest.mark.parametrize(
    "field",
    ["cfm_focal_name", "cfm_focal_email", "cfm_focal_phone", "cfm_focal_designation",
     "mobile_focal_wash", "email_focal_health", "title_focal_cccm", "respondent_phone",
     "cfm_hotline", "_submitted_by", "site_name_new", "site_name_other",
     "activity", "service"],
)
def test_known_personal_fields_are_not_on_the_allowlist(field):
    """Named explicitly so that adding one back is a deliberate, visible act."""
    assert field not in PUBLISHED_FIELDS


# ---------------------------------------------------------------------------
# Value-shape scanning, in fields that are allowed.


@pytest.mark.parametrize(
    "value",
    ["contact aamina@example.org", "+252 61 234 5678", "+252612345678", "ring 0615123456"],
    ids=["email", "mobile spaced", "mobile compact", "national form"],
)
def test_personal_data_is_caught_even_in_an_allowlisted_field(value):
    """A field's NAME staying the same does not mean its CONTENT did."""
    assert personal_data_hits([{"reportingPartner": value}])


@pytest.mark.parametrize(
    "field,value",
    [
        ("submissionUuid", "558f2778-0319-4407-af30-2d72551d81fa"),
        ("submissionUuid", "zite--000000003"),
        ("reportingDate", "2026-07-27T13:39:54"),
        ("siteCodeRaw", "CCCM-SO2401-0001"),
        ("siteCodeRaw", "CCCM-SO2401-T1999"),
        ("catchment", "Baidoa · CA12"),
        ("districtRaw", "SO2302"),
        ("reportingPeriod", "2026-07"),
    ],
    ids=["uuid", "zite id", "iso timestamp", "site code", "temp site code",
         "catchment", "p-code", "period"],
)
def test_ordinary_identifiers_are_not_mistaken_for_personal_data(field, value):
    """A control that cries wolf gets switched off. An earlier version of the
    phone pattern matched digits inside a UUID and would have blocked every
    build."""
    assert personal_data_hits([{field: value}]) == []


# ---------------------------------------------------------------------------
# Free text: scrubbed, not trusted.


def test_operator_free_text_is_excluded_outright():
    """Cluster Coordinator, 2026-07-29: exclude rather than scrub. Emails and
    phone numbers have shapes and can be removed reliably; a person's name does
    not, so a scrub could only ever be partial — and a partial control on a
    public dashboard is one somebody eventually mistakes for a complete one."""
    records = [{"district": "Baidoa", "activity": "nutrition_1 outreach@example.org", "service": "x"}]
    assert drop_excluded_free_text(records) == 2
    assert "activity" not in records[0]
    assert "service" not in records[0]
    assert_publishable(records)


def test_reinstating_operator_free_text_fails_the_build():
    """The allowlist is the backstop: if the drop is ever removed, the gate
    still refuses the payload rather than publishing prose."""
    with pytest.raises(FieldClassificationError, match="activity"):
        assert_publishable([{"district": "Baidoa", "activity": "anything at all"}])


def test_cluster_authored_prose_is_still_scrubbed():
    """reconciliationNote is written by the Cluster, not by an operator, so it
    is scrubbed rather than excluded — and it is partner-tier only."""
    records = [{"reconciliationNote": "chase with outreach@example.org"}]
    assert scrub_free_text(records) == 1
    assert "@" not in records[0]["reconciliationNote"]


def test_a_phone_number_in_a_structured_field_is_a_hard_failure():
    """Scrubbing is for operator prose. A phone number in a structured field
    means something upstream is wrong, and quietly redacting it would hide
    that."""
    records = [{"reportingPartner": "ACTED +252612345678"}]
    assert scrub_free_text(records) == 0, "not a free-text field, so not scrubbed"
    with pytest.raises(FieldClassificationError):
        assert_publishable(records)


def test_every_free_text_field_is_itself_classified():
    assert FREE_TEXT_FIELDS <= PUBLISHED_FIELDS


# ---------------------------------------------------------------------------
# The real pipeline.


def test_the_built_payload_passes_its_own_gate():
    """The gate sits at the WRITE boundary (_compact), not at record
    construction — records legitimately carry operator free text right up until
    the moment they are serialised. This asserts the boundary is where it is
    claimed to be, and fails loudly if the call is ever removed."""
    raw = _build_clean_records(list(SIX.values()))
    assert raw
    assert any("activity" in r for r in raw), (
        "the fixture should still carry free text BEFORE the gate — otherwise "
        "this test proves nothing about the gate"
    )
    published = _compact(raw)
    assert published
    assert not any("activity" in r for r in published)
    assert unclassified_fields(published) == set()
    assert personal_data_hits(published) == []


def test_reconciliation_owners_are_teams_not_individuals():
    """`reconciliationOwner` is partner-visible free-ish text maintained by the
    Cluster. Constraining it to approved team names stops a person's name being
    typed into a published field."""
    with open(os.path.join(ROOT, "data", "site-reconciliation.json"), encoding="utf-8") as fh:
        entries = json.load(fh)["entries"]
    assert entries
    for entry in entries:
        assert entry["owner"] in APPROVED_EXCEPTION_OWNERS, (
            f"{entry['owner']!r} is not an approved owning team — an individual's "
            "name must never appear here"
        )
