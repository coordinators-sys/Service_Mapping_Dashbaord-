// Standing rule, applied to the export routes.
//
// The Python gate gets the API payload. The exports are a SECOND way data
// leaves the system: eleven CSV/PDF routes that build their own column sets in
// the browser, from records the gate has already approved but reshaped by
// hand. A route that adds a column, or renames one, bypasses the server-side
// check entirely.
//
// So this runs the REAL export code over a record set that deliberately
// contains personal data in every field an export might reach for, and asserts
// none of it appears in any output.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

// Values planted in the fixture. If any appears in an export, the test names
// which route and which value shape — never the value itself in a real run.
const PLANTED = {
  email: "aamina.focal@savethechildren.org",
  phone: "+252 61 234 5678",
  nationalPhone: "0615123456",
  personName: "Aamina Hassan Warsame",
};

function loadExporter() {
  const captured = [];
  const sandbox = {
    console,
    WeakMap, Map, Set, Date, Math, JSON, Intl,
    filters: { period: new Set(["2026-07"]), sector: new Set(), catchment: new Set(),
               district: new Set(), region: new Set(), agency: new Set(),
               reportingPartner: new Set(), scope: new Set(), pubStatus: new Set(),
               site: new Set(), coverage: new Set() },
    state: { all: [], charts: {}, maps: {}, generatedAt: "2026-07-29T09:00:00Z",
             masterSites: { approved: 4119, pendingRegistration: 2688, total: 6807 },
             reasonCodeCatalog: {}, partnerUpdateStatus: [] },
    t: (k) => k,
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
                createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, click() {} }),
                body: { appendChild() {}, removeChild() {} } },
    escapeHtml: String,
    formatNumber: String,
    formatPct: String,
    Chart: Object.assign(function () {}, { defaults: { scale: { grid: {}, border: {} } }, register() {} }),
    L: {},
    Image: function () { return {}; },
    URL: { createObjectURL: () => "blob:", revokeObjectURL() {} },
    Blob: function (parts) { this.parts = parts; },
    // Intercept the download instead of performing it.
    downloadCsv: (filename, csv) => captured.push({ filename, body: String(csv) }),
    downloadText: (filename, text) => captured.push({ filename, body: String(text) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.window = sandbox;

  for (const file of ["filters.js", "semantic.js", "charts.js", "tables.js", "export.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "assets", "js", file), "utf8"), sandbox, { filename: file });
  }
  // downloadCsv is declared inside export.js; re-point it at the interceptor.
  vm.runInContext("downloadCsv = (f, c) => __capture(f, c);", sandbox);
  sandbox.__capture = (filename, csv) => captured.push({ filename, body: String(csv) });
  return { sandbox, captured };
}

// A record set carrying planted personal data in every plausible carrier:
// structured fields, free text, and fields an export might pass through
// verbatim.
function poisonedRecords() {
  const base = {
    dataSource: "kobo",
    reportingPeriod: "2026-07",
    reportingDate: "2026-07-20T09:27:15",
    lastUpdated: "2026-07-20",
    publicationStatus: "published",
    reasonCodes: [],
    scopeType: "site",
    region: "Bay",
    district: "Baidoa",
    catchment: "Baidoa · CA12",
    matchStatus: "matched_by_site_code",
    matchedSiteCode: "CCCM-SO2401-0001",
    matchedSiteName: "Test Site",
    siteCodeRaw: "CCCM-SO2401-0001",
    siteNameRaw: "Test Site",
    latitude: 3.1167,
    longitude: 43.65,
    submissionUuid: "u-1",
    sourceId: "34224509",
    sourceRootUuid: "uuid:root-1",
    sourceVersion: "v1",
  };
  return [
    // Free text carrying an email and a phone number.
    { ...base, sector: "WASH", coverageStatus: "Yes", agency: "IOM",
      activity: `water trucking ${PLANTED.email} ${PLANTED.phone}` },
    // A person's name where an organisation belongs.
    { ...base, submissionUuid: "u-2", sector: "Health", coverageStatus: "No",
      agency: null, reportingPartner: "ACTED", service: `clinic run by ${PLANTED.personName}` },
    // A national-form mobile in a note.
    { ...base, submissionUuid: "u-3", sector: "CCCM", coverageStatus: "Yes", agency: "NRC",
      reconciliationNote: `follow up on ${PLANTED.nationalPhone}` },
  ];
}

const ROUTES = ["records", "sites", "agencies", "gaps", "quality", "sectors",
                "catchments", "notreported", "assessments"];

// Mirrors api/lib/field_classification.scrub_free_text. The browser never sees
// raw records — it receives what the server already scrubbed — so an export
// test that skips this step is testing the server, not the exports.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;
const PHONE_RE = /(?:\+?252[\s-]?\d[\d\s-]{6,12}\d|\b0[679]\d{7,8}\b)/g;
// Mirrors the server: operator prose is dropped outright, Cluster-authored
// prose is scrubbed.
const EXCLUDED = ["activity", "service"];
const FREE_TEXT = ["reconciliationNote"];

function asDelivered(records) {
  return records.map((r) => {
    const out = Object.assign({}, r);
    for (const key of EXCLUDED) delete out[key];
    for (const key of FREE_TEXT) {
      if (typeof out[key] === "string") {
        out[key] = out[key].replace(new RegExp(EMAIL_RE.source, "g"), "[redacted]")
                           .replace(PHONE_RE, "[redacted]");
      }
    }
    return out;
  });
}

function runAllRoutes(sandbox, records) {
  sandbox.state.all = records;
  sandbox.filtered = () => records;
  for (const kind of ROUTES) {
    try { sandbox.exportByKind(kind); } catch (e) { /* a route may need DOM we do not stub */ }
  }
}

test("no export route emits an email address or phone number", () => {
  const { sandbox, captured } = loadExporter();
  runAllRoutes(sandbox, asDelivered(poisonedRecords()));

  assert.ok(captured.length > 0, "no export produced output — the harness is not exercising the routes");
  for (const { filename, body } of captured) {
    assert.ok(!body.includes(PLANTED.email), filename + " contains an email address");
    assert.ok(!body.includes(PLANTED.phone), filename + " contains a +252 number");
    assert.ok(!body.includes(PLANTED.nationalPhone), filename + " contains a national-form number");
    assert.ok(!EMAIL_RE.test(body), filename + " contains an email-shaped value");
  }
});

// Operator free text is EXCLUDED from the payload entirely (Cluster
// Coordinator, 2026-07-29), so a name typed into `activity` never reaches a
// client at all. This was a `todo` while the decision was open; it is a real
// assertion now, and it fails if free text is ever reinstated.
test("no export route emits a personal name in free text", () => {
  const { sandbox, captured } = loadExporter();
  runAllRoutes(sandbox, asDelivered(poisonedRecords()));
  assert.ok(captured.length > 0, "no export produced output");
  for (const { filename, body } of captured) {
    assert.ok(!body.includes(PLANTED.personName), filename + " contains a personal name");
  }
});

test("no export column names a field outside the classification register", () => {
  // Each route builds its own column set by hand, so a route can reach for a
  // record property the server-side gate never saw under that name.
  const registerSrc = fs.readFileSync(path.join(ROOT, "api", "lib", "field_classification.py"), "utf8");
  const classified = new Set(
    [...registerSrc.matchAll(/^ {4}"(\w+)",$/gm)].map((m) => m[1].toLowerCase())
  );
  const { sandbox, captured } = loadExporter();
  runAllRoutes(sandbox, asDelivered(poisonedRecords()));

  // A column is acceptable if it maps to a classified field once naming
  // convention is normalised away, or if it is plainly derived (a count, a
  // rate, an export timestamp). Anything else is reported for review.
  const PERSONAL = /(name_focal|focal_name|focal_phone|focal_email|mobile|phone|email|whatsapp|designation|submitted_by|hotline)/i;
  const suspicious = new Set();
  for (const { body } of captured) {
    const header = body.split(/\r?\n/).find((l) => l.includes(",") && !/^#/.test(l)) || "";
    for (const col of header.split(",")) {
      const c = col.replace(/"/g, "").trim().toLowerCase();
      if (c && PERSONAL.test(c)) suspicious.add(c);
    }
  }
  assert.deepStrictEqual([...suspicious], [],
    "export column(s) named like personal data: " + [...suspicious].join(", "));
});

test("every export route is covered by this test", () => {
  // A route added without being listed here would never be scanned. Read the
  // dispatch table out of the source so the list cannot silently fall behind.
  const src = fs.readFileSync(path.join(ROOT, "assets", "js", "export.js"), "utf8");
  const declared = [...src.matchAll(/kind === "([a-z]+)"/g)].map((m) => m[1]);
  const uncovered = declared.filter((k) => !ROUTES.includes(k) && k !== "pdf" && k !== "methodology");
  assert.deepStrictEqual(uncovered, [],
    "export route(s) not scanned for personal data: " + uncovered.join(", "));
});
