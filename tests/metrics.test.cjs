// Canonical metric definitions.
//
// The dashboard once showed "0 sites assessed" beside "2 sites assessed" and
// both were arithmetically correct: one counted master-list sites, the other
// counted site-level submissions. These tests pin each definition to its own
// grain so the two can never be rendered under one label again.

const test = require("node:test");
const assert = require("node:assert");
const semantic = require("../assets/js/semantic.js");

const { canonicalMetrics, catchmentIsResolved, isCurrent, assessmentsFromRecords } = semantic;

// A record shaped the way the API delivers one.
function rec(over) {
  return Object.assign(
    {
      dataSource: "kobo",
      reportingPeriod: "2026-07",
      reportingPartner: "ACTED",
      publicationStatus: "published",
      reasonCodes: [],
      coverageStatus: "Yes",
    },
    over
  );
}

// The six real ACTED submissions from the July 2026 round, at the grain the
// metric layer sees them.
const ACTED_JULY = [
  rec({ submissionUuid: "afgooye", scopeType: "district", district: "Afgooye" }),
  rec({
    submissionUuid: "xudur", scopeType: "catchment", district: "Xudur",
    catchment: null, reasonCodes: ["MISSING_REQUIRED_CATCHMENT"],
    publicationStatus: "published_with_warning",
  }),
  rec({ submissionUuid: "baidoa", scopeType: "catchment", district: "Baidoa", catchment: "Baidoa · CA12" }),
  rec({
    submissionUuid: "laas56", scopeType: "site", district: "Laas Caanood",
    siteCodeRaw: "ACTEDSO1401_56", matchStatus: "unmatched",
    reasonCodes: ["UNMATCHED_MASTER_SITE"], publicationStatus: "published_with_warning",
  }),
  rec({
    submissionUuid: "laas55", scopeType: "site", district: "Laas Caanood",
    siteCodeRaw: "ACTEDSO1401_55", matchStatus: "unmatched",
    reasonCodes: ["UNMATCHED_MASTER_SITE"], publicationStatus: "published_with_warning",
  }),
  rec({ submissionUuid: "luuq", scopeType: "district", district: "Luuq" }),
];

// ---------------------------------------------------------------------------
// The regression fixture the whole redesign is measured against.

test("ACTED + 2026-07 returns the verified metric set", () => {
  const m = canonicalMetrics(ACTED_JULY);
  assert.equal(m.assessments, 6);
  assert.equal(m.districtsAssessed, 5);
  assert.equal(m.resolvedCatchmentsAssessed, 1);
  assert.equal(m.unresolvedCatchmentAssessments, 1);
  assert.equal(m.siteLevelAssessments, 2);
  assert.equal(m.matchedMasterSites, 0);
  assert.equal(m.reportingPartners, 1);
  assert.equal(m.assessmentsWithWarnings, 3);
  assert.deepEqual(m.quality, { published: 3, publishedWithWarning: 3, quarantined: 0 });
});

test("matched master sites and site-level assessments are different quantities", () => {
  // This is the whole point: two site-flavoured numbers that legitimately
  // disagree, because they measure different things.
  const m = canonicalMetrics(ACTED_JULY);
  assert.equal(m.siteLevelAssessments, 2, "two partners' site-level submissions");
  assert.equal(m.matchedMasterSites, 0, "neither is tied to an approved master site");
  assert.notEqual(m.siteLevelAssessments, m.matchedMasterSites);
});

// ---------------------------------------------------------------------------
// Per-metric definitions.

test("assessments counts a submission once regardless of sector or provider rows", () => {
  const many = [
    rec({ submissionUuid: "one", scopeType: "district", district: "Luuq", sector: "WASH", agency: "A" }),
    rec({ submissionUuid: "one", scopeType: "district", district: "Luuq", sector: "Health", agency: "B" }),
    rec({ submissionUuid: "one", scopeType: "district", district: "Luuq", sector: "CCCM", agency: "C" }),
  ];
  assert.equal(canonicalMetrics(many).assessments, 1);
});

