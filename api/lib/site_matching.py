"""Match a Kobo submission's site reference against the CCCM master site
list, following the priority chain used by the Incident Reporting Dashboard:

1. Exact CCCM Site ID
2. Exact official site name
3. Approved alternative site name
4. GPS proximity (within SITE_MATCH_DISTANCE_METERS)
5. Normalized fuzzy name match
6. Unmatched -> flagged for manual review, never auto-created as a new site.
"""

from __future__ import annotations

import csv
import difflib
import math
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


def _haversine_meters(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class MasterSiteIndex:
    def __init__(self, sites: list[MasterSite]):
        self.sites = sites
        self.by_id = {s.cccm_site_id.strip().upper(): s for s in sites if s.cccm_site_id}
        self.by_name: dict[str, MasterSite] = {}
        self.by_alt_name: dict[str, MasterSite] = {}
        for s in sites:
            if s.site_name:
                self.by_name.setdefault(_normalize_name(s.site_name), s)
            for alt in s.alternative_names:
                if alt:
                    self.by_alt_name.setdefault(_normalize_name(alt), s)

        # Sites with coordinates only, for the GPS-proximity tier.
        self._geo_sites = [s for s in sites if s.latitude is not None and s.longitude is not None]
        # Every distinct normalized name, for the fuzzy tier — built once so
        # get_close_matches (which internally short-circuits far worse
        # matches much faster than calling .ratio() on all 6.8k sites
        # one-by-one) has a flat list to search instead of re-deriving it.
        self._all_normalized_names = list(self.by_name.keys())

        # A submission's (site_id, site_name, lat, lon) repeats across
        # reporting periods for the same site — memoizing match() avoids
        # redoing the expensive GPS/fuzzy scans for input already seen.
        self._match_cache: dict[tuple, MatchResult] = {}

    def match(self, site_id_raw: str | None, site_name_raw: str | None, lat: float | None, lon: float | None) -> MatchResult:
        cache_key = (site_id_raw, site_name_raw, lat, lon)
        cached = self._match_cache.get(cache_key)
        if cached is not None:
            return cached

        result = self._match_uncached(site_id_raw, site_name_raw, lat, lon)
        self._match_cache[cache_key] = result
        return result

    def _match_uncached(
        self, site_id_raw: str | None, site_name_raw: str | None, lat: float | None, lon: float | None
    ) -> MatchResult:
        if site_id_raw:
            site = self.by_id.get(str(site_id_raw).strip().upper())
            if site:
                return MatchResult(site, "matched_by_site_code", None)

        if site_name_raw:
            normalized = _normalize_name(site_name_raw)
            site = self.by_name.get(normalized)
            if site:
                return MatchResult(site, "matched_by_official_name", None)
            site = self.by_alt_name.get(normalized)
            if site:
                return MatchResult(site, "matched_by_alternative_name", None)

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
                return MatchResult(self.by_name[close[0]], "probable_name_match", None)

        return MatchResult(None, "unmatched", None)


def load_master_sites(csv_path: str) -> list[MasterSite]:
    sites = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            alt_names = [n for n in (row.get("alternative_names") or "").split("|") if n]
            sites.append(
                MasterSite(
                    cccm_site_id=row.get("cccm_site_id", ""),
                    site_name=row.get("site_name", ""),
                    alternative_names=alt_names,
                    region=row.get("region", ""),
                    district=row.get("district", ""),
                    catchment=row.get("catchment") or None,
                    latitude=float(row["latitude"]) if row.get("latitude") else None,
                    longitude=float(row["longitude"]) if row.get("longitude") else None,
                    households=int(float(row["households"])) if row.get("households") else None,
                    individuals=int(float(row["individuals"])) if row.get("individuals") else None,
                )
            )
    return sites


@lru_cache(maxsize=1)
def get_master_site_index(csv_path: str = "data/master-sites.csv") -> MasterSiteIndex:
    """Cached for the lifetime of the serverless function instance — avoids
    re-parsing the ~6.8k-row CSV on every request within the same warm
    container."""
    return MasterSiteIndex(load_master_sites(csv_path))
