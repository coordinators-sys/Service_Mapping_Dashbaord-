# -*- coding: utf-8 -*-
"""Parse a ZiteManager 'Sites' admin-page export into (name, code, district)
rows, skipping catchment-area header rows (name followed by 'arrow_drop_up').

Input format: plain text copy-pasted from the Sites list UI — each site is a
6-line block (profile / Site Name / CODE<TAB>Project<TAB> / 5 numeric columns
/ trailing dash), with catchment-area group headers interleaved (Name /
arrow_drop_up / group code / ...), which this parser skips.

DISTRICT_BY_ABBR maps the code's district-abbreviation infix to the name
downstream matching expects. "BDR" (Banadir) is a REGION in the master list,
not a literal district value — build_zite_crosswalk.py special-cases it to
scope by region instead of an exact district-string match. If a future export
introduces a new abbreviation, add it here (and confirm in
data/master-sites.csv whether it's a real district or another region)."""
import re, csv, sys

DISTRICT_BY_ABBR = {
    "LUQ": "Luuq", "XDR": "Xudur", "BRE": "Baardheere", "KMY": "Kismaayo",
    "BDA": "Baidoa", "BDR": "Banadir", "DLW": "Doolow",
}

def parse(path):
    lines = [l.rstrip("\n") for l in open(path, encoding="utf-8")]
    rows = []
    i = 0
    while i < len(lines):
        if lines[i].strip() == "profile":
            name = lines[i + 1].strip() if i + 1 < len(lines) else None
            nxt = lines[i + 2].strip() if i + 2 < len(lines) else ""
            if nxt == "arrow_drop_up":
                i += 3  # catchment header — skip (its own code line follows, skip that too)
                continue
            code_line = nxt
            m = re.match(r'^(CCCM-([A-Z]{3})-\S+|Test-SOM)\t', code_line + "\t")
            if name and code_line and "\t" in code_line:
                code = code_line.split("\t")[0].strip()
                abbr_m = re.match(r'^CCCM-([A-Z]{3})-', code)
                abbr = abbr_m.group(1) if abbr_m else None
                district = DISTRICT_BY_ABBR.get(abbr)
                rows.append({"name": name, "code": code, "district": district})
            i += 2
        else:
            i += 1
    return rows

if __name__ == "__main__":
    path = sys.argv[1]
    rows = parse(path)
    print(f"parsed {len(rows)} site rows from {path}")
    by_abbr = {}
    for r in rows:
        by_abbr.setdefault(r["code"].split("-")[1], 0)
        by_abbr[r["code"].split("-")[1]] += 1
    print("by district abbreviation:", by_abbr)
    out = sys.argv[2] if len(sys.argv) > 2 else None
    if out:
        with open(out, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["name", "code", "district"])
            if f.tell() == 0:
                w.writeheader()
            w.writerows(rows)
        print(f"appended to {out}")
