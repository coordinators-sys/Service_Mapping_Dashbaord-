// Application bootstrap: loads data + GeoJSON concurrently, wires every
// control, and defines renderAll() — the single function every filter
// change calls to keep every visual in sync.

// Each section renders independently. Previously a single throw — a missing
// element, one bad record — aborted the whole function, and every section
// AFTER the failure silently stopped updating while the page still looked
// populated. Stale numbers presented as current are worse than a visibly
// broken card, so a failing section is isolated and reported, and the rest
// still refresh.
function renderAll() {
  const records = filtered();
  const sections = [
    ["completeness", renderCompleteness],
    ["overview", renderOverview],
    ["gap profiles", renderGapProfiles],
    ["coverage", renderCoverage],
    ["agencies", renderAgencies],
    ["agency matrix", renderAgencyMatrix],
    ["priority gaps", renderPriorityGaps],
    ["catchments", renderCatchments],
    ["geography", renderGeography],
    ["assessments", renderAssessments],
    ["site table", renderSiteTable],
    ["data quality", renderDataQuality],
  ];
  const failed = [];
  for (const [name, render] of sections) {
    try {
      render(records);
    } catch (err) {
      failed.push(name);
      console.error(`[service-mapping] section "${name}" failed to render`, err);
    }
  }
  try {
    updateHeaderInfo();
  } catch (err) {
    failed.push("header");
    console.error("[service-mapping] header failed to render", err);
  }
  // Never leave a partly-rendered dashboard looking complete.
  const banner = document.getElementById("api-error-banner");
  if (failed.length && banner) {
    banner.textContent = t("section_render_failed", { sections: failed.join(", ") });
    banner.classList.remove("hidden");
  }
}

// Explicit dashboard states. A temporary zero is indistinguishable from a
// confirmed zero, so until a successful response proves otherwise the page
// shows skeletons and no numbers at all: "0 assessed sites" during loading was
// being read as a real result. Only `ready` and `empty` may show figures, and
// `empty` is reachable only after the API has answered.
const DASH_STATES = ["initial", "loading", "slow", "ready", "empty", "stale", "error"];
// Data older than this is presented as possibly outdated rather than current.
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

function setDashState(next) {
  if (DASH_STATES.indexOf(next) === -1) return;
  state.dashState = next;
  const busy = next === "initial" || next === "loading" || next === "slow";
  document.body.dataset.dashState = next;
  document.body.classList.toggle("is-loading-data", busy);
  document.getElementById("loading-banner").classList.toggle("hidden", !busy);
  document.getElementById("loading-banner").classList.toggle("slow", next === "slow");
  // Filters and downloads act on data that is not there yet; leaving them live
  // during load invites a click that silently does nothing.
  document.querySelectorAll("#btn-open-filters, #btn-download, .ms-trigger").forEach((el) => {
    el.disabled = busy;
    el.setAttribute("aria-disabled", busy ? "true" : "false");
  });
}

function setLoading(isLoading) {
  setDashState(isLoading ? "loading" : "ready");
}

// Called after every filter application, once data is present.
function refreshResultState() {
  if (state.dashState === "error") return;
  const hasRecords = filtered().length > 0;
  const empty = document.getElementById("empty-banner");
  if (empty) {
    empty.classList.toggle("hidden", hasRecords);
    if (!hasRecords) {
      empty.innerHTML = `<span>${escapeHtml(t("empty_state"))}</span>`;
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "btn btn-light";
      reset.textContent = t("reset_filters_action");
      reset.addEventListener("click", () => resetFilters());
      empty.appendChild(reset);
    }
  }

  // Stale is a statement about the DATA's age, distinct from an error (the
  // request failed) and from empty (the request succeeded and matched nothing).
  const staleBanner = document.getElementById("stale-banner");
  const syncedAt = state.generatedAt ? new Date(state.generatedAt).getTime() : null;
  const isStale = syncedAt != null && Date.now() - syncedAt > STALE_AFTER_MS;
  if (staleBanner) {
    staleBanner.classList.toggle("hidden", !isStale);
    if (isStale) staleBanner.textContent = t("stale_state", { sync: new Date(syncedAt).toLocaleString() });
  }
  setDashState(isStale ? "stale" : hasRecords ? "ready" : "empty");
}

