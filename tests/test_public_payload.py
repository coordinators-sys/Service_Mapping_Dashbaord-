"""Public tier: no site identity leaves the server.

The dashboard is open to the humanitarian community, so this is the only thing
standing between an aggregate coverage tool and a public map of which IDP sites
have no protection actor present. It is enforced server-side, before
serialisation — not in the interface, where anyone can read the network
response instead.

The other half of the guarantee is that the analytics are UNCHANGED. A control
that quietly breaks the numbers gets removed by whoever is next under deadline
pressure, so the equivalence is asserted here too.
"""

from __future__ import annotations

import json
import os

import pytest

from api.lib.build_payload import _build_clean_records
from api.lib.public_payload import (
    _IDENTIFYING,
    _LINEAGE,
    assert_no_site_identity,
    site_reference,
    to_public,
)
from tests.test_acted_regression import SIX

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(scope="module")
def records() -> list[dict]:
    return _build_clean_records(list(SIX.values()))


@pytest.fixture(scope="module")
def public(records) -> list[dict]:
    return to_public(records)


# ---------------------------------------------------------------------------
# What must not survive.


@pytest.mark.parametrize("field", _IDENTIFYING)
def test_identifying_fields_are_absent(public, field):
    assert all(field not in record for record in public), f"{field} survived into the public tier"


@pytest.mark.parametrize("field", _LINEAGE)
def test_lineage_fields_are_absent(public, field):
    assert all(field not in record for record in public)


def test_no_cccm_site_code_appears_in_any_value(public):
    """A name-only check would miss a code copied into a differently-named
    field, so the values are checked too."""
    for record in public:
        for key, value in record.items():
            if isinstance(value, str):
                assert not value.upper().startswith("CCCM-SO"), f"{key} carries a site code"


def test_no_coordinates_appear_in_any_value(public):
    """Somalia spans roughly -2..12 N and 41..52 E. No float in that range
    should reach a public record."""
    assert_no_site_identity(public)


def test_the_real_acted_site_references_are_gone(public):
    """The two Laas Caanood references and their recovered names — Adhi Cadeeye
    and Guumays — must not appear anywhere."""
    blob = json.dumps(public)
    for secret in ("ACTEDSO1401_55", "ACTEDSO1401_56", "Adhi Cadeeye", "Guumays"):
        assert secret not in blob, f"{secret!r} leaked into the public tier"


# ---------------------------------------------------------------------------
# What must survive: the ability to tell sites apart.


def test_each_site_gets_a_stable_reference_within_a_build(records):
    public = to_public(records)
    by_raw: dict[str, set[str]] = {}
    for original, published in zip(records, public):
        raw = original.get("matchedSiteCode") or original.get("siteCodeRaw")
        if raw:
            by_raw.setdefault(raw, set()).add(published["siteRef"])
    assert by_raw, "the fixture should contain site-level records"
    for raw, refs in by_raw.items():
        assert len(refs) == 1, f"{raw} received more than one reference in one build"


def test_two_different_sites_never_share_a_reference(records):
    public = to_public(records)
    mapping: dict[str, str] = {}
    for original, published in zip(records, public):
        raw = original.get("matchedSiteCode") or original.get("siteCodeRaw")
        if not raw:
            continue
        ref = published["siteRef"]
        assert mapping.setdefault(ref, raw) == raw, "reference collision between two sites"


def test_the_reference_changes_between_builds(records):
    """A fixed salt would let anyone holding the master list reverse the
    reference, and the master list circulates widely. A fresh salt per build
    makes the reference meaningless outside the payload it appears in."""
    first = to_public(records)
    second = to_public(records)
    refs_a = {r.get("siteRef") for r in first if r.get("siteRef")}
    refs_b = {r.get("siteRef") for r in second if r.get("siteRef")}
    assert refs_a and refs_b
    assert refs_a != refs_b, "the reference is reproducible across builds and therefore reversible"


def test_a_known_salt_makes_the_reference_reproducible():
    """The mechanism itself is deterministic — only the salt is not."""
    salt = b"a fixed salt for testing only"
    assert site_reference("CCCM-SO2401-0001", salt) == site_reference("CCCM-SO2401-0001", salt)
    assert site_reference("CCCM-SO2401-0001", salt) != site_reference("CCCM-SO2401-0002", salt)


def test_area_level_records_pass_through_without_a_reference(records):
    """District and catchment assessments never had a site to protect, and must
    not acquire a spurious one."""
    public = to_public(records)
    area = [p for o, p in zip(records, public) if o.get("scopeType") == "district"]
    assert area, "the fixture contains district-level assessments"
    for record in area:
        assert "siteRef" not in record


# ---------------------------------------------------------------------------
# The analytics must be unchanged.


def test_the_public_tier_preserves_the_analytical_grain(records):
    """Site x sector x period cells are the grain every coverage figure is
    computed on. If the count changes, a percentage somewhere changes with it.
    """
    def cells(rows: list[dict]) -> set[tuple]:
        out = set()
        for r in rows:
            key = r.get("matchedSiteCode") or r.get("siteCodeRaw") or r.get("siteRef")
            if key and r.get("sector") and r.get("reportingPeriod"):
                out.add((key, r["sector"], r["reportingPeriod"], r.get("coverageStatus")))
        return out

    before = cells(records)
    after = cells(to_public(records))
    assert len(before) == len(after), "the public tier changed the number of coverage cells"


def test_match_status_survives_because_the_official_population_depends_on_it(public):
    """matchStatus is a METHOD name, not a location, so it is safe. Dropping it
    would send every official-population KPI to zero, because the semantic
    layer uses it to decide which cells are verified."""
    assert any("matchStatus" in r for r in public)


def test_the_gate_refuses_a_payload_that_still_carries_identity(records):
    leaky = to_public(records)
    leaky[0]["latitude"] = 2.0469
    with pytest.raises(AssertionError, match="latitude"):
        assert_no_site_identity(leaky)


def test_the_gate_catches_a_site_code_hidden_in_another_field(records):
    leaky = to_public(records)
    leaky[0]["activity"] = "CCCM-SO2401-0001"
    with pytest.raises(AssertionError, match="site code"):
        assert_no_site_identity(leaky)