test("assessments excludes superseded and quarantined versions", () => {
  const m = canonicalMetrics([
    rec({ submissionUuid: "live", scopeType: "district", district: "Luuq" }),
    rec({ submissionUuid: "old", scopeType: "district", district: "Luuq", publicationStatus: "superseded" }),
    rec({ submissionUuid: "held", scopeType: "district", district: "Luuq", publicationStatus: "quarantined" }),
  ]);
  assert.equal(m.assessments, 1);
  assert.equal(m.quality.quarantined, 1, "quarantined is still reported, just not counted as an assessment");
});

test("site-level assessments include warning records and need no master-list match", () => {
  const m = canonicalMetrics([
    rec({
      submissionUuid: "s1", scopeType: "site", district: "Laas Caanood",
      matchStatus: "unmatched", reasonCodes: ["UNMATCHED_MASTER_SITE"],
      publicationStatus: "published_with_warning",
    }),
  ]);
  assert.equal(m.siteLevelAssessments, 1, "measures partner reporting activity");
  assert.equal(m.matchedMasterSites, 0, "but contributes nothing to official site coverage");
});

test("matched master sites requires a TRUSTED match, not a probable one", () => {
  const m = canonicalMetrics([
    rec({ submissionUuid: "a", scopeType: "site", district: "Baidoa", matchedSiteCode: "CCCM-SO2401-0001", matchStatus: "matched_by_site_code" }),
    rec({ submissionUuid: "b", scopeType: "site", district: "Baidoa", matchedSiteCode: "CCCM-SO2401-0002", matchStatus: "probable_name_match" }),
  ]);
  assert.equal(m.matchedMasterSites, 1, "a probable name match is a candidate awaiting review, not an official site");
});

test("matched master sites deduplicates a site reported many times", () => {
  const same = ["WASH", "Health", "CCCM"].map((sector) =>
    rec({ submissionUuid: "u" + sector, scopeType: "site", district: "Baidoa", sector,
          matchedSiteCode: "CCCM-SO2401-0001", matchStatus: "matched_by_site_code" })
  );
  assert.equal(canonicalMetrics(same).matchedMasterSites, 1);
});

test("a catchment assessment with no catchment is counted but not resolved", () => {
  const m = canonicalMetrics([ACTED_JULY[1]]);
  assert.equal(m.assessments, 1, "still a real assessment");
  assert.equal(m.resolvedCatchmentsAssessed, 0, "never counted as a resolved catchment");
  assert.equal(m.unresolvedCatchmentAssessments, 1, "reported separately instead");
});

test("the same catchment code in two districts counts twice", () => {
  // CA codes repeat across districts, so the dedup key must include district.
  const m = canonicalMetrics([
    rec({ submissionUuid: "x", scopeType: "catchment", district: "Baidoa", catchment: "Baidoa · CA12" }),
    rec({ submissionUuid: "y", scopeType: "catchment", district: "Xudur", catchment: "Xudur · CA12" }),
  ]);
  assert.equal(m.resolvedCatchmentsAssessed, 2);
});

test("districts assessed counts every scope, not only site-level", () => {
  const m = canonicalMetrics(ACTED_JULY);
  assert.equal(m.districtsAssessed, 5, "district, catchment and site assessments all place a district");
});

test("reporting partners and service providers are separate dimensions", () => {
  const m = canonicalMetrics([
    rec({ submissionUuid: "a", scopeType: "site", district: "Baidoa", reportingPartner: "ACTED", agency: "IOM", coverageStatus: "Yes" }),
    rec({ submissionUuid: "a", scopeType: "site", district: "Baidoa", reportingPartner: "ACTED", agency: "NRC", coverageStatus: "Yes" }),
  ]);
  assert.equal(m.reportingPartners, 1, "ACTED conducted the assessment");
  assert.equal(m.activeServiceProviders, 2, "IOM and NRC deliver the services");
});

test("a provider named but not confirmed active is not counted as active", () => {
  const m = canonicalMetrics([
    rec({ submissionUuid: "a", scopeType: "site", district: "Baidoa", agency: "IOM", coverageStatus: "No" }),
  ]);
  assert.equal(m.activeServiceProviders, 0);
});

