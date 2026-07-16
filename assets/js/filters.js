// Centralized application state + filter state. Every chart/KPI/table/map
// reads from `filtered()` — one source of truth for "what's selected".
// Filter widgets are MultiSelect instances (multiselect.js); this module
// owns them and keeps them in sync with the `filters` Sets.

const state = {
  all: [],
  summary: null,
  charts: {},
  geo: null,
  maps: {},
  generatedAt: null,
  source: null,
};

const filters = {
  region: new Set(),
  district: new Set(),
  agency: new Set(),
  catchment: new Set(),
  sector: new Set(),
  service: new Set(),
  site: new Set(),
  period: new Set(),
  coverage: new Set(),
};

const slicers = {}; // dimension -> MultiSelect, created by initSlicers()

function siteKey(record) {
  return record.matchedSiteCode || record.siteCodeRaw || "";
}

function siteLabel(record) {
  return record.matchedSiteName || record.siteNameRaw || siteKey(record) || "Unknown site";
}

// Applies every active filter Set. A dimension with an empty Set means
// "no restriction on that dimension". `excludeDimension` supports cascading:
// a dimension's own option list is scoped by every OTHER filter.
function filtered(excludeDimension) {
  return state.all.filter((r) => {
    if (filters.region.size && excludeDimension !== "region" && !filters.region.has(r.region)) return false;
    if (filters.district.size && excludeDimension !== "district" && !filters.district.has(r.district)) return false;
    if (filters.catchment.size && excludeDimension !== "catchment" && !filters.catchment.has(r.catchment)) return false;
    if (filters.site.size && excludeDimension !== "site" && !filters.site.has(siteKey(r))) return false;
    if (filters.sector.size && excludeDimension !== "sector" && !filters.sector.has(r.sector)) return false;
    if (filters.service.size && excludeDimension !== "service" && !filters.service.has(r.service)) return false;
    if (filters.agency.size && excludeDimension !== "agency" && !filters.agency.has(r.agency)) return false;
    if (filters.period.size && excludeDimension !== "period" && !filters.period.has(r.reportingPeriod)) return false;
    if (filters.coverage.size && excludeDimension !== "coverage" && !filters.coverage.has(r.coverageStatus)) return false;
    return true;
  });
}

function uniqueSorted(records, field) {
  return Array.from(new Set(records.map((r) => r[field]).filter(Boolean))).sort();
}

const SLICER_FIELD_MAP = {
  region: "region",
  district: "district",
  catchment: "catchment",
  site: null, // derived via siteKey()/siteLabel()
  period: "reportingPeriod",
  sector: "sector",
  agency: "agency",
  coverage: "coverageStatus",
};

function initSlicers() {
  Object.keys(SLICER_FIELD_MAP).forEach((dimension) => {
    const container = document.getElementById(`filter-${dimension}`);
    if (!container) return;
    slicers[dimension] = new MultiSelect(`filter-${dimension}`, {
      onChange: (values) => {
        filters[dimension] = new Set(values);
        applyFilters();
      },
    });
  });
}

function refreshSlicerOptions() {
  Object.entries(slicers).forEach(([dimension, slicer]) => {
    const scoped = filtered(dimension); // cascading: every OTHER filter still applies

    let values;
    if (dimension === "site") {
      const seen = new Map();
      scoped.forEach((r) => {
        const key = siteKey(r);
        if (key && !seen.has(key)) seen.set(key, siteLabel(r));
      });
      values = Array.from(seen.entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    } else if (dimension === "coverage") {
      const present = new Set(scoped.map((r) => r.coverageStatus).filter(Boolean));
      values = ["Yes", "No", "Unknown"]
        .filter((v) => present.has(v))
        .map((v) => [v, t(v === "Yes" ? "chart_yes" : v === "No" ? "chart_no" : "chart_unknown")]);
    } else {
      values = uniqueSorted(scoped, SLICER_FIELD_MAP[dimension]).map((v) => [v, v]);
    }

    const selectionChanged = slicer.setOptions(values);
    if (selectionChanged) filters[dimension] = new Set(slicer.getSelected());
  });
}

function syncSlicerSelections() {
  Object.entries(slicers).forEach(([dimension, slicer]) => {
    slicer.setSelected(Array.from(filters[dimension]));
  });
}

function renderCaption() {
  const records = filtered();
  const caption = document.getElementById("filter-caption");
  const bits = [];
  if (filters.sector.size) bits.push(t("caption_services", { sector: Array.from(filters.sector).join(", ") }));
  if (filters.district.size) bits.push(t("caption_in_district", { district: Array.from(filters.district).join(", ") }));
  else if (filters.region.size) bits.push(t("caption_in_district", { district: Array.from(filters.region).join(", ") }));
  if (filters.agency.size) bits.push(t("caption_by_agency", { agency: Array.from(filters.agency).join(", ") }));

  const assessedSites = new Set(records.map(siteKey).filter(Boolean)).size;

  if (!bits.length && !filters.site.size && !filters.period.size && !filters.coverage.size) {
    caption.textContent = t("caption_default");
    return;
  }
  caption.textContent = t("caption_filtered", {
    what: bits.join(" ") || t("ms_n_selected", { n: assessedSites }),
    n: assessedSites.toLocaleString(),
  });
}

// Cross-filter toggle from chart/map/table clicks. Ctrl/Cmd-click adds to
// the selection; plain click replaces it; clicking the only selected value
// clears the selection.
function toggleFilterValue(dimension, value, additive) {
  if (!value) return;
  const set = filters[dimension];
  if (!additive) {
    if (set.size === 1 && set.has(value)) {
      set.clear();
    } else {
      set.clear();
      set.add(value);
    }
  } else if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
  applyFilters();
}

function resetFilters() {
  Object.keys(filters).forEach((k) => filters[k].clear());
  applyFilters();
}

function applyFilters() {
  refreshSlicerOptions();
  syncSlicerSelections();
  renderCaption();
  renderAll();
}
