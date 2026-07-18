"""Match a Kobo submission's site reference against the CCCM master site
list, following the priority chain used by the Incident Reporting Dashboard:

1. Exact CCCM Site ID
2. Exact official site name
3. Approved alternative site name
4. GPS proximity (within SITE_MATCH_DISTANCE_METERS)
5. Normalized fuzzy name match
6. Unmatched -> flagged for manual review, never auto-created as a new site.

Name matching (tiers 2/3/5) is DISAMBIGUATED by geography. IDP site names
repeat heavily across the country — ~12% of master sites share their name
with at least one other site ("Tawakal" occurs 13 times, "Badbaado" 10) — so
a name alone is not a unique key. When a name resolves to more than one master
site the matcher narrows by the submission's district first, then by nearest
coordinates; if it still can't single one out it returns "probable_name_match"
(Needs Review) rather than silently binding to an arbitrary same-named site.
This matters most for ZiteManager records, which match by name only (no ID,
no GPS).

DO NOT try to derive a master Site ID from a field-tool id by parsing. Codes
like CCCM-BDA-SO2401-01-0028 or ACTEDSO2401_36 embed a sub-area segment, and
their trailing number is a sequence WITHIN that sub-area, not the master
sequence. Extracting (pcode, trailing number) was measured against the live
payload and mapped 1,990 records onto the wrong site with 0/141 site-name
agreement — e.g. CCCM-BDA-SO2401-01-0028 ("Makuuda 1") resolves to the master's
CCCM-SO2401-0028, which is "Al Aamin". A district check does NOT catch this,
because both sites sit in the same district. These ids are left to the name
tiers, which match them correctly. A real crosswalk table from the cluster is
the only safe way to key off them.
"""

from __future__ import annotations

import csv
import difflib
import json
import math
import re
from dataclasses import dataclass
from functools import lru_cache

from api.lib import settings

_FUZZY_MATCH_THRESHOLD = 0.82


@dataclass
class MasterSite:
    cccm_site_id: str
    site_name: str
    alternative_names: list[str]
    region: str
    district: str
    catchment: str | None
    latitude: float | None
    longitude: float | None
    households: int | None
    individuals: int | None


@dataclass
class MatchResult:
    site: MasterSite | None
    match_status: str
    match_distance_meters: float | None


def _normalize_name(name: str) -> str:
    return " ".join(str(name).strip().lower().split())


def _strip_temp_marker(site_id: str) -> str:
    """Fold a CCCM Site ID to a temporary-marker-insensitive key.

    ~40% of master sites carry a TEMPORARY id ("pending Site ID Generator
    registration"), written CCCM-SO2501-T0071. The Site ID Generator the field
    teams collect with issues that SAME site's id WITHOUT the T (CCCM-SO2501-
    0071), so the two never string-equal and the record lands as Unmatched
    despite being a confident code match. Dropping the leading T on the trailing
    sequence makes the two forms converge on one key. Verified collision-free
    against the current master list (no permanent id equals any temp id's
    stripped form), so this can never merge two different sites."""
    return re.sub(r"-T(\d+)$", r"-\1", str(site_id).strip().upper())




def _canonical_district(name: str | None) -> str:
    """Fold a submission's district name to the master list's spelling (the
    same alias table load_master_sites applies), so district disambiguation
    compares like with like (e.g. 'Baydhaba' -> 'Baidoa'). Imported lazily to
    keep the module dependency one-way (see load_master_sites)."""
    from api.lib.transformations import canonical_name

    return canonical_name("district", name) or ""


