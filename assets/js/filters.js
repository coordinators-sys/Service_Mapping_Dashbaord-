// Centralized application state + filter state. Every chart/KPI/table/map
// reads from `filtered()` — one source of truth for "what's selected".
// MultiSelect widgets (multiselect.js) render options and report changes;
// they never hold authoritative state of their own.

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
  catchment: new Set(),
  site: new Set(),
  period: new Set(),
  sector: new Set(),
  agency: new Set(),
  source: new Set(),
  service: new Set(),
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
    if (filters.source.size && excludeDimension !== "source" && !filters.source.has(r.dataSource)) return false;
    return true;
  });
}

function uniqueSorted(records, field) {
  return Array.from(new Set(records.map((r) => r[field]).filter(Boolean))).sort();
}

// Catchment values are district-qualified ("Baidoa · CA01") because CA codes
// repeat across districts — split them so the UI can group by district and
// show just "CA01" under a heading. Technical suffixes from the shapefile
// (_GN/_GS = Gaalkacyo North/South) become part of the readable group name;
// the raw value stays untouched for filtering, and full codes remain in
// tooltips and exports.
const CA_SUFFIXES = { _GN: "North", _GS: "South" };

function splitCatchment(value) {
  const idx = String(value).indexOf(" · ");
  if (idx === -1) return { group: null, label: String(value) };
  let group = String(value).slice(0, idx);
  let label = String(value).slice(idx + 3);
  const suffix = Object.keys(CA_SUFFIXES).find((s) => label.endsWith(s));
  if (suffix) {
    group = `${group} ${CA_SUFFIXES[suffix]}`;
    label = label.slice(0, -suffix.length);
  }
  return { group, label };
}

// Both record streams are collected under the SAME cluster exercise, so the
// public labels carry CCCM Cluster branding, not the hosting platform's name.
// Internal dataSource values ("kobo"/"zitemanager") are unchanged.
function sourceLabel(v) {
  return v === "kobo" ? "CCCM Service Mapping Tool" : v === "zitemanager" ? "CCCM Provider Directory" : String(v);
}

// Readable form of a raw catchment value: "Gaalkacyo · CA01_GN" -> "Gaalkacyo North · CA01"
function friendlyCatchment(value) {
  if (!value) return value;
  const { group, label } = splitCatchment(value);
  return group ? `${group} · ${label}` : label;
}

// NOTE: "source" is intentionally NOT a slicer. Both feeds (the CCCM service
// mapping Kobo form and the cluster provider directory) are CCCM cluster data,
// and the semantic layer already counts a site reported by both only once, so
// exposing the split asked end users to reason about collection pipelines.
// filters.source remains in state (empty = no restriction) so filtered() and
// any future internal view keep working without a rewrite.
const SLICER_CONFIG = [
  { dimension: "region", labelKey: "f_region", nounKey: "noun_regions" },
  { dimension: "district", labelKey: "f_district", nounKey: "noun_districts" },
  { dimension: "catchment", labelKey: "f_catchment", nounKey: "noun_catchments", groupBy: true },
  { dimension: "site", labelKey: "f_site", nounKey: "noun_sites", groupBy: true },
  { dimension: "period", labelKey: "f_period", nounKey: "noun_periods" },
  { dimension: "sector", labelKey: "f_sector", nounKey: "noun_sectors" },
  { dimension: "agency", labelKey: "f_agency", nounKey: "noun_agencies" },
  { dimension: "coverage", labelKey: "f_coverage", nounKey: "noun_statuses" },
];

function initSlicers() {
  SLICER_CONFIG.forEach(({ dimension, nounKey, groupBy }) => {
    const container = document.getElementById(`filter-${dimension}`);
    if (!container) return;
    slicers[dimension] = createMultiSelect({
      dimension,
      container,
      placeholder: t("ms_all"),
      searchPlaceholder: t("ms_search_noun", { noun: t(nounKey) }),
      countNoun: t(nounKey),
      groupBy,
      onChange: (values) => {
        filters[dimension] = new Set(values);
        applyFilters();
      },
    });
    slicers[dimension]._nounKey = nounKey;
  });
}

