# CCCM Cluster Somalia — Service Mapping Dashboard

A single-page, cross-filtering dashboard consolidating CCCM Cluster Somalia's
service-mapping data (previously a 13-page Power BI report) into one dynamic
view: where services exist, where they're missing, who's operating where,
and how coverage changes over time.

Architecture: vanilla HTML/CSS/JS frontend (Chart.js + Leaflet, no build
step), a Python serverless API on Vercel that pulls from KoboToolbox and
matches submissions to the CCCM master site list, and static GeoJSON/CSV
reference data. No database — see "Known limitations" below for what that
trades away.

## Quick start (local)

```bash
pip install -r requirements.txt          # httpx only — the API's runtime dependency
python scripts/dev_server.py 8000        # serves index.html + /api/service-mapping locally
# open http://localhost:8000
```

To regenerate `data/master-sites.csv` and `geo/*.geojson` from the source
master list and shapefiles (only needed if those source files change):

```bash
pip install -r requirements-dev.txt      # geopandas, openpyxl, pandas, shapely
python build_data.py
```

## Environment variables

Copy `.env.example` to `.env` (or set these in the Vercel project settings —
**never commit real values**):

```
KOBO_BASE_URL=https://kf.kobo.iom.int
KOBO_ASSET_UID=apWf3JYW4hCFRE3pwwafwn
KOBO_API_TOKEN=<your token>
CACHE_TTL_SECONDS=300
SITE_MATCH_DISTANCE_METERS=150
APP_ENV=production

# Optional secondary data source (see "Data sources" below) — leave unset
# to run on Kobo data alone.
ZITEMANAGER_REPORT_URL=<full report URL, including its embedded access key>
```

Without `KOBO_API_TOKEN`/`KOBO_ASSET_UID` set, `/api/service-mapping` returns
`{"source": "no-kobo-credentials", "records": []}` and the dashboard renders
its empty state rather than erroring — this is intentional (see
`api/lib/build_payload.py`).

## Data sources

Two independent systems feed this dashboard; a record from either ends up in
the same clean-record shape (`dataSource` field distinguishes them):

1. **KoboToolbox** (`api/lib/kobo_client.py`, `transformations.py`) — the
   CCCM Cluster's own service-mapping form, matched to the master site list
   primarily by CCCM Site ID (the form mostly carries it directly).
2. **IOM ZiteManager** (`api/lib/zite_client.py`, `zite_transform.py`) — a
   separate service-provider contact registry IOM hosts, covering ~50
   organizations across 8 clusters in a handful of districts (Baidoa,
   Kismayo-area Gedo, Banadir, Xudur, at last check). Its Site ID format
   (`CCCM-BDA-SO2401-01-0028`) doesn't match the master list's
   (`CCCM-SO2401-0001`), and it carries no GPS — so matching is by **site
   name only** (exact/alternative/fuzzy tiers of `site_matching.py`; the GPS
   tier is never reached for this source). Roughly 89% of its sites matched
   in testing; the rest surface as `unmatched` in the sites table for manual
   review, same as any other unmatched record.
   **PII is stripped before this data is transformed** — Contact Name, Phone
   Number, Email, and WhatsApp never leave `zite_transform.py`; only
   Organization, Cluster, Activities, Status, and dates make it into a clean
   record. ZiteManager's "Protection" cluster also doesn't distinguish Child
   Protection/GBV/HLP the way the Kobo form does, so it only maps to
   "General Protection" — a site whose *only* protection record is from
   ZiteManager will understate those three sectors' coverage.
   A ZiteManager outage degrades gracefully — Kobo data still renders.

## Deploying to Vercel

```bash
vercel deploy
```

`vercel.json` routes `/api/service-mapping` to the Python function, and
serves `index.html`, `assets/`, `geo/`, `data/` as static files with
day-long browser caching on `geo/` and `assets/`.

## Project structure

```
index.html                   # single-page shell
assets/css/dashboard.css     # all styling (light/dark theme via [data-theme])
assets/js/
  translations.js            # EN/SO dictionary + applyTranslations()
  filters.js                 # state, filters, filtered(), applyFilters()
  charts.js                  # aggregation + Chart.js builders (9 charts)
  maps.js                    # Leaflet map, boundary layers, grid clustering
  tables.js                  # sites table (search/sort/paginate) + site drawer
  export.js                  # filtered CSV export (UTF-8 BOM)
  app.js                     # bootstrap, event wiring, theme/language
api/
  service-mapping.py         # Vercel serverless entrypoint (BaseHTTPRequestHandler)
  lib/
    settings.py              # env-var config
    kobo_client.py           # Kobo API v2 client (token never leaves the server)
    field_mapping.py         # real Kobo form's field-key suffixes (per-sector cluster_X + repeat_X)
    transformations.py       # raw Kobo submission -> structured rows + pcode name resolution
    zite_client.py           # IOM ZiteManager report fetch (URL/key never leaves the server)
    zite_transform.py        # raw ZiteManager record -> clean record, PII stripped
    site_matching.py         # priority-chain match against master-sites.csv
    indicators.py            # pure coverage/priority-score math (unit-tested)
    validation.py            # data-quality checks + per-record status
    build_payload.py         # merges both sources, normalizes agencies, orchestrates the API response
geo/                         # districts/regions/catchments GeoJSON (simplified, from real shapefiles)
data/
  master-sites.csv           # from the real CCCM master site list (6,807 sites)
  agencies.csv, sectors.csv, services.csv
build_data.py                 # dev-time: regenerates data/*.csv + geo/*.geojson from source files
scripts/dev_server.py         # local dev server mimicking Vercel's routing
```

