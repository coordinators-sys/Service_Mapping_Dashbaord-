"""Validation → publication policy.

Every ingested submission must end in exactly ONE explicit terminal state, with
a machine-readable reason code, a human-readable explanation and a severity.
Nothing is ever silently dropped: a record that cannot be published is
quarantined and stays visible in the review queue.

Terminal states
---------------
published                 no blocking issue
published_with_warning    representable accurately, but a child reference is
                          unresolved (e.g. catchment missing on a catchment
                          assessment) — shown, flagged, never guessed
quarantined               cannot be represented without misleading the reader
superseded                a newer version of the same logical submission exists
rejected                  structurally unusable (no logical key at all)

Severity → policy
-----------------
critical  quarantine
high      quarantine
medium    publish with warning
low       publish and log
"""

from __future__ import annotations

# reason code -> (severity, human-readable explanation)
REASON_CODES: dict[str, tuple[str, str]] = {
    "MISSING_REQUIRED_CATCHMENT": (
        "medium",
        "Reported at catchment level but no catchment was supplied in the source. "
        "The assessment is shown in its district context; the catchment is left "
        "empty rather than guessed.",
    ),
    "UNRESOLVED_CATCHMENT": (
        "medium",
        "The submitted catchment value could not be matched to a known catchment "
        "in this district. The raw value is retained for review.",
    ),
    "UNRESOLVED_SITE": (
        "medium",
        "Reported at site level, but the submitted site reference does not match "
        "the CCCM master site list. The record is retained for reconciliation and "
        "excluded from master-list site coverage.",
    ),
    "MISSING_SITE_REFERENCE": (
        "high",
        "Reported at site level but carries no site code or site name, so it "
        "cannot be tied to any location.",
    ),
    "UNKNOWN_REPORTING_LEVEL": (
        "high",
        "The reporting level is missing or not one of District / Catchment / Site, "
        "so the analytical grain of the record is undefined.",
    ),
    "UNRESOLVED_DISTRICT": (
        "high",
        "The submitted district code is not a known administrative unit.",
    ),
    "MISSING_DISTRICT": (
        "high",
        "No district was supplied, so the record cannot be placed geographically.",
    ),
    "NO_LOGICAL_KEY": (
        "critical",
        "The submission carries no usable identifier, so it cannot be versioned or "
        "de-duplicated.",
    ),
    "REPORTING_LEVEL_INFERRED": (
        "low",
        "The submission did not state a reporting level, but names a specific "
        "site, so it is treated as a site-level observation. Recorded explicitly "
        "rather than assumed.",
    ),
    "SUPERSEDED_VERSION": (
        "low",
        "A newer version of this submission exists. Retained for audit; excluded "
        "from current figures.",
    ),
}

_SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}
_SEVERITY_TO_STATE = {
    "low": "published",
    "medium": "published_with_warning",
    "high": "quarantined",
    "critical": "quarantined",
}


def severity_of(code: str) -> str:
    return REASON_CODES.get(code, ("high", ""))[0]


def explain(code: str) -> str:
    return REASON_CODES.get(code, ("high", "Unrecognised validation reason code."))[1]


def classify(reason_codes: list[str]) -> tuple[str, str]:
    """(publication_status, highest_severity) for a set of reason codes."""
    if not reason_codes:
        return "published", "none"
    worst = max(reason_codes, key=lambda c: _SEVERITY_RANK.get(severity_of(c), 2))
    severity = severity_of(worst)
    return _SEVERITY_TO_STATE.get(severity, "quarantined"), severity


def evaluate(
    *,
    scope_type: str | None,
    scope_inferred: bool = False,
    district: str | None = None,
    district_resolved: bool,
    catchment_raw: str | None,
    catchment_resolved: bool,
    site_reference: str | None,
    site_matched: bool,
    has_logical_key: bool,
) -> list[str]:
    """Reason codes for one submission, evaluated at its DECLARED grain.

    A district assessment is complete without a catchment or a site; only the
    identifiers required by its own grain are checked. This is what stops valid
    area-level assessments being treated as failed site matches.
    """
    codes: list[str] = []

    if not has_logical_key:
        codes.append("NO_LOGICAL_KEY")

    if scope_type not in ("district", "catchment", "site"):
        codes.append("UNKNOWN_REPORTING_LEVEL")
    elif scope_inferred:
        codes.append("REPORTING_LEVEL_INFERRED")

    if not district:
        codes.append("MISSING_DISTRICT")
    elif not district_resolved:
        codes.append("UNRESOLVED_DISTRICT")

    if scope_type == "catchment":
        if not catchment_raw:
            codes.append("MISSING_REQUIRED_CATCHMENT")
        elif not catchment_resolved:
            codes.append("UNRESOLVED_CATCHMENT")

    if scope_type == "site":
        if not site_reference:
            codes.append("MISSING_SITE_REFERENCE")
        elif not site_matched:
            codes.append("UNRESOLVED_SITE")

    return codes
