// Download the currently FILTERED clean records (never raw Kobo data) as
// UTF-8-BOM CSV so it opens correctly in Excel.

const EXPORT_COLUMNS = [
  ["reportingDate", "Reporting date"],
  ["reportingPeriod", "Reporting period"],
  ["region", "Region"],
  ["district", "District"],
  ["catchment", "Catchment"],
  ["siteNameRaw", "Site name"],
  ["matchedSiteCode", "CCCM Site ID"],
  ["matchStatus", "Match status"],
  ["matchDistanceMeters", "Match distance (m)"],
  ["agency", "Agency"],
  ["partnerType", "Partner type"],
  ["sector", "Sector"],
  ["service", "Service"],
  ["activity", "Activity"],
  ["coverageStatus", "Coverage status"],
  ["latitude", "Latitude"],
  ["longitude", "Longitude"],
  ["dataQualityStatus", "Data-quality status"],
  ["lastUpdated", "Last updated"],
];

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function recordsToCsv(records) {
  const header = EXPORT_COLUMNS.map(([, label]) => csvEscape(label)).join(",");
  const rows = records.map((r) => EXPORT_COLUMNS.map(([field]) => csvEscape(r[field])).join(","));
  return "﻿" + [header, ...rows].join("\r\n");
}

function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Shared metadata block prepended to EVERY export: applied filters, period,
// export date, sync time, source, denominator note, definitions pointer.
function exportMetaBlock(extra = []) {
  const f = (set) => (set.size ? Array.from(set).join("; ") : "all");
  return [
    `# CCCM Cluster Somalia — Service Mapping Dashboard export`,
    `# Export date: ${new Date().toISOString()}`,
    `# Reporting period filter: ${f(filters.period)}`,
    `# Region filter: ${f(filters.region)}`,
    `# District filter: ${f(filters.district)}`,
    `# Catchment filter: ${f(filters.catchment)}`,
    `# Sector filter: ${f(filters.sector)}`,
    `# Agency filter: ${f(filters.agency)}`,
    `# Coverage-status filter: ${f(filters.coverage)}`,
    `# Data sources: ${state.source || "unknown"}`,
    `# Last synchronization: ${state.generatedAt || "unknown"}`,
    `# Master-list sites (denominator reference): ${state.masterSites ? state.masterSites.total : "unknown"}`,
    `# Definitions: Covered = >=1 confirmed active provider; Not covered = explicitly confirmed unavailable; Unknown = blank/not reported (never counted as No). See the Methodology panel for full definitions.`,
    `# Disclaimer: figures reflect partner-reported data for the filters above and may change as reporting is updated.`,
    ...extra,
    `#`,
  ].join("\r\n");
}

function exportFilteredRecords() {
  const records = filtered();
  downloadCsv(`cccm_service_mapping_${new Date().toISOString().slice(0, 10)}.csv`, exportMetaBlock() + "\r\n" + recordsToCsv(records));
}

