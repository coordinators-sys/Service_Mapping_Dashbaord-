"""Columnar, dictionary-encoded wire format for the record set.

Why
---
The dashboard ships every record to the browser because every figure is
computed client-side from them. On a 3G connection in Baidoa that was ~11
seconds of payload before anything appeared, and 18.7 MB to decompress and
JSON.parse on a phone CPU.

Row-shaped JSON is a bad fit for this data for two reasons:

1. Every row repeats every key name. 36,381 rows x ~20 keys is several
   megabytes of the word "reportingPeriod".
2. Almost every field is low-cardinality — 44 districts, 11 sectors, 3 coverage
   statuses — but each value is written out in full on every row.

Storing each field as one array, with repeated values replaced by an index into
a per-field dictionary, removes both. Measured on the live payload: 522 KB ->
223 KB on the wire, 18.7 MB -> 3.4 MB to parse.

This is a TRANSPORT change only. It is lossless and exactly reversible: the
client reconstructs the identical record objects before anything reads them, so
no aggregation, filter or export had to change.

Fields whose values are nearly all distinct (uuids, timestamps) are stored as
plain arrays — a dictionary would be pure overhead there.
"""

from __future__ import annotations

import json

FORMAT = "columnar/1"

# Above this many distinct values a dictionary costs more than it saves.
_MAX_DICT_ENTRIES = 4096


def encode(records: list[dict]) -> dict:
    """Row-shaped records -> {"format", "n", "dict", "cols"}."""
    keys = sorted({k for record in records for k in record})
    dictionaries: dict[str, list] = {}
    columns: dict[str, list] = {}

    for key in keys:
        values = [record.get(key) for record in records]
        # Hash on the JSON form so unhashable values (lists such as reasonCodes)
        # dictionary-encode too — they repeat heavily and are worth the saving.
        encoded = [json.dumps(v, separators=(",", ":"), sort_keys=True) for v in values]
        distinct = sorted(set(encoded))
        if len(distinct) <= _MAX_DICT_ENTRIES:
            index = {value: position for position, value in enumerate(distinct)}
            dictionaries[key] = [json.loads(value) for value in distinct]
            columns[key] = [index[value] for value in encoded]
        else:
            columns[key] = values

    return {"format": FORMAT, "n": len(records), "dict": dictionaries, "cols": columns}


def decode(payload: dict) -> list[dict]:
    """Inverse of encode. Used by the tests to prove the round trip, and it
    mirrors what assets/js/columnar.js does in the browser."""
    if payload.get("format") != FORMAT:
        raise ValueError(f"unsupported record encoding: {payload.get('format')!r}")

    count = payload["n"]
    dictionaries = payload.get("dict", {})
    columns = payload.get("cols", {})
    records: list[dict] = [{} for _ in range(count)]

    for key, column in columns.items():
        lookup = dictionaries.get(key)
        for position in range(count):
            value = lookup[column[position]] if lookup is not None else column[position]
            # A key absent from a record and a key present as null are the same
            # thing to every reader (all checks are `== null` or defaulted), and
            # re-adding the nulls would undo the compaction that precedes this.
            if value is not None:
                records[position][key] = value

    return records
