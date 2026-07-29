"""Columnar wire format — lossless, and a transport change only.

The dashboard computes every figure from the records it receives, so an
encoding that loses or reorders anything would corrupt every number on the
page. These tests pin the round trip against the real fixtures.
"""

from __future__ import annotations

import json

import pytest

from api.lib import columnar
from api.lib.build_payload import _build_clean_records, _compact
from api.lib.public_payload import to_public
from tests.test_acted_regression import SIX


@pytest.fixture(scope="module")
def records() -> list[dict]:
    return to_public(_compact(_build_clean_records(list(SIX.values()))))


def test_round_trip_is_exact(records):
    assert columnar.decode(columnar.encode(records)) == records


def test_order_is_preserved(records):
    """Order carries meaning downstream — "first record seen for this site"
    supplies site metadata in several rollups."""
    decoded = columnar.decode(columnar.encode(records))
    assert [r.get("submissionUuid") for r in decoded] == [r.get("submissionUuid") for r in records]


def test_list_valued_fields_survive(records):
    """reasonCodes is a list and repeats heavily, so it is dictionary-encoded
    via its JSON form. Getting that wrong would silently merge distinct code
    sets."""
    encoded = columnar.encode(records)
    assert "reasonCodes" in encoded["dict"], "reasonCodes should be dictionary-encoded"
    decoded = columnar.decode(encoded)
    assert [r.get("reasonCodes") for r in decoded] == [r.get("reasonCodes") for r in records]


def test_empty_record_set_round_trips():
    assert columnar.decode(columnar.encode([])) == []


def test_absent_keys_stay_absent():
    """A missing key must not come back as an explicit null: the payload is
    compacted precisely to remove those, and re-adding them would undo it."""
    source = [{"a": 1}, {"b": 2}]
    decoded = columnar.decode(columnar.encode(source))
    assert decoded == source
    assert "b" not in decoded[0] and "a" not in decoded[1]


def test_high_cardinality_fields_are_not_dictionary_encoded():
    """A dictionary over near-unique values is pure overhead."""
    over_limit = columnar._MAX_DICT_ENTRIES + 10
    source = [{"uuid": f"id-{i}"} for i in range(over_limit)]
    encoded = columnar.encode(source)
    assert "uuid" not in encoded["dict"]
    assert columnar.decode(encoded) == source


def test_an_unknown_format_is_refused_rather_than_guessed():
    with pytest.raises(ValueError, match="unsupported record encoding"):
        columnar.decode({"format": "something/else", "n": 0, "dict": {}, "cols": {}})


def test_the_encoding_is_actually_smaller(records):
    rows = len(json.dumps(records, separators=(",", ":")))
    cols = len(json.dumps(columnar.encode(records), separators=(",", ":")))
    assert cols < rows, "the whole point is that it is smaller"
