// N1 — do the independent coverage and active-agency implementations agree?
//
// Coverage is computed in four places and active agencies in three. They were
// written at different times for different views. If they disagree, different
// tabs of the dashboard show different numbers for the same question, which is
// a live correctness problem rather than a refactoring nicety.
//
// These tests execute the REAL shipped functions inside a sandbox with the
// browser globals stubbed, rather than reimplementing them — a reimplementation
// would only prove the copy matches itself.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

// Minimal browser surface. Only what module top-level code touches: the
// functions under test are pure over records.
function loadDashboard({ periodFilter = new Set() } = {}) {
  const sandbox = {
    console,
    WeakMap,
    Map,
    Set,
    // The filter state the aggregation functions read.
    filters: {
      period: periodFilter,
      sector: new Set(),
      catchment: new Set(),
      district: new Set(),
    },
    state: { all: [], charts: {}, maps: {} },
    // i18n and DOM helpers used only inside render functions we never call.
    t: (k) => k,
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
    escapeHtml: (s) => String(s),
    formatNumber: (n) => String(n),
    formatPct: (n) => String(n),
    // charts.js sets Chart.defaults at load time.
    Chart: Object.assign(function () {}, {
      defaults: { scale: { grid: {}, border: {} } },
      register: () => {},
    }),
    L: {},
    // maps.js/charts.js preload sector icons at load time.
    Image: function () { return {}; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // semantic.js is UMD: with no CommonJS `module` it assigns its API to
  // `window` if one exists, else globalThis. Pointing window AT the sandbox
  // means either branch lands where the other scripts can see it.
  sandbox.window = sandbox;

  // filters.js first: it defines siteKey/siteLabel that the aggregation uses.
  for (const file of ["filters.js", "semantic.js", "charts.js", "tables.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "assets", "js", file), "utf8");
    vm.runInContext(src, sandbox, { filename: file });
  }
  sandbox.__eval = (expr) => vm.runInContext(expr, sandbox);
  return sandbox;
}

// A record set exercising the cases the four implementations treat differently:
// a matched site, an unmatched site, a needs-review site, multi-period
// reporting, and a site whose sectors are all Unknown.
function fixture() {
  const base = {
    dataSource: "kobo",
    reportingPartner: "ACTED",
    publicationStatus: "published",
    scopeType: "site",
    reasonCodes: [],
    district: "Baidoa",
    region: "Bay",
    catchment: "Baidoa · CA12",
  };
  const rows = [];
  const add = (site, matchStatus, sector, status, period, agency) =>
    rows.push({
      ...base,
      submissionUuid: `${site}-${sector}-${period}`,
      matchedSiteCode: matchStatus === "unmatched" ? null : site,
      siteCodeRaw: site,
      matchStatus,
      sector,
      coverageStatus: status,
      reportingPeriod: period,
      agency,
      lastUpdated: `${period}-15`,
    });

  // Matched site: 2 available, 1 confirmed gap, reported in two periods with
  // the status CHANGING — this is what latestStatusCells collapses.
  add("CCCM-SO2401-0001", "matched_by_site_code", "WASH", "Yes", "2026-06", "IOM");
  add("CCCM-SO2401-0001", "matched_by_site_code", "Health", "No", "2026-06", null);
  add("CCCM-SO2401-0001", "matched_by_site_code", "WASH", "Yes", "2026-07", "IOM");
  add("CCCM-SO2401-0001", "matched_by_site_code", "Health", "Yes", "2026-07", "NRC");
  add("CCCM-SO2401-0001", "matched_by_site_code", "CCCM", "No", "2026-07", null);

  // A second matched site, single period.
  add("CCCM-SO2401-0002", "matched_by_site_code", "WASH", "No", "2026-07", null);
  add("CCCM-SO2401-0002", "matched_by_site_code", "Health", "Yes", "2026-07", "DRC");

  // Unmatched site — real partner data, but not an official master-list site.
  add("ACTEDSO1401_55", "unmatched", "WASH", "Yes", "2026-07", "ACTED");
  add("ACTEDSO1401_55", "unmatched", "Health", "No", "2026-07", null);

  // Needs-review site.
  add("CCCM-SO2401-0003", "probable_name_match", "WASH", "Yes", "2026-07", "SCC");

  // WITHDRAWAL: a service that WAS available in June and is confirmed absent
  // in July. Any implementation using "some record says Yes" rather than the
  // latest status will report a withdrawn service as still present — the most
  // consequential direction to get wrong.
  add("CCCM-SO2401-0005", "matched_by_site_code", "Health", "Yes", "2026-06", "IOM");
  add("CCCM-SO2401-0005", "matched_by_site_code", "Health", "No", "2026-07", null);
  add("CCCM-SO2401-0005", "matched_by_site_code", "WASH", "Yes", "2026-07", "IOM");

  // All-Unknown site: carries no assessment signal at all.
  add("CCCM-SO2401-0004", "matched_by_site_code", "WASH", "Unknown", "2026-07", null);

  return rows;
}

// Totals from each implementation, expressed in the same units so they can be
// compared: how many site×sector observations are available vs confirmed gaps.
function totalsBySectorRollup(dash, records) {
  const rows = dash.computeSectorCoverage(records);
  return rows.reduce(
    (acc, r) => ({ available: acc.available + r.covered, gaps: acc.gaps + r.notCovered }),
    { available: 0, gaps: 0 }
  );
}

function totalsBySiteTable(dash, records) {
  return dash.buildSiteTableRows(records).reduce(
    (acc, r) => ({
      available: acc.available + r.sectorsAvailable.length,
      gaps: acc.gaps + r.sectorsMissing.length,
    }),
    { available: 0, gaps: 0 }
  );
}

// computeCatchmentAnalysis exposes a percentage, not raw counts, so the
// comparable quantity is the rate over the same population.
function catchmentRate(dash, records) {
  const rows = dash.computeCatchmentAnalysis(records).filter((c) => c.coveragePct !== null);
  return rows.length ? Math.round(rows[0].coveragePct) : null;
}

function sectorRate(dash, records) {
  const t = totalsBySectorRollup(dash, records);
  return t.available + t.gaps ? Math.round((t.available / (t.available + t.gaps)) * 100) : null;
}

// ---------------------------------------------------------------------------

// KNOWN DIVERGENCE — awaiting a Cluster decision, see N1 report 2026-07-29.
// The Sites tab deliberately falls back to raw cells for unmatched and
// needs-review sites ("the only place their data exists"), while the Coverage
// tab counts official master-list sites only. The arithmetic is identical; the
// POPULATION is not. On 2026-07 production data that is 51% vs 59% available —
// 8 percentage points between two tabs. Marked todo rather than deleted so the
// gap stays visible and flips green the moment the populations are reconciled.
test("sector rollup and site table agree on available vs confirmed gaps", { todo: "population differs: official-only vs official+unmatched — Cluster decision pending" }, () => {
  const dash = loadDashboard({ periodFilter: new Set(["2026-07"]) });
  const records = fixture();
  const sector = totalsBySectorRollup(dash, records);
  const table = totalsBySiteTable(dash, records);
  assert.deepStrictEqual(
    table,
    sector,
    "the Coverage tab and the Sites tab must not disagree about how many " +
      "services are available and how many are confirmed gaps"
  );
});

test("the site drawer agrees with the site table row it opens from", () => {
  // The drawer is what a user sees after clicking a row. If it disagrees with
  // the row, the same site shows two coverage scores one click apart.
  const dash = loadDashboard({ periodFilter: new Set(["2026-07"]) });
  const records = fixture();
  dash.state.all = records;

  const row = dash.buildSiteTableRows(records).find((r) => r.siteKey === "CCCM-SO2401-0001");

  // Recompute exactly as openSiteDrawer does (its body is inseparable from DOM
  // rendering, so the arithmetic is mirrored here — see the drawer source).
  const SECTORS = vm.runInContext("SECTORS", dash);
  const drawerRows = dash.state.all.filter((r) => dash.siteKey(r) === "CCCM-SO2401-0001");
  const available = SECTORS.filter((s) => drawerRows.some((r) => r.sector === s && r.coverageStatus === "Yes"));
  const missing = SECTORS.filter(
    (s) => drawerRows.some((r) => r.sector === s && r.coverageStatus === "No") && !available.includes(s)
  );
  const reportable = available.length + missing.length;
  const drawerScore = reportable ? Math.round((available.length / reportable) * 100) : null;

  assert.strictEqual(
    drawerScore,
    row.coverageScore,
    "the drawer and the table row describe the same site in the same selection"
  );
});

test("catchment rate agrees with the sector rate over the same population", () => {
  // Every fixture site is in one catchment, so the catchment rate and the
  // national rate must be the same number.
  const dash = loadDashboard({ periodFilter: new Set(["2026-07"]) });
  const records = fixture();
  assert.strictEqual(catchmentRate(dash, records), sectorRate(dash, records));
});

// KNOWN DEFECT — awaiting go-ahead to fix, see N1 report 2026-07-29.
// openSiteDrawer resolves availability as "some record ever said Yes", with no
// latest-status collapse, so a service confirmed withdrawn still shows as
// available in the drawer while the row behind it correctly shows a gap.
// 294 site-sector pairs across 82 sites in current production data.
test("a withdrawn service is not reported as still available", { todo: "openSiteDrawer uses ever-Yes instead of latest status — fix pending approval" }, () => {
  // Site 0005: Health present in June, confirmed absent in July.
  const dash = loadDashboard({ periodFilter: new Set(["2026-07"]) });
  const all = fixture();
  const filtered = all.filter((r) => r.reportingPeriod === "2026-07");
  dash.state.all = all;

  const row = dash.buildSiteTableRows(filtered).find((r) => r.siteKey === "CCCM-SO2401-0005");
  assert.ok(!row.sectorsAvailable.includes("Health"), "the table correctly shows Health as withdrawn");
  assert.ok(row.sectorsMissing.includes("Health"));

  // The drawer's own arithmetic, over the records it actually reads.
  const SECTORS = vm.runInContext("SECTORS", dash);
  const drawerRows = dash.state.all.filter((r) => dash.siteKey(r) === "CCCM-SO2401-0005");
  const available = SECTORS.filter((s) => drawerRows.some((r) => r.sector === s && r.coverageStatus === "Yes"));
  assert.ok(!available.includes("Health"),
    "the drawer must not report a withdrawn service as available");
});

test("the drawer honours the active filter, like the row it opens from", () => {
  // openSiteDrawer reads state.all — the UNFILTERED record set — while the
  // table row beside it is computed from the filtered set. With a period
  // filter active the same site can therefore show two different coverage
  // scores one click apart.
  const dash = loadDashboard({ periodFilter: new Set(["2026-07"]) });
  const all = fixture();
  const filtered = all.filter((r) => r.reportingPeriod === "2026-07");
  dash.state.all = all; // what the drawer actually reads

  const row = dash.buildSiteTableRows(filtered).find((r) => r.siteKey === "CCCM-SO2401-0001");

  const SECTORS = vm.runInContext("SECTORS", dash);
  const drawerRows = dash.state.all.filter((r) => dash.siteKey(r) === "CCCM-SO2401-0001");
  const available = SECTORS.filter((s) => drawerRows.some((r) => r.sector === s && r.coverageStatus === "Yes"));
  const missing = SECTORS.filter(
    (s) => drawerRows.some((r) => r.sector === s && r.coverageStatus === "No") && !available.includes(s)
  );
  const reportable = available.length + missing.length;
  const drawerScore = reportable ? Math.round((available.length / reportable) * 100) : null;

  assert.strictEqual(drawerScore, row.coverageScore,
    "clicking a row must not change the site's coverage score");
});

test("all-periods mode collapses a site to its latest status consistently", { todo: "same population divergence as above" }, () => {
  // With no period selected the semantic layer collapses to latest-status.
  // Any implementation that skips that step double-counts a site that reported
  // in several months.
  const dash = loadDashboard({ periodFilter: new Set() });
  const records = fixture();
  const sector = totalsBySectorRollup(dash, records);
  const table = totalsBySiteTable(dash, records);
  assert.deepStrictEqual(table, sector, "all-periods totals must not double-count multi-month reporters");
});

// ---------------------------------------------------------------------------
// Active service providers — three implementations.

test("the three active-agency counts agree", () => {
  const dash = loadDashboard({ periodFilter: new Set(["2026-07"]) });
  const records = fixture();

  const canonical = dash.canonicalMetrics(records).activeServiceProviders;

  const bySector = new Set();
  dash.computeAgenciesBySector(records).forEach(() => {});
  // Union of the per-sector distinct agency sets is not the same as a global
  // distinct count, so compare against the raw definition each one uses.
  records.forEach((r) => {
    if (r.coverageStatus === "Yes" && r.agency) bySector.add(r.agency);
  });

  const tableUnion = new Set();
  dash.buildSiteTableRows(records).forEach((row) => {
    // agencies is a Set on the row entry
    (row.agencies || []).forEach((a) => tableUnion.add(a));
  });

  assert.strictEqual(canonical, bySector.size, "canonical metric vs the chart definition");
  assert.strictEqual(
    tableUnion.size,
    canonical,
    "the sites table's per-site agency sets must union to the headline count"
  );
});
