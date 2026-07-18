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


def test_sub_area_field_tool_id_is_never_parsed_into_a_master_id():
    """Regression guard for a fix that was measured, found harmful, and removed.

    CCCM-BDA-SO2401-01-0028 is Baidoa's "Makuuda 1". Deriving (pcode, trailing
    number) from it yields CCCM-SO2401-0028, which is a DIFFERENT Baidoa site
    ("Al Aamin") — the trailing number is a within-sub-area sequence. Against
    the live payload this mis-bound 1,990 records with 0/141 name agreement, and
    a district check cannot catch it because both sites are in Baidoa.

    The id must be ignored so the NAME tier resolves the record correctly.
    """
    al_aamin = site("CCCM-SO2401-0028", "Al Aamin", "Baidoa")
    makuuda = site("CCCM-SO2401-1028", "Makuuda 1", "Baidoa")
    idx = MasterSiteIndex([al_aamin, makuuda])

    r = idx.match("CCCM-BDA-SO2401-01-0028", "Makuuda 1", None, None, district="Baidoa")
    assert r.site.cccm_site_id == "CCCM-SO2401-1028", "must resolve by name, not by parsing the id"
    assert r.match_status == "matched_by_official_name"

    # With no name to fall back on, it must stay Unmatched rather than guess.
    assert idx.match("CCCM-BDA-SO2401-01-0028", None, None, None,
                     district="Baidoa").match_status == "unmatched"


def test_curated_crosswalk_resolves_form_codes_exactly():
    """Codes from the Kobo form's site.csv that the master list doesn't use
    resolve via the curated crosswalk — exact string lookup, no parsing."""
    master = site("CCCM-SO2401-0373", "Kulmiye", "Baidoa")
    idx = MasterSiteIndex([master], code_crosswalk={"ACTEDSO2401_26": "CCCM-SO2401-0373"})
    r = idx.match("ACTEDSO2401_26", None, None, None)
    assert r.match_status == "matched_by_site_code"
    assert r.site.cccm_site_id == "CCCM-SO2401-0373"
    # near-miss spellings are NOT parsed into a crosswalk hit
    assert idx.match("ACTEDSO2401_27", None, None, None).match_status == "unmatched"


def test_crosswalk_target_may_be_a_temporary_master_id():
    temp = site("CCCM-SO2501-T0071", "Guudale", "Xudur")
    idx = MasterSiteIndex([temp], code_crosswalk={"ACTEDSO2501_9": "CCCM-SO2501-0071"})
    r = idx.match("ACTEDSO2501_9", None, None, None)
    assert r.match_status == "matched_by_site_code"
    assert r.site.cccm_site_id == "CCCM-SO2501-T0071"


def test_fuzzy_name_confirmed_by_gps_graduates_out_of_needs_review():
    """Typed-name spelling variant + coordinates near THAT site = two
    independent signals agreeing -> confident match, with the distance kept."""
    waysiyow = site("CCCM-SO2401-0500", "Waysiyow", "Baidoa", 3.100, 43.650)
    idx = MasterSiteIndex([waysiyow, UNIQUE])
    # ~330 m away: outside the 150 m blind-GPS tier, inside the 500 m confirm radius
    r = idx.match(None, "Weysiyow", 3.103, 43.650, district="Baidoa")
    assert r.match_status == "matched_by_name_gps"
    assert r.site.cccm_site_id == "CCCM-SO2401-0500"
    assert r.match_distance_meters is not None and 150 < r.match_distance_meters <= 500


def test_fuzzy_name_with_far_gps_stays_needs_review():
    waysiyow = site("CCCM-SO2401-0500", "Waysiyow", "Baidoa", 3.100, 43.650)
    idx = MasterSiteIndex([waysiyow])
    # ~2.2 km away: name is close but the coordinates do NOT corroborate.
    r = idx.match(None, "Weysiyow", 3.120, 43.650, None)
    assert r.match_status == "probable_name_match"


def test_fuzzy_name_without_gps_stays_needs_review():
    waysiyow = site("CCCM-SO2401-0500", "Waysiyow", "Baidoa", 3.100, 43.650)
    idx = MasterSiteIndex([waysiyow])
    assert idx.match(None, "Weysiyow", None, None).match_status == "probable_name_match"


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