function buildOptions(dimension) {
  const scoped = filtered(dimension); // cascading: every OTHER filter still applies

  if (dimension === "site") {
    const seen = new Map();
    scoped.forEach((r) => {
      const key = siteKey(r);
      if (key && !seen.has(key)) seen.set(key, { value: key, label: siteLabel(r), group: r.district || null });
    });
    return Array.from(seen.values()).sort(
      (a, b) => String(a.group).localeCompare(String(b.group)) || String(a.label).localeCompare(String(b.label))
    );
  }

  if (dimension === "catchment") {
    return uniqueSorted(scoped, "catchment").map((v) => ({ value: v, ...splitCatchment(v) }));
  }

  if (dimension === "source") {
    const present = Array.from(new Set(scoped.map((r) => r.dataSource).filter(Boolean))).sort();
    return present.map((v) => ({ value: v, label: sourceLabel(v) }));
  }

  if (dimension === "coverage") {
    const present = new Set(scoped.map((r) => r.coverageStatus).filter(Boolean));
    return ["Yes", "No", "Unknown"]
      .filter((v) => present.has(v))
      .map((v) => ({ value: v, label: t(v === "Yes" ? "chart_yes" : v === "No" ? "chart_no" : "chart_unknown") }));
  }

  const field = { region: "region", district: "district", period: "reportingPeriod", sector: "sector", agency: "agency" }[dimension];
  return uniqueSorted(scoped, field).map((v) => ({ value: v, label: v }));
}

// Refresh every dropdown's options against the current cascade, and report
// any selections that had to be dropped because they're no longer reachable.
function refreshSlicerOptions() {
  const removedByDimension = {};
  Object.entries(slicers).forEach(([dimension, slicer]) => {
    const removed = slicer.setOptions(buildOptions(dimension));
    if (removed.length) {
      filters[dimension] = new Set(slicer.getSelected());
      removedByDimension[dimension] = removed;
    }
  });
  return removedByDimension;
}

function syncSlicerSelections() {
  Object.entries(slicers).forEach(([dimension, slicer]) => slicer.sync(Array.from(filters[dimension])));
}

// Human label for a raw filter value (chips, notifications).
function displayValue(dimension, value) {
  if (dimension === "catchment") {
    const { group, label } = splitCatchment(value);
    return filters.district.size === 1 && group ? label : friendlyCatchment(value);
  }
  if (dimension === "site") {
    const rec = state.all.find((r) => siteKey(r) === value);
    return rec ? siteLabel(rec) : value;
  }
  if (dimension === "source") {
    const present = Array.from(new Set(scoped.map((r) => r.dataSource).filter(Boolean))).sort();
    return present.map((v) => ({ value: v, label: sourceLabel(v) }));
  }

  if (dimension === "coverage") {
    return t(value === "Yes" ? "chart_yes" : value === "No" ? "chart_no" : "chart_unknown");
  }
  if (dimension === "source") return sourceLabel(value);
  return String(value);
}

function activeFilterCount() {
  return Object.values(filters).reduce((sum, set) => sum + set.size, 0);
}

function isDefaultState() {
  return activeFilterCount() === 0;
}

function renderChips() {
  const container = document.getElementById("filter-chips");
  if (!container) return;
  const chips = [];
  SLICER_CONFIG.forEach(({ dimension }) => {
    filters[dimension].forEach((value) => {
      chips.push(
        `<button type="button" class="chip" data-dimension="${dimension}" data-value="${escapeHtml(value)}">
           <span class="chip-label">${escapeHtml(displayValue(dimension, value))}</span><span class="chip-x" aria-hidden="true">×</span>
         </button>`
      );
    });
  });

  if (!chips.length) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML =
    `<span class="chips-label">${t("active_filters")}</span>${chips.join("")}` +
    `<button type="button" class="chip chip-clear" id="chip-clear-all">${t("clear_all")}</button>`;

  container.querySelectorAll(".chip[data-dimension]").forEach((chip) => {
    chip.addEventListener("click", () => {
      filters[chip.dataset.dimension].delete(chip.dataset.value);
      applyFilters();
    });
  });
  const clearAll = container.querySelector("#chip-clear-all");
  if (clearAll) clearAll.addEventListener("click", resetFilters);
}

