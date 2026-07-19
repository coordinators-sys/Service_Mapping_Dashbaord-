// Data-validation invariants for the semantic layer (assets/js/semantic.js).
// Runs the SAME file the browser executes — no re-implementation drift.
//
//   node --test tests/
//
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const semantic = require(path.join(__dirname, "..", "assets", "js", "semantic.js"));

const { buildSiteSectorStatus, sectorCoverageFromCells, coverageTrendFromCells, semanticQuality } = semantic;

function rec(over) {
  return Object.assign(
    { matchedSiteCode: "S1", siteCodeRaw: null, sector: "WASH", reportingPeriod: "2026-07",
      coverageStatus: "Unknown", dataSource: "kobo", matchStatus: "matched_by_site_code" },
    over
  );
}

test("a site reported by BOTH sources counts once per sector-period (no record double-count)", () => {
  const cells = buildSiteSectorStatus([
    rec({ dataSource: "kobo", coverageStatus: "Yes" }),
    rec({ dataSource: "zitemanager", coverageStatus: "Yes" }),
  ]);
  assert.strictEqual(cells.length, 1);
  assert.strictEqual(cells[0].status, "Yes");
  assert.deepStrictEqual(cells[0].sources, ["kobo", "zitemanager"]);
});

test("covered + notCovered + unknown always equals total cells for the sector", () => {
  const cells = buildSiteSectorStatus([
    rec({ matchedSiteCode: "A", coverageStatus: "Yes" }),
    rec({ matchedSiteCode: "B", coverageStatus: "No" }),
    rec({ matchedSiteCode: "C", coverageStatus: "Unknown" }),
    rec({ matchedSiteCode: "D" }),
  ]);
  const [wash] = sectorCoverageFromCells(cells, ["WASH"]);
  assert.strictEqual(wash.covered + wash.notCovered + wash.unknown, cells.length);
});

test("coverage rate denominator excludes Unknown (blank is never counted as No)", () => {
  const cells = buildSiteSectorStatus([
    rec({ matchedSiteCode: "A", coverageStatus: "Yes" }),
    rec({ matchedSiteCode: "B", coverageStatus: "No" }),
    rec({ matchedSiteCode: "C", coverageStatus: "Unknown" }),
  ]);
  const [wash] = sectorCoverageFromCells(cells, ["WASH"]);
  assert.strictEqual(wash.reportableTotal, 2);
  assert.strictEqual(Math.round(wash.coveragePct), 50);
  assert.strictEqual(wash.unknown, 1); // visible, not hidden
});

test("Yes+No for the same cell resolves to Yes but is FLAGGED as a conflict", () => {
  const cells = buildSiteSectorStatus([
    rec({ dataSource: "kobo", coverageStatus: "No" }),
    rec({ dataSource: "zitemanager", coverageStatus: "Yes" }),
  ]);
  assert.strictEqual(cells.length, 1);
  assert.strictEqual(cells[0].status, "Yes");
  assert.strictEqual(cells[0].conflict, true);
  assert.strictEqual(cells[0].statusBySource.kobo, "No");
  assert.strictEqual(cells[0].statusBySource.zitemanager, "Yes");
  assert.strictEqual(semanticQuality(cells).conflicts, 1);
});

test("same site, different periods -> separate cells (period is part of the grain)", () => {
  const cells = buildSiteSectorStatus([
    rec({ reportingPeriod: "2026-06", coverageStatus: "No" }),
    rec({ reportingPeriod: "2026-07", coverageStatus: "Yes" }),
  ]);
  assert.strictEqual(cells.length, 2);
  const trend = coverageTrendFromCells(cells, "WASH");
  assert.deepStrictEqual(trend.map((p) => p.period), ["2026-06", "2026-07"]);
  assert.strictEqual(trend[0].coveragePct, 0);
  assert.strictEqual(trend[1].coveragePct, 100);
});

test("missing periods do not appear as zero points in the trend", () => {
  const cells = buildSiteSectorStatus([
    rec({ reportingPeriod: "2026-01", coverageStatus: "Yes" }),
    rec({ reportingPeriod: "2026-07", coverageStatus: "Yes" }),
  ]);
  const trend = coverageTrendFromCells(cells, "WASH");
  assert.strictEqual(trend.length, 2); // no fabricated 2026-02..06 zeros
});

test("unmatched records flag the cell requiresReview; records without site/sector/period are excluded", () => {
  const cells = buildSiteSectorStatus([
    rec({ matchedSiteCode: null, siteCodeRaw: "RAW-1", matchStatus: "unmatched", coverageStatus: "Yes" }),
    rec({ matchedSiteCode: null, siteCodeRaw: null }),           // no site id at all
    rec({ matchedSiteCode: "S9", sector: null }),                 // no sector
    rec({ matchedSiteCode: "S9", reportingPeriod: null }),        // no period
  ]);
  assert.strictEqual(cells.length, 1);
  assert.strictEqual(cells[0].requiresReview, true);
  assert.strictEqual(semanticQuality(cells).requiresReview, 1);
});