function exportByKind(kind) {
  const records = filtered();
  const stamp = new Date().toISOString().slice(0, 10);
  const withMeta = (rows) => exportMetaBlock() + "\r\n" + tableToCsv(rows).replace(/^﻿/, "");
  if (kind === "records") return exportFilteredRecords();
  if (kind === "pdf") return exportExecutivePdf();

  if (kind === "sites") {
    const rows = buildSiteTableRows(records).map((r) => ({
      region: r.region, district: r.district, siteName: r.siteName, siteCode: r.siteKey,
      activeAgencies: r.activeAgencies, sectorsAvailable: r.sectorsAvailable.join("; "),
      sectorsMissing: r.sectorsMissing.join("; "), coverageScore: r.coverageScore,
    }));
    return downloadCsv(`cccm_sites_and_coverage_${stamp}.csv`, withMeta(rows));
  }
  if (kind === "agencies") {
    const rows = computeSitesByAgency(records, 100000).map((r) => ({ agency: r.agency, sitesCovered: r.sitesCovered }));
    return downloadCsv(`cccm_agencies_and_activities_${stamp}.csv`, withMeta(rows));
  }
  if (kind === "gaps") {
    const rows = computeSiteGapProfiles(records).filter((s) => s.gapCount > 0).map((s) => ({
      siteName: s.siteName, siteCode: s.siteKey, region: s.region, district: s.district,
      gapCount: s.gapCount, critical: s.isCritical ? "yes" : "no", gaps: s.gaps.join("; "),
    }));
    return downloadCsv(`cccm_priority_service_gaps_${stamp}.csv`, withMeta(rows));
  }
  if (kind === "quality") {
    const rows = records.filter((r) => r.dataQualityStatus && r.dataQualityStatus !== "passed").map((r) => ({
      siteCode: r.matchedSiteCode || r.siteCodeRaw, matchStatus: r.matchStatus,
      dataQualityStatus: r.dataQualityStatus, submissionUuid: r.submissionUuid,
    }));
    return downloadCsv(`cccm_data_quality_issues_${stamp}.csv`, withMeta(rows));
  }
  if (kind === "sectors") {
    const rows = computeSectorCoverage(records).map((s) => ({
      sector: s.sector, covered: s.covered, notCovered: s.notCovered, unknown: s.unknown,
      assessedDenominator: s.reportableTotal, coveragePct: s.reportableTotal ? Math.round(s.coveragePct) : "",
    }));
    return downloadCsv(`cccm_sector_summary_${stamp}.csv`, withMeta(rows));
  }
  if (kind === "catchments") {
    const rows = computeCatchmentAnalysis(records).map((c) => ({
      catchment: c.catchment, district: c.district, sitesAssessed: c.sitesAssessed,
      activeAgencies: c.activeAgencies, coveragePct: c.coveragePct === null ? "" : Math.round(c.coveragePct),
      topMissingSectors: c.topMissing.join("; "),
    }));
    return downloadCsv(`cccm_catchment_summary_${stamp}.csv`, withMeta(rows));
  }
  if (kind === "notreported") {
    // Master-list sites with no record in the current selection. Only district
    // totals are available client-side without shipping the full master list,
    // so this export is per-district: master vs reported vs missing counts.
    const seen = {};
    records.forEach((r) => {
      const k = siteKey(r);
      if (!k || !r.district) return;
      (seen[r.district] = seen[r.district] || new Set()).add(k);
    });
    const rows = Object.entries((state.masterSites && state.masterSites.byDistrict) || {}).map(([district, masterCount]) => {
      const reported = seen[district] ? seen[district].size : 0;
      return { district, masterListSites: masterCount, sitesReported: reported, sitesNotReported: Math.max(0, masterCount - reported) };
    }).sort((a, b) => b.sitesNotReported - a.sitesNotReported);
    return downloadCsv(`cccm_sites_not_reported_${stamp}.csv`, withMeta(rows));
  }
  if (kind === "methodology") {
    const text = buildMethodologyText();
    const blob = new Blob(["﻿" + text], { type: "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cccm_service_mapping_methodology_${stamp}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return;
  }
}

function tableToCsv(rows) {
  if (!rows.length) return "﻿No data for the current filter selection";
  const columns = Object.keys(rows[0]);
  const header = columns.map(csvEscape).join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")).join("\r\n");
  return "﻿" + header + "\r\n" + body;
}

// ---------- Executive PDF ----------
// Dependency-free: opens a print-ready A4 summary in a new window and
// triggers the browser's print dialog (users choose "Save as PDF"). This
// keeps the frontend free of a PDF library while producing a clean,
// paginated executive brief of the CURRENT filter selection.
function exportExecutivePdf() {
  const records = filtered();
  const cov = computeSectorCoverage(records);
  const profiles = computeSiteGapProfiles(records);
  const assessed = new Set(records.map(siteKey).filter(Boolean)).size;
  const agencies = new Set(records.filter((r) => r.coverageStatus === "Yes" && r.agency).map((r) => r.agency)).size;
  const confirmedGaps = profiles.filter((s) => s.gapCount > 0).length;
  const critical = profiles.filter((s) => s.isCritical).length;
  const master = state.masterSites ? state.masterSites.total : null;
  const f = (set) => (set.size ? Array.from(set).join(", ") : "All");
  const insights = Array.from(document.querySelectorAll("#insight-banner li")).map((li) => li.textContent);
  const topPriority = profiles.filter((s) => s.gapCount > 0).sort((a, b) => b.gapCount - a.gapCount).slice(0, 10);

  const win = window.open("", "_blank");
  if (!win) return; // popup blocked — the Download menu note covers this
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>CCCM Service Mapping — Executive Summary</title>
  <style>
    @page { size: A4; margin: 16mm; }
    body { font-family: Inter, "Segoe UI", Arial, sans-serif; color: #26343A; font-size: 11px; margin: 0; }
    h1 { font-size: 17px; margin: 0 0 2px; color: #104E5D; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #17677A; margin: 16px 0 6px; border-bottom: 1px solid #D6E0E3; padding-bottom: 3px; }
    .eyebrow { font-size: 9px; font-weight: 700; letter-spacing: 0.05em; color: #17677A; }
    .meta { color: #75848A; font-size: 9px; margin: 6px 0 0; }
    .kpis { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .kpi { border: 1px solid #D6E0E3; border-radius: 6px; padding: 6px 10px; min-width: 96px; }
    .kpi b { display: block; font-size: 15px; }
    .kpi.red b { color: #D9534F; }
    table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #E4EAEC; }
    th { font-size: 9px; text-transform: uppercase; color: #75848A; }
    ul { margin: 4px 0; padding-left: 16px; }
    .footer { margin-top: 18px; font-size: 8.5px; color: #75848A; border-top: 1px solid #D6E0E3; padding-top: 6px; }
  </style></head><body>
  <div class="eyebrow">SERVICE COVERAGE TOOL · CCCM CLUSTER SOMALIA</div>
  <h1>Service Mapping — Executive Summary</h1>
  <div class="meta">
    Generated: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC ·
    Last synchronization: ${state.generatedAt || "unknown"} · Sources: ${state.source || "unknown"}<br>
    Filters — Period: ${f(filters.period)} · Region: ${f(filters.region)} · District: ${f(filters.district)} ·
    Catchment: ${f(filters.catchment)} · Sector: ${f(filters.sector)} · Agency: ${f(filters.agency)}
  </div>

  <h2>Key figures</h2>
  <div class="kpis">
    <div class="kpi"><b>${assessed.toLocaleString()}</b>Sites assessed${master ? ` (of ${master.toLocaleString()} master-list)` : ""}</div>
    <div class="kpi"><b>${agencies.toLocaleString()}</b>Active agencies</div>
    <div class="kpi red"><b>${confirmedGaps.toLocaleString()}</b>Sites with confirmed gaps</div>
    <div class="kpi red"><b>${critical.toLocaleString()}</b>Sites with critical gaps</div>
  </div>

  <h2>Automated insights</h2>
  <ul>${insights.map((i) => `<li>${i}</li>`).join("")}</ul>

  <h2>Sector coverage</h2>
  <table><thead><tr><th>Sector</th><th>Covered</th><th>Not covered</th><th>Unknown</th><th>Assessed</th><th>Coverage</th></tr></thead>
  <tbody>${cov.map((s) => `<tr><td>${s.sector}</td><td>${s.covered.toLocaleString()}</td><td>${s.notCovered.toLocaleString()}</td><td>${s.unknown.toLocaleString()}</td><td>${s.reportableTotal.toLocaleString()}</td><td>${s.reportableTotal ? Math.round(s.coveragePct) + "%" : "—"}</td></tr>`).join("")}</tbody></table>

  <h2>Top priority sites</h2>
  <table><thead><tr><th>Site</th><th>District</th><th>Catchment</th><th>Confirmed gaps</th><th>Critical</th></tr></thead>
  <tbody>${topPriority.map((s) => `<tr><td>${s.siteName} (${s.siteKey})</td><td>${s.district || "—"}</td><td>${s.catchment || "—"}</td><td>${s.gapCount}</td><td>${s.isCritical ? "yes" : ""}</td></tr>`).join("")}</tbody></table>

  <div class="footer">
    Definitions: Covered = at least one confirmed active provider; Not covered = explicitly confirmed unavailable;
    Unknown = blank/not reported (never counted as No; excluded from the coverage denominator).
    Critical = missing 3+ priority sectors, all priority services, or both Health and WASH.
    Figures reflect partner-reported data for the filters above and may change as reporting is updated.
    CCCM Cluster Somalia — service-mapping-dashboard.cccmclustersomalia.org
  </div>
  <script>window.onload = function () { window.print(); };</` + `script></body></html>`);
  win.document.close();
}