function renderCaption() {
  const records = filtered();
  const caption = document.getElementById("filter-caption");
  if (!caption) return;

  if (isDefaultState()) {
    caption.textContent = t("caption_default");
  } else {
    const shownSites = new Set(records.map(siteKey).filter(Boolean)).size;
    const totalSites = new Set(state.all.map(siteKey).filter(Boolean)).size;
    const catchments = new Set(records.map((r) => r.catchment).filter(Boolean)).size;
    const counts = { shown: shownSites.toLocaleString(), total: totalSites.toLocaleString(), ca: catchments };
    const key = !catchments ? "caption_count" : catchments === 1 ? "caption_count_ca_one" : "caption_count_ca";
    caption.textContent = t(key, counts);
  }

  const resetBtn = document.getElementById("btn-reset-filters");
  if (resetBtn) resetBtn.disabled = isDefaultState();

  const mobileCount = document.getElementById("mobile-filter-count");
  if (mobileCount) {
    const n = activeFilterCount();
    mobileCount.textContent = n ? ` (${n})` : "";
  }
}

// Transient inline notice when a cascade invalidates downstream selections —
// silently dropping them would leave users wondering where their filter went.
let _noticeTimer = null;
function notifyRemoved(removedByDimension) {
  const el = document.getElementById("filter-notice");
  if (!el) return;
  const parts = Object.entries(removedByDimension).map(([dimension, values]) =>
    `${values.map((v) => displayValue(dimension, v)).join(", ")}`
  );
  if (!parts.length) return;
  el.textContent = t("notice_removed", { items: parts.join("; ") });
  el.hidden = false;
  clearTimeout(_noticeTimer);
  _noticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// Cross-filter toggle from chart/map/table clicks. Ctrl/Cmd-click adds to
// the selection; plain click replaces it; clicking the only selected value
// clears the selection.
function toggleFilterValue(dimension, value, additive) {
  if (!value) return;
  const set = filters[dimension];
  if (!additive) {
    if (set.size === 1 && set.has(value)) set.clear();
    else { set.clear(); set.add(value); }
  } else if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
  applyFilters();
}

function resetFilters() {
  Object.keys(filters).forEach((k) => filters[k].clear());
  MultiSelect.closeAll();
  Object.values(slicers).forEach((s) => {
    s.searchInput.value = "";
    s.search = "";
    s.searchClear.hidden = true;
  });
  if (typeof resetMapView === "function") resetMapView();
  applyFilters();
}

function applyFilters() {
  const removed = refreshSlicerOptions();
  syncSlicerSelections();
  if (Object.keys(removed).length) notifyRemoved(removed);
  renderChips();
  renderCaption();
  renderAll();
  updateUrlFromFilters();
}

// Shareable filtered views: every active filter is reflected as a URL query
// param (comma-separated values), so "share this link" reproduces the exact
// same drill-down for a colleague. Uses replaceState (not pushState) so
// clicking through filters doesn't spam browser history; the existing
// section hash (from the sticky nav's scroll-spy) is preserved untouched.
function updateUrlFromFilters() {
  const params = new URLSearchParams();
  SLICER_CONFIG.forEach(({ dimension }) => {
    if (filters[dimension].size) params.set(dimension, Array.from(filters[dimension]).join(","));
  });
  const qs = params.toString();
  const url = `${location.pathname}${qs ? "?" + qs : ""}${location.hash}`;
  history.replaceState(history.state, "", url);
}

// Read filter state back out of the URL on load — the counterpart of
// updateUrlFromFilters(). Called once, after the record set and slicer
// options exist, so every restored value is validated against what's
// actually reachable (an old/invalid link degrades to "no filter" for that
// dimension rather than silently applying a stale value).
function restoreFiltersFromUrl() {
  const params = new URLSearchParams(location.search);
  if (!params.toString()) return;
  SLICER_CONFIG.forEach(({ dimension }) => {
    const raw = params.get(dimension);
    if (raw) filters[dimension] = new Set(raw.split(",").filter(Boolean));
  });
}