test("sector totals reconcile: sum over sectors equals total cells", () => {
  const records = [];
  const sectors = ["WASH", "Health", "CCCM"];
  for (let i = 0; i < 30; i++) {
    records.push(rec({
      matchedSiteCode: `S${i % 10}`,
      sector: sectors[i % 3],
      coverageStatus: ["Yes", "No", "Unknown"][i % 3],
      dataSource: i % 2 ? "kobo" : "zitemanager",
    }));
  }
  const cells = buildSiteSectorStatus(records);
  const per = sectorCoverageFromCells(cells, sectors);
  const sum = per.reduce((a, s) => a + s.covered + s.notCovered + s.unknown, 0);
  assert.strictEqual(sum, cells.length);
});

test("siteSectorStatusMap resolves No over Unknown REGARDLESS of record order", () => {
  // No then Unknown
  const a = buildSiteSectorStatus([
    rec({ matchedSiteCode: "X", coverageStatus: "No" }),
    rec({ matchedSiteCode: "X", coverageStatus: "Unknown" }),
  ]);
  // Unknown then No
  const b = buildSiteSectorStatus([
    rec({ matchedSiteCode: "Y", coverageStatus: "Unknown" }),
    rec({ matchedSiteCode: "Y", coverageStatus: "No" }),
  ]);
  const ma = semantic.siteSectorStatusMap(a);
  const mb = semantic.siteSectorStatusMap(b);
  assert.strictEqual(ma.get("X").WASH, "No");
  assert.strictEqual(mb.get("Y").WASH, "No"); // the old per-record rollup returned Unknown here
});

test("siteSectorStatusMap agrees with sectorCoverageFromCells site-for-site", () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    records.push(rec({ matchedSiteCode: `S${i}`, coverageStatus: ["Yes", "No", "Unknown"][i % 3] }));
  }
  const cells = buildSiteSectorStatus(records);
  const map = semantic.siteSectorStatusMap(cells);
  let covered = 0, notCovered = 0;
  map.forEach((s) => { if (s.WASH === "Yes") covered++; else if (s.WASH === "No") notCovered++; });
  const [wash] = sectorCoverageFromCells(cells, ["WASH"]);
  assert.strictEqual(covered, wash.covered);
  assert.strictEqual(notCovered, wash.notCovered);
});

test("officialCells keeps only matched cells; partition reconciles to the total", () => {
  const cells = buildSiteSectorStatus([
    rec({ matchedSiteCode: "A", matchStatus: "matched_by_site_code", coverageStatus: "Yes" }),
    rec({ matchedSiteCode: "B", matchStatus: "probable_name_match", coverageStatus: "Yes" }),
    rec({ matchedSiteCode: null, siteCodeRaw: "RAW-9", matchStatus: "unmatched", coverageStatus: "No" }),
  ]);
  const official = semantic.officialCells(cells);
  assert.strictEqual(official.length, 1);
  assert.strictEqual(official[0].site, "A");
  // matched + needs_review + unmatched always equals the total cell count
  const groups = { matched: 0, needs_review: 0, unmatched: 0 };
  cells.forEach((c) => { groups[c.matchGroup] += 1; });
  assert.strictEqual(groups.matched + groups.needs_review + groups.unmatched, cells.length);
});

test("a cell is matched if ANY contributing record is confidently matched", () => {
  const cells = buildSiteSectorStatus([
    rec({ dataSource: "kobo", matchStatus: "probable_name_match", coverageStatus: "No" }),
    rec({ dataSource: "zitemanager", matchStatus: "matched_by_site_code", coverageStatus: "Yes" }),
  ]);
  assert.strictEqual(cells.length, 1);
  assert.strictEqual(cells[0].matchGroup, "matched");
});

test("latestStatusCells keeps exactly one cell per site-sector: the newest period", () => {
  const cells = buildSiteSectorStatus([
    rec({ reportingPeriod: "2026-01", coverageStatus: "Yes" }),
    rec({ reportingPeriod: "2026-06", coverageStatus: "No" }),
    rec({ matchedSiteCode: "S2", reportingPeriod: "2026-03", coverageStatus: "Yes" }),
  ]);
  const latest = semantic.latestStatusCells(cells);
  assert.strictEqual(latest.length, 2); // one per site-sector, not per period
  const s1 = latest.find((c) => c.site === "S1");
  assert.strictEqual(s1.period, "2026-06");
  assert.strictEqual(s1.status, "No"); // the LATEST status wins, not the best
});

test("all-periods official coverage counts a multi-month site once (no double count)", () => {
  const cells = buildSiteSectorStatus([
    rec({ reportingPeriod: "2026-01", coverageStatus: "Yes" }),
    rec({ reportingPeriod: "2026-02", coverageStatus: "Yes" }),
    rec({ reportingPeriod: "2026-03", coverageStatus: "Yes" }),
  ]);
  const [wash] = sectorCoverageFromCells(semantic.latestStatusCells(semantic.officialCells(cells)), ["WASH"]);
  assert.strictEqual(wash.covered, 1); // was 3 under the per-period grain
});