test("the provider directory never contributes assessments", () => {
  const m = canonicalMetrics([
    ...ACTED_JULY,
    { dataSource: "zitemanager", submissionUuid: "zite-1", district: "Baidoa", agency: "IOM", coverageStatus: "Yes", reportingPeriod: "2026-07" },
  ]);
  assert.equal(m.assessments, 6, "a directory entry was not conducted by anyone");
  assert.equal(m.activeServiceProviders, 1, "but it does evidence a provider being active");
});

// ---------------------------------------------------------------------------
// Helpers used by the catchment section and exports.

test("catchmentIsResolved rejects both missing and unmatched catchments", () => {
  assert.equal(catchmentIsResolved({ catchment: "Baidoa · CA12", reasonCodes: [] }), true);
  assert.equal(catchmentIsResolved({ catchment: null, reasonCodes: ["MISSING_REQUIRED_CATCHMENT"] }), false);
  assert.equal(catchmentIsResolved({ catchment: "SO2401CA99", reasonCodes: ["UNRESOLVED_CATCHMENT"] }), false);
});

test("isCurrent admits warnings but not quarantined or superseded", () => {
  assert.equal(isCurrent({ publicationStatus: "published" }), true);
  assert.equal(isCurrent({ publicationStatus: "published_with_warning" }), true);
  assert.equal(isCurrent({ publicationStatus: "quarantined" }), false);
  assert.equal(isCurrent({ publicationStatus: "superseded" }), false);
});

test("an empty selection yields zeros, not errors", () => {
  const m = canonicalMetrics([]);
  assert.equal(m.assessments, 0);
  assert.equal(m.matchedMasterSites, 0);
  assert.equal(m.quality.quarantined, 0);
});

// ---------------------------------------------------------------------------
// Export reconciliation: the KPI, the table and the export must agree.

test("assessment KPI, table rows and export rows all reconcile", () => {
  const m = canonicalMetrics(ACTED_JULY);
  const tableRows = assessmentsFromRecords(ACTED_JULY).filter(isCurrent);
  // The export applies exactly this filter, so its row count is the same value.
  assert.equal(m.assessments, tableRows.length);
  assert.equal(tableRows.length, 6);
});

test("the data-quality export row count matches the warning reasons present", () => {
  // One row per (assessment, reason code): Xudur's missing catchment plus the
  // two unmatched Laas Caanood references.
  const exceptions = assessmentsFromRecords(ACTED_JULY)
    .filter(isCurrent)
    .flatMap((a) => (a.reasonCodes || []).filter((c) => c !== "REPORTING_LEVEL_INFERRED"));
  assert.equal(exceptions.length, 3);
  assert.deepEqual(exceptions.sort(), [
    "MISSING_REQUIRED_CATCHMENT",
    "UNMATCHED_MASTER_SITE",
    "UNMATCHED_MASTER_SITE",
  ]);
});

test("reason-code explanations are joined from the published catalog", () => {
  // The explanation used to be repeated on every record (~3.7 MB across the
  // payload). It is now published once and joined client-side; a record with
  // codes but no inline text must still explain itself.
  global.state = { reasonCodeCatalog: {
    MISSING_REQUIRED_CATCHMENT: "No catchment was supplied in the source.",
    UNMATCHED_MASTER_SITE: "The site reference does not match an approved master-site ID.",
  } };
  assert.equal(
    semantic.explainCodes(["MISSING_REQUIRED_CATCHMENT"]),
    "No catchment was supplied in the source."
  );
  assert.equal(
    semantic.explainCodes(["MISSING_REQUIRED_CATCHMENT", "UNMATCHED_MASTER_SITE"]),
    "No catchment was supplied in the source.; The site reference does not match an approved master-site ID."
  );
  assert.equal(semantic.explainCodes([]), null, "no codes, nothing to explain");
  assert.equal(semantic.explainCodes(["NOT_IN_CATALOG"]), null, "unknown codes are skipped, not printed raw");
  delete global.state;
});

test("an assessment with no inline explanation still resolves one", () => {
  global.state = { reasonCodeCatalog: { UNMATCHED_MASTER_SITE: "Not an approved master site." } };
  const [a] = semantic.assessmentsFromRecords([
    { dataSource: "kobo", submissionUuid: "x", scopeType: "site", reasonCodes: ["UNMATCHED_MASTER_SITE"] },
  ]);
  assert.equal(a.qualityExplanation, "Not an approved master site.");
  delete global.state;
});
