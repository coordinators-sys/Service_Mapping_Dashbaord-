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
