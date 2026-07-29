"""The committed public payload artefact is re-verified on every push.

data/public-payload.json is what every visitor actually downloads, so the
protections that gate the API must hold for the file too — and they must hold
for every DAILY refresh commit, which is why this runs in CI rather than only
at build time. A regression in the builder would otherwise ship silently the
next morning at 03:00 UTC.
"""

from __future__ import annotations

import json
import os

import pytest

from api.lib import columnar
from api.lib.field_classification import personal_data_hits, unclassified_fields
from api.lib.public_payload import assert_no_site_identity

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "data", "public-payload.json")


@pytest.fixture(scope="module")
def payload() -> dict:
    assert os.path.isfile(PATH), (
        "data/public-payload.json is missing. Build it with "
        "`python scripts/build_static_payload.py` — the dashboard serves this "
        "file as its primary data source."
    )
    with open(PATH, encoding="utf-8") as fh:
        return json.load(fh)


@pytest.fixture(scope="module")
def records(payload) -> list[dict]:
    return columnar.decode(payload["records"])


def test_the_artefact_is_public_tier_and_columnar(payload):
    assert payload.get("tier") == "public"
    assert payload.get("encoding") == columnar.FORMAT
    assert payload.get("generatedAt"), "the stale banner depends on this"
    assert payload.get("metrics"), "the API contract carries the headline metrics"


def test_the_artefact_carries_no_site_identity(records):
    assert records, "an empty artefact must never be committed"
    assert_no_site_identity(records)


def test_the_artefact_carries_no_personal_data(records):
    assert unclassified_fields(records) == set()
    assert personal_data_hits(records) == []


def test_no_free_text_fields_survive(records):
    for record in records[:5000]:
        assert "activity" not in record
        assert "service" not in record
