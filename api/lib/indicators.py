"""Pure indicator-calculation functions.

No framework dependency — every function here operates on plain values so
it's directly unit-testable with hand-built inputs (see tests/test_indicators.py).
This is what lets the dashboard KPIs be trusted rather than eyeballed.

Every function operationalizes one of the "DATA DEFINITIONS" in the project
spec. In particular: blank/unknown responses are never counted as "No" —
coverage_from_counts' denominator explicitly excludes unknown rows.
"""

from __future__ import annotations

from dataclasses import dataclass

from api.lib import settings


@dataclass(frozen=True)
class CoverageResult:
    covered: int
    not_covered: int
    unknown: int
    total_assessed: int  # covered + not_covered + unknown
    reportable_total: int  # covered + not_covered (denominator for pct)
    coverage_pct: float | None  # None when reportable_total == 0

    def label(self) -> str:
        if self.reportable_total == 0:
            return f"{self.covered} of 0 assessed sites reportable, no data"
        return f"{self.covered} of {self.reportable_total} assessed sites covered, {self.coverage_pct:.1f}%"


def coverage_from_counts(covered: int, not_covered: int, unknown: int) -> CoverageResult:
    reportable_total = covered + not_covered
    coverage_pct = (covered / reportable_total * 100) if reportable_total > 0 else None
    return CoverageResult(
        covered=covered,
        not_covered=not_covered,
        unknown=unknown,
        total_assessed=covered + not_covered + unknown,
        reportable_total=reportable_total,
        coverage_pct=coverage_pct,
    )


def coverage_from_statuses(statuses: list[str]) -> CoverageResult:
    covered = sum(1 for s in statuses if s == "covered")
    not_covered = sum(1 for s in statuses if s == "not_covered")
    unknown = sum(1 for s in statuses if s == "unknown")
    return coverage_from_counts(covered, not_covered, unknown)


def period_over_period_change(current: float | None, previous: float | None) -> float | None:
    """Percentage-point change for indicators expressed as a percentage."""
    if current is None or previous is None:
        return None
    return round(current - previous, 2)


def data_completeness_rate(populated_fields: int, expected_fields: int) -> float | None:
    if expected_fields <= 0:
        return None
    return round(populated_fields / expected_fields * 100, 1)


@dataclass(frozen=True)
class PriorityScoreInputs:
    gap_score: float  # 0-100, share of priority sectors NOT covered
    population_score: float  # 0-100, normalized population percentile
    data_freshness_score: float  # 0-100, higher = staler data
    flood_risk_score: float  # 0-100, higher = more exposed
    agency_capacity_score: float  # 0-100, higher = fewer agencies present


def priority_score(inputs: PriorityScoreInputs, weights: dict | None = None) -> float:
    """Weighted composite priority score (0-100, higher = more urgent).

    Weights default to settings.PRIORITY_WEIGHTS and are meant to be
    admin-configurable. The methodology is intentionally transparent —
    surface `weights` in the methodology panel rather than hiding it.
    """
    w = weights or settings.PRIORITY_WEIGHTS
    return round(
        w["service_gap"] * inputs.gap_score
        + w["population"] * inputs.population_score
        + w["data_freshness"] * inputs.data_freshness_score
        + w["flood_risk"] * inputs.flood_risk_score
        + w["agency_capacity"] * inputs.agency_capacity_score,
        2,
    )


def normalize_percentile(value: float, min_value: float, max_value: float) -> float:
    """Scale a raw value to 0-100 given the observed min/max in the current filter set."""
    if max_value <= min_value:
        return 0.0
    return round(max(0.0, min(1.0, (value - min_value) / (max_value - min_value))) * 100, 2)


def days_since(reference_date, as_of_date) -> int | None:
    if reference_date is None:
        return None
    return (as_of_date - reference_date).days