// In the public tier the payload carries no site identity, so any surface whose
// only purpose is to name an individual site has nothing to show. Those are
// REMOVED from the document rather than hidden with CSS: a hidden element still
// renders 662 rows of "withheld" into the DOM, still lands in the accessibility
// tree, and still ends up in a screenshot if a stylesheet fails to load.
function applyPublicTier() {
  const remove = (selector) => document.querySelectorAll(selector).forEach((el) => el.remove());
  // The sites table and its section nav link: one row per site, all unnamed.
  remove("#section-sites");
  remove('.section-nav-link[href="#section-sites"]');
  // The site-name filter: nothing left to filter by.
  const siteFilter = document.getElementById("filter-site");
  if (siteFilter && siteFilter.closest(".filter-field")) siteFilter.closest(".filter-field").remove();
  // Export routes that exist to list individual sites, row by row. "Sites and
  // coverage" and "Priority service gaps" would otherwise emit one row per
  // unnamed site — and the gaps file is the most sensitive shape in the whole
  // product, being a ranked list of the least-served locations. The remaining
  // exports (sector, agency, catchment, district, assessment) are aggregate or
  // carry no site identity, and stay.
  remove('[data-export="sites"]');
  remove('[data-export="gaps"]');
  // "Priority sites requiring follow-up" is a per-site list. Without names it
  // is ten identical rows, and the district-level card beside it ("Top
  // underserved districts") already answers the question the section exists to
  // answer. The gap KPIs above it are unaffected.
  const prioritySites = document.getElementById("priority-sites-list");
  if (prioritySites && prioritySites.closest(".card")) prioritySites.closest(".card").remove();
  const grid = document.querySelector("#section-priority .chart-grid-equal");
  if (grid) grid.classList.remove("chart-grid-equal");
}

function showApiError(message) {
  const banner = document.getElementById("api-error-banner");
  banner.innerHTML = "";
  banner.appendChild(document.createTextNode(message + " "));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn btn-light btn-retry";
  retry.textContent = t("retry");
  retry.addEventListener("click", () => {
    banner.classList.add("hidden");
    loadData();
  });
  banner.appendChild(retry);
  banner.classList.remove("hidden");
}

function updateHeaderInfo() {
  const records = filtered();
  // The banner leads with ASSESSMENTS because that is the only honest
  // mixed-grain headline: a district assessment is real work that no site
  // count can represent. Matched master-list sites is shown beside it, named
  // so the two can never be read as the same quantity. Both come from
  // canonicalMetrics, so the banner cannot disagree with the KPIs below it.
  const metrics = canonicalMetrics(records);
  // Header period ALWAYS matches the period filter: the selected period(s)
  // when filtered, "All periods" when not — so the two can never disagree.
  const currentPeriod = filters.period.size ? Array.from(filters.period).sort().join(", ") : t("all_periods");
  const lastSync = state.generatedAt ? new Date(state.generatedAt).toLocaleString() : t("header_never");
  document.getElementById("header-info-line").textContent = t("header_info", {
    period: currentPeriod,
    n: metrics.assessments.toLocaleString(),
    m: metrics.matchedMasterSites.toLocaleString(),
    sync: lastSync,
  });
}

// The API's serverless function can cold-start for several seconds, so
// "still loading" and "actually stuck" look identical without a timeout.
// A slow-load notice appears first (informative, not alarming); past
// HARD_TIMEOUT_MS the fetch is aborted and treated as a real failure with a
// retry action — the page never sits on an indefinite spinner.
const SLOW_LOAD_NOTICE_MS = 8000;
const HARD_TIMEOUT_MS = 25000;

