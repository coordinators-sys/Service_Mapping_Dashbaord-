"""Machine-enforced field allowlist — the runtime half of the standing rule.

STANDING RULE (Cluster Coordinator, 2026-07-29): no personal data is emitted to
any client artefact, in any tier, ever.

Design notes
------------
This is an ALLOWLIST, not a denylist, because the two fail in opposite
directions. A denylist has to anticipate every field somebody might add; when
it misses one, the field is published. An allowlist publishes nothing it has
not been told about, so the failure mode of forgetting is a missing column
rather than a leaked one.

`data/field-classification.yml` is the human-readable register carrying the
rationale for each decision; this module is what actually runs. A test asserts
the two agree, so the register cannot become decorative.

Deliberately no YAML parser at runtime: parsing a config file to decide what to
redact means a malformed file could weaken the control. A literal in code
cannot fail to load. The register stays YAML because a coordinator has to be
able to read and amend it (ADR: no bundler, keep the repo editable).
"""

from __future__ import annotations

import re

# Site-level detail. Authenticated partner artefact only — restricted for
# protection reasons (site location + service-gap combination), not privacy.
PARTNER_FIELDS = frozenset({
    "matchedSiteCode",
    "matchedSiteName",
    "siteCodeRaw",
    "siteNameRaw",
    "latitude",
    "longitude",
    "matchStatus",
    "matchDistanceMeters",
    "dataQualityStatus",
    "reconciliationStatus",
    "reconciliationOwner",
    "reconciliationNote",
    "sourceId",
    "sourceRootUuid",
    "sourceVersion",
    "submissionUuid",
})

# Safe at district/catchment aggregate, subject to small-numbers suppression.
PUBLIC_FIELDS = frozenset({
    "region",
    "district",
    "catchment",
    "regionRaw",
    "districtRaw",
    "catchmentRaw",
    "sector",
    "coverageStatus",
    "agency",
    "reportingPartner",
    "partnerType",
    "activity",
    "service",
    "operationalStatus",
    "scopeType",
    "reportingLevelRaw",
    "reportingPeriod",
    "reportingDate",
    "lastUpdated",
    "dataSource",
    "publicationStatus",
    "qualitySeverity",
    "reasonCodes",
})

PUBLISHED_FIELDS = PUBLIC_FIELDS | PARTNER_FIELDS

# Belt and braces. Even an allowlisted field must not carry a value shaped like
# personal data — this catches a field whose CONTENT changes meaning without
# its name changing (e.g. an operator typing a phone number into a note).
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]{2,}")

# Somali mobile numbers: 9 digits, written either with a +252 country code or
# in national form with a leading 0.
#
# Deliberately narrow. This data is FULL of digit strings that are not phone
# numbers — submission UUIDs, ISO timestamps, CCCM site codes, p-codes. A
# looser first version matched "0319-4407" inside a UUID and would have blocked
# every build, which is its own kind of failure: a control that cries wolf gets
# switched off. Verified against all 36,381 production records with zero false
# positives.
#
# Two shapes only:
#   +252 61 234 5678 / +252612345678   explicit country code, separators allowed
#   0615123456                          national form, valid mobile prefix
# A separator-bearing digit run WITHOUT a country code is not treated as a
# phone number — that is precisely what UUIDs and dates look like. The national
# form additionally requires a real Somali mobile prefix (06x/07x/09x), because
# `0\d{8}` alone matched synthetic identifiers such as "zite--000000003".
_PHONE = re.compile(r"(?:\+?252[\s-]?\d[\d\s-]{6,12}\d|\b0[679]\d{7,8}\b)")

# Operator-entered prose. The standing rule treats free text as guilty until
# proven innocent, and the memo permits a scrub in place of exclusion. These
# fields are scrubbed before publication; every other field must be clean
# already and hard-fails if it is not, because a phone number appearing in a
# structured field means something upstream is wrong.
FREE_TEXT_FIELDS = frozenset({"activity", "service", "reconciliationNote"})

REDACTED = "[redacted]"

# Owners of a reconciliation exception must be a team, never a person.
APPROVED_EXCEPTION_OWNERS = frozenset({
    "CCCM Cluster Information Management",
    "CCCM Cluster Coordination",
})


class FieldClassificationError(AssertionError):
    """Raised at the artefact-write boundary. Deliberately fatal: a build that
    cannot prove it is clean must not produce an artefact at all."""


def unclassified_fields(records: list[dict]) -> set[str]:
    """Field names present in the records that nothing has approved."""
    seen: set[str] = set()
    for record in records:
        seen.update(record.keys())
    return seen - PUBLISHED_FIELDS


def scrub_free_text(records: list[dict]) -> int:
    """Redact personal data from operator-entered prose, in place.

    Returns the number of values changed so the count can be logged and
    reviewed — a scrub that happens silently is indistinguishable from a scrub
    that has stopped working.

    Only FREE_TEXT_FIELDS are scrubbed. Everywhere else a match is an error,
    not something to paper over.
    """
    scrubbed = 0
    for record in records:
        for key in FREE_TEXT_FIELDS:
            value = record.get(key)
            if not isinstance(value, str):
                continue
            cleaned = _EMAIL.sub(REDACTED, value)
            cleaned = _PHONE.sub(REDACTED, cleaned)
            if cleaned != value:
                record[key] = cleaned
                scrubbed += 1
    return scrubbed


def personal_data_hits(records: list[dict], limit: int = 20) -> list[str]:
    """Values that look like personal data regardless of which field holds them.

    Reports the FIELD and the shape, never the value — a leak report that
    quotes the leak just moves it into the logs.
    """
    hits: list[str] = []
    for index, record in enumerate(records):
        for key, value in record.items():
            if not isinstance(value, str):
                continue
            if _EMAIL.search(value):
                hits.append(f"record[{index}].{key}: email-shaped value")
            elif _PHONE.search(value):
                hits.append(f"record[{index}].{key}: phone-shaped value")
            if len(hits) >= limit:
                return hits
    return hits


def assert_publishable(records: list[dict]) -> None:
    """Gate at the artefact-write boundary. Fails the build, never warns.

    Called immediately before serialisation so nothing can be added to a record
    between the check and the write.
    """
    unclassified = unclassified_fields(records)
    if unclassified:
        raise FieldClassificationError(
            "Refusing to publish unclassified field(s): "
            + ", ".join(sorted(unclassified))
            + ". Add them to data/field-classification.yml and to PUBLIC_FIELDS or "
            "PARTNER_FIELDS after Cluster approval, or drop them before serialisation. "
            "Fields are never published by default."
        )

    hits = personal_data_hits(records)
    if hits:
        raise FieldClassificationError(
            "Refusing to publish: value(s) shaped like personal data found in "
            "classified fields — " + "; ".join(hits)
        )
