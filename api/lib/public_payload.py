"""Public-tier payload: coverage analytics without site identity.

The dashboard is a coordination tool for the humanitarian community in Somalia,
so it should be open. What must not be open is the combination the July 2026
review quantified: 1,905 named sites, 1,792 exact coordinates, and 874 of those
sites publicly flagged as having no protection or site-management actor. Names
plus coordinates plus "nobody is watching this place" is the part that is
exploitable, and no amount of personal-data scrubbing touches it.

The trick is that none of the analytics actually need site IDENTITY — they need
site IDENTIFIABILITY, i.e. the ability to tell one site's records apart from
another's so a site reporting in three months is not counted three times. So
every site gets an opaque reference and keeps its analytical behaviour, while
its name, code and coordinates never leave the server.

Why the salt is random per build
--------------------------------
A hash of a site code with a fixed or guessable salt is reversible by anyone
holding the master list — and the master list circulates widely. A fresh random
salt each build makes the reference meaningless outside the payload it appears
in. Nothing needs it to be stable across builds: every figure the dashboard
draws is computed within a single payload.

The cost is that a public reference cannot be used to correlate across days.
That is a feature here, not a limitation.
"""

from __future__ import annotations

import hashlib
import secrets

# Identity and precise location. Never present in the public tier.
_IDENTIFYING = (
    "matchedSiteCode",
    "matchedSiteName",
    "siteCodeRaw",
    "siteNameRaw",
    "latitude",
    "longitude",
    "matchDistanceMeters",
)

# Audit lineage back to an individual submission. Useful to a partner working a
# reconciliation queue, meaningless and unnecessary to a public reader.
_LINEAGE = (
    "sourceId",
    "sourceRootUuid",
    "sourceVersion",
    "reconciliationStatus",
    "reconciliationOwner",
    "reconciliationNote",
    "dataQualityStatus",
)

# Fields that LOOK identifying but are not, and that the analytics depend on:
#   matchStatus     a method name ("matched_by_site_code"), carries no location.
#                   Dropping it collapses every official-population KPI to zero,
#                   because the semantic layer uses it to decide which cells
#                   count as verified.
#   submissionUuid  an opaque key used to count each assessment once.
_RETAINED_OPAQUE = ("matchStatus", "submissionUuid")


def _new_salt() -> bytes:
    return secrets.token_bytes(32)


def site_reference(site_key: str, salt: bytes) -> str:
    """Opaque, stable-within-a-build reference for one site."""
    digest = hashlib.sha256(salt + site_key.encode("utf-8")).hexdigest()
    return "s-" + digest[:16]


def to_public(records: list[dict], salt: bytes | None = None) -> list[dict]:
    """Strip site identity and lineage, preserving analytical grain.

    Records with no site at all (district- and catchment-level assessments)
    pass through unchanged apart from the field removal — they never had a site
    to protect.
    """
    salt = salt if salt is not None else _new_salt()
    out: list[dict] = []
    for record in records:
        # Same precedence the client's siteKey() uses, so the grouping produced
        # here is exactly the grouping the dashboard would have produced itself.
        raw_key = record.get("matchedSiteCode") or record.get("siteCodeRaw") or ""
        public = {k: v for k, v in record.items() if k not in _IDENTIFYING and k not in _LINEAGE}
        if raw_key:
            public["siteRef"] = site_reference(str(raw_key), salt)
        out.append(public)
    return out


def assert_no_site_identity(records: list[dict]) -> None:
    """Fail the build if anything identifying survived.

    Deliberately checks by VALUE as well as by field name: a site code copied
    into a differently-named field would pass a name-only check.
    """
    present = set()
    for record in records:
        present.update(record.keys())
    leaked = present & (set(_IDENTIFYING) | set(_LINEAGE))
    if leaked:
        raise AssertionError(
            "Public payload still carries site identity or lineage: " + ", ".join(sorted(leaked))
        )

    for index, record in enumerate(records):
        for key, value in record.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                # A latitude or longitude smuggled into another numeric field.
                # Somalia spans roughly -2..12 N, 41..52 E; coordinates are the
                # only fields with fractional degrees in that range.
                if key not in ("households", "individuals") and isinstance(value, float):
                    if -2 <= value <= 12.5 or 40 <= value <= 52:
                        raise AssertionError(
                            f"record[{index}].{key} holds a value in Somalia's coordinate range"
                        )
            elif isinstance(value, str) and value.upper().startswith("CCCM-SO"):
                raise AssertionError(f"record[{index}].{key} holds a CCCM site code")