async function loadData() {
  setLoading(true);
  const loadingBanner = document.getElementById("loading-banner");
  loadingBanner.classList.remove("slow");
  document.getElementById("api-error-banner").classList.add("hidden");
  const slowTimer = setTimeout(() => setDashState("slow"), SLOW_LOAD_NOTICE_MS);
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  try {
    const [payload, districts, catchments, regions, partnerStatus] = await Promise.all([
      fetch("/api/service-mapping", { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error(`API ${response.status}`);
        return response.json();
      }),
      fetch("geo/districts.geojson").then((r) => r.json()).catch(() => null),
      fetch("geo/catchments.geojson").then((r) => r.json()).catch(() => null),
      fetch("geo/regions.geojson").then((r) => r.json()).catch(() => null),
      fetch("data/partner-update-status.json").then((r) => r.json()).catch(() => null),
    ]);

    state.all = payload.records || [];
    state.summary = payload.summary || null;
    state.masterSites = payload.masterSites || null;
    // reason code -> explanation, published once instead of on every record.
    state.reasonCodeCatalog = payload.reasonCodeCatalog || {};
    // "public" means the payload carries no site identity. Sections that exist
    // only to name individual sites are removed rather than left showing rows
    // of "withheld", which would be noise pretending to be data.
    state.tier = payload.tier || "partner";
    document.body.dataset.tier = state.tier;
    if (state.tier === "public") applyPublicTier();
    state.generatedAt = payload.generatedAt || null;
    state.source = payload.source || null;
    state.geo = { districts, catchments, regions };
    state.partnerUpdateStatus = (partnerStatus && partnerStatus.entries) || [];

    if (payload.source === "no-kobo-credentials") {
      showApiError("No Kobo credentials configured on the server yet — showing an empty dashboard. Set KOBO_BASE_URL / KOBO_ASSET_UID / KOBO_API_TOKEN as environment variables.");
    } else if (payload.source === "error") {
      showApiError(`Could not reach KoboToolbox: ${payload.error || "unknown error"}. Showing an empty dashboard.`);
    }
  } catch (err) {
    // Never replace known-good figures with zeros on failure: an error means we
    // do not know the current numbers, which is not the same as knowing they
    // are zero. Whatever was last loaded stays on screen behind the banner.
    setDashState("error");
    console.error("[service-mapping] load failed", {
      endpoint: "/api/service-mapping",
      status: err && err.status ? err.status : undefined,
      name: err && err.name,
      at: new Date().toISOString(),
    });
    const timedOut = err.name === "AbortError";
    const lastKnown = state.generatedAt ? new Date(state.generatedAt).toLocaleString() : null;
    const suffix = lastKnown ? ` Showing the last successfully synced data (${lastKnown}).` : " Showing an empty dashboard.";
    showApiError(
      (timedOut
        ? `Data request timed out after ${HARD_TIMEOUT_MS / 1000}s — the server may be starting up.`
        : `Could not load service-mapping data (${err.message}).`) + suffix
    );
    if (!state.all) state.all = [];
  } finally {
    clearTimeout(slowTimer);
    clearTimeout(hardTimer);
    loadingBanner.classList.remove("slow");
    setLoading(false);
    // Load UNFILTERED. Applying a period filter automatically made the
    // dashboard open in a state the visitor did not choose, with a filter chip
    // they had to notice and clear. That is safe to drop now: with no period
    // selected, coverage runs on latest-site-status cells (semantic.js
    // latestStatusCells), so a site reporting in several months still counts
    // once — the double-counting that originally justified the default is
    // handled in the analytical layer, not by pre-filtering the view.
    populateInitialFilterOptions();
    restoreFiltersFromUrl();
    syncSlicerSelections();
    applyFilters();
  }
}

function populateInitialFilterOptions() {
  refreshSlicerOptions();
}

// Methodology wording lives in the translation dictionaries (EN + SO) so it
// follows the interface language; rendered as HTML in the drawer AND
// exported as plain text via the download menu from the same source.
function methodologySections() {
  const dict = TRANSLATIONS[currentLang()] || TRANSLATIONS.en;
  return dict.methodology || TRANSLATIONS.en.methodology || [];
}

function buildMethodologyContent() {
  return `
    <h2>${t("meth_title")}</h2>
    ${methodologySections().map(([h, b]) => `<p><strong>${h}</strong> — ${b}</p>`).join("")}
    <p style="color:var(--text-muted);font-size:0.8rem;">${t("meth_updated")}</p>
    <button type="button" class="btn btn-primary" id="btn-download-methodology">${t("download_methodology")}</button>
  `;
}