## Data flow

1. `api/service-mapping.py` (Vercel function) calls `build_payload()`.
2. `build_payload()` fetches all Kobo submissions incrementally
   (`kobo_client.iter_submissions`), in-process-cached for `CACHE_TTL_SECONDS`
   so repeated requests within a warm function instance don't re-hit Kobo.
3. Each submission is parsed (`transformations.parse_submission`) — repeat
   groups become one row per (sector, service, agency) assessed.
4. Each row's site reference is matched against `data/master-sites.csv`
   (`site_matching.py`) via: exact CCCM Site ID → exact official name →
   alternative name → GPS proximity (`SITE_MATCH_DISTANCE_METERS`) → fuzzy
   name → unmatched (flagged, never silently created as a new site).
5. Records get a `dataQualityStatus` (`validation.py`) and are returned as
   clean JSON — no Kobo metadata, no token, nothing PII beyond what the form
   itself asks.
6. The frontend loads `/api/service-mapping` + `geo/*.geojson` concurrently,
   stores everything in `state.all`, and every filter/click re-derives all
   charts/KPIs/table/map from that same array via `filtered()`.

## Known limitations (flagged, not silently omitted)

- **No database**: KPIs are computed only from Kobo-submitted records, not
  against the full 6,807-site master list denominator (e.g. this shows
  "42 sites assessed", not "42 of 473 master-list sites" — the reference
  Power BI report's "X of Y" framing needs the full site list loaded
  client-side or a denominator field added to the API response).
- **Cold-fetch latency**: pulling + matching ~2,500 Kobo submissions and
  ~5,000 ZiteManager records against the 6,807-site master list takes
  roughly 10-15 seconds uncached (fuzzy name-matching is memoized and uses
  `difflib.get_close_matches` to keep this bounded, but it's not instant).
  `vercel.json` sets `maxDuration: 30` for the function and `CACHE_TTL_SECONDS`
  means this cost is paid at most once per cache window per warm instance —
  if you still see timeouts on Vercel's Hobby tier (10s hard cap regardless
  of `maxDuration`), either raise `CACHE_TTL_SECONDS` or move to Pro.
- **No scheduled sync worker**: Vercel serverless functions are stateless: 
  there's no APScheduler/Celery equivalent running continuously. Each API
  call is cached for `CACHE_TTL_SECONDS` but otherwise pulls from Kobo live.
  For a true "synced every 15 minutes" guarantee, add a Vercel Cron Job
  hitting `/api/service-mapping?refresh=true` on a schedule.
- **No per-service breakdown**: the real Kobo form (confirmed against live
  submissions) only asks Yes/No per *sector*, not per individual service —
  `data/services.csv` stays empty and every record's `service` field is null.
- **Agency-to-partner-type mapping is unset**: neither data source states an
  agency's partner type (UN/INGO/NNGO/...) directly; `partnerType` is null on
  every record until a lookup table (agency name → partner type) is added.
- **No authentication/RBAC**: the original spec's public/partner/IM-officer/
  administrator roles are not implemented — every visitor sees the same
  aggregate + site-level data. Add before exposing anything sensitive.
- **Fuzzy/searchable multi-select filters**: implemented as native
  `<select multiple>` elements (browser-native typeahead-jump only, not a
  full searchable combobox) to avoid adding a UI library beyond Chart.js/Leaflet.
- **Full-screen map / shareable filtered URLs**: not implemented (fullscreen
  toggle works via CSS on supporting browsers; URL state sync is a stretch
  goal noted in the in-app methodology panel).
- **District naming inconsistency**: records matched to a master-list site
  carry the master list's district name ("Baidoa"), while unmatched records
  fall back to the UNDP admin2 name for the same p-code ("Baydhaba") — so
  both can appear in the district filter. Resolving it means designating one
  naming authority and normalizing the other; deliberately not decided in
  code.
- **Flood/river risk map mode**: no risk layer data source is wired in yet —
  the map-mode selector has the option but needs a GeoJSON risk layer added
  under `geo/` once available.

## Testing without live Kobo access

`api/lib/build_payload.py`, `site_matching.py`, `indicators.py`, and
`validation.py` are all pure/testable without a live Kobo token — see them
exercised directly:

```bash
python -c "from api.lib.build_payload import build_payload; print(build_payload())"
python -c "from api.lib.site_matching import get_master_site_index; idx = get_master_site_index(); print(idx.match('CCCM-SO2302-0001', None, None, None))"
```
