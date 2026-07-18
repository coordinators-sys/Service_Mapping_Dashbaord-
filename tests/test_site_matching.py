"""Site-matching invariants (api/lib/site_matching.py).

Focus: name matching must be disambiguated by geography. IDP site names repeat
heavily across Somalia, so a bare name is not a unique key — the matcher must
use district / coordinates to pick the right same-named site, and must refuse
to hand out a confident match when it genuinely cannot tell them apart.

    python -m pytest tests/test_site_matching.py -q
"""

from __future__ import annotations

from api.lib.site_matching import MasterSite, MasterSiteIndex


def site(sid, name, district, lat=None, lon=None, region="R", alt=None):
    return MasterSite(
        cccm_site_id=sid, site_name=name, alternative_names=alt or [],
        region=region, district=district, catchment=None,
        latitude=lat, longitude=lon, households=None, individuals=None,
    )


# Two real-world collisions: same name, different districts/coords.
TAWAKAL_A = site("CCCM-SO2401-0001", "Tawakal", "Daynile", 2.05, 45.25)
TAWAKAL_B = site("CCCM-SO2802-0045", "Tawakal", "Kismaayo", -0.35, 42.55)
UNIQUE = site("CCCM-SO1601-0019", "Horseed", "Gaalkacyo", 6.77, 47.43)
INDEX = MasterSiteIndex([TAWAKAL_A, TAWAKAL_B, UNIQUE])


def test_site_id_beats_everything():
    r = INDEX.match("CCCM-SO2802-0045", "Tawakal", None, None)
    assert r.match_status == "matched_by_site_code"
    assert r.site.cccm_site_id == "CCCM-SO2802-0045"


def test_unique_name_is_a_confident_official_match():
    r = INDEX.match(None, "Horseed", None, None)
    assert r.match_status == "matched_by_official_name"
    assert r.site.cccm_site_id == UNIQUE.cccm_site_id


def test_ambiguous_name_resolved_by_district():
    r = INDEX.match(None, "Tawakal", None, None, district="Kismaayo")
    assert r.match_status == "matched_by_official_name"
    assert r.site.cccm_site_id == TAWAKAL_B.cccm_site_id


def test_ambiguous_name_resolved_by_nearest_coordinates():
    # Near Kismaayo's coords, no district hint -> should still pick Kismaayo.
    r = INDEX.match(None, "Tawakal", -0.35, 42.55, None)
    assert r.match_status == "matched_by_official_name"
    assert r.site.cccm_site_id == TAWAKAL_B.cccm_site_id


def test_ambiguous_name_with_no_geography_is_needs_review_not_a_confident_match():
    # The old first-wins behaviour would confidently return Baidoa's Tawakal.
    r = INDEX.match(None, "Tawakal", None, None)
    assert r.match_status == "probable_name_match"


def test_district_hint_folds_to_master_spelling():
    # 'Dayniile' is an alias in data/name-aliases.json for the master 'Daynile'.
    r = INDEX.match(None, "Tawakal", None, None, district="Dayniile")
    assert r.match_status == "matched_by_official_name"
    assert r.site.cccm_site_id == TAWAKAL_A.cccm_site_id


def test_gps_tier_still_matches_a_different_named_site_within_threshold():
    # ~78 m from TAWAKAL_A, inside the 150 m threshold.
    r = INDEX.match(None, "Totally Different Name", 2.0505, 45.2505, None)
    assert r.match_status == "matched_by_gps"
    assert r.site.cccm_site_id == TAWAKAL_A.cccm_site_id


def test_temporary_master_id_matches_permanent_collected_code():
    # Master carries the site as temporary (…-T####); the field tool collects
    # it without the T. Same site -> confident code match, not Unmatched.
    temp = site("CCCM-SO2501-T0071", "Guudale", "Xudur")
    idx = MasterSiteIndex([temp, UNIQUE])
    r = idx.match("CCCM-SO2501-0071", None, None, None)
    assert r.match_status == "matched_by_site_code"
    assert r.site.cccm_site_id == "CCCM-SO2501-T0071"
    # and the exact temporary spelling still matches too
    assert idx.match("CCCM-SO2501-T0071", None, None, None).match_status == "matched_by_site_code"


def test_temp_fallback_never_merges_two_distinct_sites():
    # If a permanent AND a temp id would collapse to the same key, the fallback
    # key is dropped -> no wrong match (the permanent still matches exactly).
    perm = site("CCCM-SO2501-0071", "Perm Site", "Xudur")
    temp = site("CCCM-SO2501-T0071", "Temp Site", "Xudur")
    idx = MasterSiteIndex([perm, temp])
    assert "CCCM-SO2501-0071" not in idx.by_id_normalized  # clashing key excluded
    assert idx.match("CCCM-SO2501-0071", None, None, None).site.cccm_site_id == "CCCM-SO2501-0071"


def test_unmatched_when_nothing_lines_up():
    r = INDEX.match("NO-SUCH-ID", "Zzz Nonexistent", None, None)
    assert r.match_status == "unmatched"
    assert r.site is None


def test_real_master_list_confident_name_matches_are_all_unambiguous():
    """Against the real CSV: every name we return as a confident official-name
    match (given no geography) must be globally unique. If any confident match
    is actually a shared name, the disambiguation guard has regressed."""
    from api.lib.site_matching import get_master_site_index

    idx = get_master_site_index("data/master-sites.csv")
    shared = 0
    for name, sites in idx.by_name.items():
        r = idx._match_uncached(None, name, None, None, None)
        if r.match_status == "matched_by_official_name":
            assert len(sites) == 1, f"confident match on shared name: {name!r}"
        elif len(sites) > 1:
            shared += 1
            assert r.match_status == "probable_name_match"
    assert shared > 0  # sanity: the collision problem is real in the data
