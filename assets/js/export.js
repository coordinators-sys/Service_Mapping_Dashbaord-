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

function exportFilteredRecords() {
  const records = filtered();
  const meta = [
    `# CCCM Cluster Somalia — Service Mapping Dashboard export`,
    `# Export date: ${new Date().toISOString()}`,
    `# Reporting period filter: ${filters.period.size ? Array.from(filters.period).join("; ") : "all"}`,
    `# Region filter: ${filters.region.size ? Array.from(filters.region).join("; ") : "all"}`,
    `# District filter: ${filters.district.size ? Array.from(filters.district).join("; ") : "all"}`,
    `# Sector filter: ${filters.sector.size ? Array.from(filters.sector).join("; ") : "all"}`,
    `# Agency filter: ${filters.agency.size ? Array.from(filters.agency).join("; ") : "all"}`,
    `# Data source: KoboToolbox (${state.source || "unknown"})`,
    `# Last synchronization: ${state.generatedAt || "unknown"}`,
    `#`,
  ].join("\r\n");
  downloadCsv(`cccm_service_mapping_${new Date().toISOString().slice(0, 10)}.csv`, meta + "\r\n" + recordsToCsv(records));
}

function exportByKind(kind) {
  const records = filtered();
  if (kind === "records") return exportFilteredRecords();

  if (kind === "sites") {
    const rows = buildSiteTableRows(records).map((r) => ({
      region: r.region, district: r.district, siteName: r.siteName, siteCode: r.siteKey,
      activeAgencies: r.activeAgencies, sectorsAvailable: r.sectorsAvailable.join("; "),
      sectorsMissing: r.sectorsMissing.join("; "), coverageScore: r.coverageScore,
    }));
    return downloadCsv("cccm_sites_and_coverage.csv", tableToCsv(rows));
  }
  if (kind === "agencies") {
    const rows = computeSitesByAgency(records, 1000).map((r) => ({ agency: r.agency, sitesCovered: r.sitesCovered }));
    return downloadCsv("cccm_agencies_and_activities.csv", tableToCsv(rows));
  }
  if (kind === "gaps") {
    const rows = computeSiteGapProfiles(records).filter((s) => s.gapCount > 0).map((s) => ({
      siteName: s.siteName, siteCode: s.siteKey, region: s.region, district: s.district,
      gapCount: s.gapCount, gaps: s.gaps.join("; "),
    }));
    return downloadCsv("cccm_priority_service_gaps.csv", tableToCsv(rows));
  }
  if (kind === "quality") {
    const rows = records.filter((r) => r.dataQualityStatus && r.dataQualityStatus !== "passed").map((r) => ({
      siteCode: r.matchedSiteCode || r.siteCodeRaw, matchStatus: r.matchStatus,
      dataQualityStatus: r.dataQualityStatus, submissionUuid: r.submissionUuid,
    }));
    return downloadCsv("cccm_data_quality_issues.csv", tableToCsv(rows));
  }
}

function tableToCsv(rows) {
  if (!rows.length) return "﻿No data for the current filter selection";
  const columns = Object.keys(rows[0]);
  const header = columns.map(csvEscape).join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")).join("\r\n");
  return "﻿" + header + "\r\n" + body;
}