function buildMethodologyText() {
  return [
    `CCCM Cluster Somalia — Service Mapping Dashboard: ${t("meth_title")}`,
    "",
    ...methodologySections().map(([h, b]) => `${h}:\n${b}\n`),
    t("meth_updated"),
  ].join("\n");
}

function initTheme() {
  const preferences = Object.assign({ theme: "system", language: "en" }, JSON.parse(localStorage.getItem("cccm-service-mapping-preferences") || "{}"));
  applyTheme(preferences.theme);
  applyTranslations(preferences.language);
  document.getElementById("lang-switch").value = preferences.language;

  document.getElementById("btn-theme").addEventListener("click", () => {
    const current = localStorage.getItem("cccm-service-mapping-preferences");
    const prefs = Object.assign({ theme: "system", language: "en" }, JSON.parse(current || "{}"));
    prefs.theme = prefs.theme === "dark" ? "light" : "dark";
    localStorage.setItem("cccm-service-mapping-preferences", JSON.stringify(prefs));
    applyTheme(prefs.theme);
  });

  document.getElementById("lang-switch").addEventListener("change", (e) => {
    const current = localStorage.getItem("cccm-service-mapping-preferences");
    const prefs = Object.assign({ theme: "system", language: "en" }, JSON.parse(current || "{}"));
    prefs.language = e.target.value;
    localStorage.setItem("cccm-service-mapping-preferences", JSON.stringify(prefs));
    applyTranslations(prefs.language);
    // Dynamic content (KPIs, charts, table, legend, insights, multi-select
    // chrome) renders via t() — re-run the full pipeline in the new language.
    MultiSelect.instances.forEach((ms) => ms.renderChrome());
    applyFilters();
  });
}

function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

// Mobile filter drawer. Selections apply live (same as desktop), so
// "Apply filters" just closes the drawer — the dashboard is already updated
// behind it; the button exists because users expect a confirm affordance.
function setupFilterDrawer() {
  const panel = document.getElementById("filter-panel");
  const overlay = document.getElementById("filter-overlay");
  const openBtn = document.getElementById("btn-open-filters");

  const open = () => {
    panel.classList.add("open");
    overlay.hidden = false;
    document.body.classList.add("filters-open");
    openBtn.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    panel.classList.remove("open");
    overlay.hidden = true;
    document.body.classList.remove("filters-open");
    openBtn.setAttribute("aria-expanded", "false");
    MultiSelect.closeAll();
  };

  openBtn.addEventListener("click", open);
  document.getElementById("btn-close-filters").addEventListener("click", close);
  document.getElementById("btn-apply-filters").addEventListener("click", close);
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) close();
  });
}

