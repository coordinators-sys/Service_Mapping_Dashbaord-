# -*- coding: utf-8 -*-
"""Build a ZiteManager site-code -> master CCCM Site ID crosswalk from a
parsed Sites export (see parse_zite_sites_export.py), resolving by NAME +
DISTRICT/REGION against the master list — never by parsing the code, which
was proven unsafe: ZiteManager's district-scoped sequence numbers do not
correspond to the master list's own sequence for the same site (e.g.
CCCM-LUQ-SO2606-0033 is "Wacanri"; the master's CCCM-SO2606-0033 is a
different site, "Qansaxdheere").

Usage: python scripts/build_zite_crosswalk.py parsed_sites.csv [output.json]
Merge the result into data/site-code-crosswalk.json's "entries" object
(never overwrite — merge, and verify zero value conflicts on overlapping
keys before committing).
"""
import csv, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from api.lib.site_matching import get_master_site_index, _normalize_name

def main(parsed_csv):
    idx = get_master_site_index(os.path.join(os.path.dirname(__file__), "..", "data", "master-sites.csv"))
    rows = list(csv.DictReader(open(parsed_csv, encoding="utf-8")))
    print(f"input rows: {len(rows)}")

    crosswalk = {}
    stats = {"resolved_name_district": 0, "resolved_name_unique": 0,
              "ambiguous": 0, "no_master_name": 0, "no_district": 0, "already_direct": 0}
    for r in rows:
        code = r["code"].strip().upper()
        name = r["name"].strip()
        district = r.get("district")

        if code in idx.by_id:
            stats["already_direct"] += 1
            continue

        candidates = idx.by_name.get(_normalize_name(name), [])
        if not candidates:
            stats["no_master_name"] += 1
            continue
        if not district:
            stats["no_district"] += 1
            continue
        # "Banadir" is a REGION in the master list, not a district value (its
        # real districts are Daynile/Kahda/Mogadishu Dayniile/Mogadishu Khada)
        # — a code's BDR prefix tells us the region, not which of those four.
        if district == "Banadir":
            in_district = [c for c in candidates if c.region == "Banadir"]
        else:
            in_district = [c for c in candidates if _normalize_name(c.district) == _normalize_name(district)]
        if len(in_district) == 1:
            crosswalk[code] = in_district[0].cccm_site_id
            stats["resolved_name_district"] += 1
        elif len(candidates) == 1:
            crosswalk[code] = candidates[0].cccm_site_id
            stats["resolved_name_unique"] += 1
        else:
            stats["ambiguous"] += 1

    print("stats:", stats)
    print("crosswalk entries so far:", len(crosswalk))
    return crosswalk

if __name__ == "__main__":
    cw = main(sys.argv[1])
    import json
    out = sys.argv[2] if len(sys.argv) > 2 else "zite_crosswalk_partial.json"
    json.dump(cw, open(out, "w", encoding="utf-8"), indent=1)
    print("wrote", out)