def _haversine_meters(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class MasterSiteIndex:
    def __init__(self, sites: list[MasterSite], code_crosswalk: dict[str, str] | None = None):
        self.sites = sites
        self.by_id = {s.cccm_site_id.strip().upper(): s for s in sites if s.cccm_site_id}
        # Curated form-code -> master-id crosswalk (data/site-code-crosswalk.json,
        # generated from the Kobo form's site.csv by NAME+DISTRICT resolution —
        # see scripts/build_site_code_crosswalk.py). Exact-string lookups only.
        self.code_crosswalk = {
            str(k).strip().upper(): str(v).strip().upper()
            for k, v in (code_crosswalk or {}).items()
        }
        # Temporary-marker-insensitive id index (CCCM-SO2501-T0071 also reachable
        # as CCCM-SO2501-0071 — the form field teams collect with). Only keys
        # that resolve to exactly one master site are kept, so an unlucky future
        # master list that DID contain a permanent/temp clash can never produce
        # a wrong match here — such a key is simply dropped from the fallback.
        _norm_groups: dict[str, list[MasterSite]] = {}
        for s in sites:
            if s.cccm_site_id:
                _norm_groups.setdefault(_strip_temp_marker(s.cccm_site_id), []).append(s)
        self.by_id_normalized = {k: v[0] for k, v in _norm_groups.items() if len(v) == 1}
        # Name buckets hold EVERY site sharing a normalized name (not first-wins)
        # so an ambiguous name can be disambiguated by geography instead of
        # silently collapsing to whichever row was read first.
        self.by_name: dict[str, list[MasterSite]] = {}
        self.by_alt_name: dict[str, list[MasterSite]] = {}
        for s in sites:
            if s.site_name:
                self.by_name.setdefault(_normalize_name(s.site_name), []).append(s)
            for alt in s.alternative_names:
                if alt:
                    self.by_alt_name.setdefault(_normalize_name(alt), []).append(s)

        # Sites with coordinates only, for the GPS-proximity tier.
        self._geo_sites = [s for s in sites if s.latitude is not None and s.longitude is not None]
        # Every distinct normalized name, for the fuzzy tier — built once so
        # get_close_matches (which internally short-circuits far worse
        # matches much faster than calling .ratio() on all 6.8k sites
        # one-by-one) has a flat list to search instead of re-deriving it.
        self._all_normalized_names = list(self.by_name.keys())

        # A submission's (site_id, site_name, lat, lon, district) repeats across
        # reporting periods for the same site — memoizing match() avoids
        # redoing the expensive GPS/fuzzy scans for input already seen.
        self._match_cache: dict[tuple, MatchResult] = {}

    def match(
        self,
        site_id_raw: str | None,
        site_name_raw: str | None,
        lat: float | None,
        lon: float | None,
        district: str | None = None,
    ) -> MatchResult:
        cache_key = (site_id_raw, site_name_raw, lat, lon, district)
        cached = self._match_cache.get(cache_key)
        if cached is not None:
            return cached

        result = self._match_uncached(site_id_raw, site_name_raw, lat, lon, district)
        self._match_cache[cache_key] = result
        return result

    def _disambiguate(
        self, candidates: list[MasterSite], district: str | None, lat: float | None, lon: float | None
    ) -> MasterSite | None:
        """From several master sites sharing a name, return the single best one
        using district then nearest coordinates — or None if still ambiguous."""
        if len(candidates) == 1:
            return candidates[0]

        if district:
            wanted = _normalize_name(_canonical_district(district))
            same_district = [c for c in candidates if _normalize_name(c.district) == wanted]
            if len(same_district) == 1:
                return same_district[0]
            if same_district:
                candidates = same_district  # narrowed; break the remaining tie by distance

        if lat is not None and lon is not None:
            geo = [c for c in candidates if c.latitude is not None and c.longitude is not None]
            if geo:
                return min(geo, key=lambda c: _haversine_meters(lat, lon, c.latitude, c.longitude))

        return None

    def _match_uncached(
        self,
        site_id_raw: str | None,
        site_name_raw: str | None,
        lat: float | None,
        lon: float | None,
        district: str | None,
    ) -> MatchResult:
        if site_id_raw:
            raw = str(site_id_raw).strip().upper()
            site = self.by_id.get(raw)
            if site:
                return MatchResult(site, "matched_by_site_code", None)
            # Same site, temporary vs permanent id spelling (…-T0071 vs …-0071).
            site = self.by_id_normalized.get(_strip_temp_marker(raw))
            if site:
                return MatchResult(site, "matched_by_site_code", None)
            # Curated crosswalk: the Kobo form's site.csv keys some sites by
            # codes the master list doesn't use (ACTEDSO…, stale codes). Each
            # entry was pre-verified by name+district, so this is a confident
            # code match — exact string lookup, no parsing.
            target = self.code_crosswalk.get(raw)
            if target:
                site = self.by_id.get(target) or self.by_id_normalized.get(_strip_temp_marker(target))
                if site:
                    return MatchResult(site, "matched_by_site_code", None)
            # NOTE: field-tool ids that embed a sub-area segment
            # (CCCM-BDA-SO2401-01-0028, ACTEDSO2401_36) are deliberately NOT
            # parsed into a master id here — see _canonical_site_key's removal
            # note in the module docstring. Their trailing number is a
            # within-sub-area sequence, not the master sequence, so deriving a
            # master id from them silently binds records to the wrong site.
            # They fall through to the name tiers, which resolve them correctly.

        if site_name_raw:
            normalized = _normalize_name(site_name_raw)
            for bucket, status in ((self.by_name, "matched_by_official_name"),
                                   (self.by_alt_name, "matched_by_alternative_name")):
                candidates = bucket.get(normalized)
                if candidates:
                    site = self._disambiguate(candidates, district, lat, lon)
                    if site is not None:
                        return MatchResult(site, status, None)
                    # Name is real but points at >1 site and we can't tell which:
                    # flag for human review instead of guessing a confident match.
                    return MatchResult(candidates[0], "probable_name_match", None)

        if lat is not None and lon is not None:
            best_site, best_dist = None, None
            for s in self._geo_sites:
                dist = _haversine_meters(lat, lon, s.latitude, s.longitude)
                if best_dist is None or dist < best_dist:
                    best_site, best_dist = s, dist
            if best_site is not None and best_dist <= settings.SITE_MATCH_DISTANCE_METERS:
                return MatchResult(best_site, "matched_by_gps", round(best_dist, 1))

        if site_name_raw:
            normalized = _normalize_name(site_name_raw)
            close = difflib.get_close_matches(normalized, self._all_normalized_names, n=1, cutoff=_FUZZY_MATCH_THRESHOLD)
            if close:
                candidates = self.by_name[close[0]]
                site = self._disambiguate(candidates, district, lat, lon) or candidates[0]
                # GPS corroboration: the typed name approximately matches THIS
                # site AND the submission's coordinates land near it — two
                # independent signals agreeing on the same site. That is
                # confident evidence, not a guess, so it graduates out of
                # Needs Review. (Any record reaching this tier is already
                # >SITE_MATCH_DISTANCE_METERS from every master site, so the
                # blind-GPS tier could not have caught it.)
                if lat is not None and lon is not None and site.latitude is not None:
                    dist = _haversine_meters(lat, lon, site.latitude, site.longitude)
                    if dist <= settings.SITE_NAME_GPS_CONFIRM_METERS:
                        return MatchResult(site, "matched_by_name_gps", round(dist, 1))
                # Fuzzy match alone stays uncertain by definition -> Needs Review.
                return MatchResult(site, "probable_name_match", None)

        return MatchResult(None, "unmatched", None)


def load_master_sites(csv_path: str) -> list[MasterSite]:
    # Import here to avoid a circular import (transformations imports nothing
    # from this module, but keeping the dependency direction one-way).
    from api.lib.transformations import canonical_name

    sites = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            alt_names = [n for n in (row.get("alternative_names") or "").split("|") if n]
            sites.append(
                MasterSite(
                    cccm_site_id=row.get("cccm_site_id", ""),
                    site_name=row.get("site_name", ""),
                    alternative_names=alt_names,
                    region=canonical_name("region", row.get("region", "")),
                    district=canonical_name("district", row.get("district", "")),
                    catchment=row.get("catchment") or None,
                    latitude=float(row["latitude"]) if row.get("latitude") else None,
                    longitude=float(row["longitude"]) if row.get("longitude") else None,
                    households=int(float(row["households"])) if row.get("households") else None,
                    individuals=int(float(row["individuals"])) if row.get("individuals") else None,
                )
            )
    return sites


def _load_code_crosswalk(path: str = "data/site-code-crosswalk.json") -> dict[str, str]:
    """Optional curated form-code -> master-id map; absent file means no
    crosswalk tier (the matcher works without it)."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("entries", {})
    except FileNotFoundError:
        return {}


@lru_cache(maxsize=1)
def get_master_site_index(csv_path: str = "data/master-sites.csv") -> MasterSiteIndex:
    """Cached for the lifetime of the serverless function instance — avoids
    re-parsing the ~6.8k-row CSV on every request within the same warm
    container."""
    return MasterSiteIndex(load_master_sites(csv_path), code_crosswalk=_load_code_crosswalk())