function setupEventListeners() {
  // Filter widgets are MultiSelect instances (created by initSlicers) whose
  // onChange callbacks already update `filters` and call applyFilters().
  document.getElementById("btn-reset-filters").addEventListener("click", resetFilters);
  setupFilterDrawer();
  document.getElementById("sort-sector-bar").addEventListener("change", () => renderCoverage(filtered()));
  document.getElementById("heatmap-row-level") && document.getElementById("heatmap-row-level").addEventListener("change", () => renderAgencies(filtered()));
  document.getElementById("map-mode").addEventListener("change", () => renderGeography(filtered()));
  const mapLayer = document.getElementById("map-layer");
  if (mapLayer) mapLayer.addEventListener("change", () => renderGeography(filtered()));
  document.getElementById("btn-reset-map").addEventListener("click", resetMapView);
  // Catchment overview starts capped to the chart card's height; the button
  // removes/restores the cap so the full list is one click away.
  [["btn-assessment-expand","assessment-table-scroll"],["btn-catchment-expand","catchment-table-scroll"]].forEach(([btnId,scrollId])=>{
    const b=document.getElementById(btnId), sc=document.getElementById(scrollId);
    if(!b||!sc||b.dataset.wired) return;
    b.dataset.wired="1";
    b.addEventListener("click",()=>{
      const expanded = sc.classList.toggle("table-capped") === false;
      b.setAttribute("aria-expanded",String(expanded));
      b.textContent = t(expanded ? "show_less" : "show_full_list");
      if(!expanded) sc.scrollIntoView({block:"nearest"});
    });
  });
  const catchExpand = document.getElementById("btn-catchment-expand");
  if (catchExpand) catchExpand.addEventListener("click", () => {
    const scroll = document.getElementById("catchment-table-scroll");
    const expanded = scroll.classList.toggle("table-capped") === false;
    catchExpand.setAttribute("aria-expanded", String(expanded));
    catchExpand.textContent = t(expanded ? "show_less" : "show_full_list");
    if (!expanded) scroll.scrollIntoView({ block: "nearest" });
  });
  document.getElementById("btn-fullscreen-map").addEventListener("click", toggleMapFullscreen);

  document.getElementById("btn-export-csv").addEventListener("click", exportFilteredRecords);
  document.getElementById("btn-download").addEventListener("click", () => {
    document.getElementById("download-drawer").classList.remove("hidden");
    document.getElementById("download-overlay").classList.remove("hidden");
  });
  document.getElementById("download-close").addEventListener("click", closeDownloadMenu);
  document.getElementById("download-overlay").addEventListener("click", closeDownloadMenu);
  document.querySelectorAll("[data-export]").forEach((btn) => {
    btn.addEventListener("click", () => { exportByKind(btn.dataset.export); closeDownloadMenu(); });
  });

  document.getElementById("btn-settings").addEventListener("click", () => {
    document.getElementById("methodology-content").innerHTML = buildMethodologyContent();
    document.getElementById("methodology-drawer").classList.remove("hidden");
    document.getElementById("methodology-overlay").classList.remove("hidden");
    const dl = document.getElementById("btn-download-methodology");
    if (dl) dl.addEventListener("click", () => exportByKind("methodology"));
  });
  document.getElementById("methodology-close").addEventListener("click", closeMethodology);
  document.getElementById("methodology-overlay").addEventListener("click", closeMethodology);

  document.getElementById("drawer-close").addEventListener("click", closeSiteDrawer);
  document.getElementById("drawer-overlay").addEventListener("click", closeSiteDrawer);

  setupTableInteractions();
}

function closeDownloadMenu() {
  document.getElementById("download-drawer").classList.add("hidden");
  document.getElementById("download-overlay").classList.add("hidden");
}
function closeMethodology() {
  document.getElementById("methodology-drawer").classList.add("hidden");
  document.getElementById("methodology-overlay").classList.add("hidden");
}

// Sticky section-nav: highlight the section in view, and keep the URL hash in
// sync without the default jump (scroll-margin-top on .section handles the
// sticky-bar offset). Uses IntersectionObserver — cheap, no scroll handler.
function setupSectionNav() {
  const links = Array.from(document.querySelectorAll(".section-nav-link"));
  if (!links.length) return;
  const byId = new Map(links.map((l) => [l.getAttribute("href").slice(1), l]));
  const sections = links
    .map((l) => document.getElementById(l.getAttribute("href").slice(1)))
    .filter(Boolean);

  const setActive = (id) => {
    links.forEach((l) => l.classList.toggle("active", l.getAttribute("href").slice(1) === id));
    const active = byId.get(id);
    if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    },
    { rootMargin: "-130px 0px -55% 0px", threshold: 0 }
  );
  sections.forEach((s) => observer.observe(s));

  links.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const id = link.getAttribute("href").slice(1);
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        history.replaceState(null, "", `#${id}`); // update hash without a second jump
        setActive(id);
      }
    });
  });
}

// CSP-safe replacement for inline onerror attributes on sector icons:
// a delegated capture-phase listener hides any icon that fails to load.
document.addEventListener("error", (e) => {
  const el = e.target;
  if (el && el.tagName === "IMG" && el.classList && el.classList.contains("sector-icon")) {
    el.style.display = "none";
  }
}, true);

// Bumped alongside the asset cache-bust query param (index.html ?v=N) so the
// footer always names the build actually being served.
const DASHBOARD_BUILD = "v55";

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initSlicers();
  setupEventListeners();
  setupSectionNav();
  const buildEl = document.getElementById("footer-build");
  if (buildEl) buildEl.textContent = `Build ${DASHBOARD_BUILD}`;
  loadData();
});
