// Application bootstrap: loads data + GeoJSON concurrently, wires every
// control, and defines renderAll() — the single function every filter
// change calls to keep every visual in sync.

function renderAll() {
  const records = filtered();
  renderCompleteness(records);
  renderOverview(records);
  renderGapProfiles(records);
  renderCoverage(records);
  renderAgencies(records);
  renderAgencyMatrix(records);
  renderPriorityGaps(records);
  renderCatchments(records);
  renderGeography(records);
  renderSiteTable(records);
  renderDataQuality(records);
  updateHeaderInfo();
}

function setLoading(isLoading) {
  document.getElementById("loading-banner").classList.toggle("hidden", !isLoading);
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
  // Same official population as the headline KPI (verified matched sites
  // with >=1 assessed sector) so the header can never disagree with it.
  const assessedSites = computeSiteGapProfiles(records).filter((s) => s.assessed).length;
  // Header period ALWAYS matches the period filter: the selected period(s)
  // when filtered, "All periods" when not — so the two can never disagree.
  const currentPeriod = filters.period.size ? Array.from(filters.period).sort().join(", ") : t("all_periods");
  const lastSync = state.generatedAt ? new Date(state.generatedAt).toLocaleString() : t("header_never");
  document.getElementById("header-info-line").textContent = t("header_info", {
    period: currentPeriod,
    n: assessedSites.toLocaleString(),
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
  const slowTimer = setTimeout(() => loadingBanner.classList.add("slow"), SLOW_LOAD_NOTICE_MS);
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  try {
    const [payload, districts, catchments, regions] = await Promise.all([
      fetch("/api/service-mapping", { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error(`API ${response.status}`);
        return response.json();
      }),
      fetch("geo/districts.geojson").then((r) => r.json()).catch(() => null),
      fetch("geo/catchments.geojson").then((r) => r.json()).catch(() => null),
      fetch("geo/regions.geojson").then((r) => r.json()).catch(() => null),
    ]);

    state.all = payload.records || [];
    state.summary = payload.summary || null;
    state.masterSites = payload.masterSites || null;
    state.generatedAt = payload.generatedAt || null;
    state.source = payload.source || null;
    state.geo = { districts, catchments, regions };

    if (payload.source === "no-kobo-credentials") {
      showApiError("No Kobo credentials configured on the server yet — showing an empty dashboard. Set KOBO_BASE_URL / KOBO_ASSET_UID / KOBO_API_TOKEN as environment variables.");
    } else if (payload.source === "error") {
      showApiError(`Could not reach KoboToolbox: ${payload.error || "unknown error"}. Showing an empty dashboard.`);
    }
  } catch (err) {
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
    // Default to the LATEST COMPLETED reporting month: an "All periods" load
    // mixes reporting rounds, and (before the latest-status collapse) counted
    // a site once per month it reported. All-period views remain one click
    // away (clear the period chip) and now use latest-site-status semantics.
    defaultPeriodSelection();
    populateInitialFilterOptions();
    restoreFiltersFromUrl();
    syncSlicerSelections();
    applyFilters();
  }
}

function populateInitialFilterOptions() {
  refreshSlicerOptions();
}

function defaultPeriodSelection() {
  const counts = new Map();
  state.all.forEach((r) => {
    if (r.reportingPeriod) counts.set(r.reportingPeriod, (counts.get(r.reportingPeriod) || 0) + 1);
  });
  const periods = Array.from(counts.keys()).sort();
  if (!periods.length) return;
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  // Latest COMPLETED month (the in-progress month is not a finished round)
  // that also carries SUBSTANTIAL reporting — a thin partial month (e.g. a
  // handful of late submissions) would land visitors on a near-empty view.
  const maxCount = Math.max(...counts.values());
  const threshold = Math.max(100, maxCount * 0.1);
  const candidates = periods.filter((p) => p !== currentMonth && counts.get(p) >= threshold);
  const pick = candidates.length
    ? candidates[candidates.length - 1]
    : periods.reduce((a, b) => (counts.get(b) >= counts.get(a) ? b : a)); // biggest round as fallback
  filters.period = new Set([pick]);
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
  document.getElementById("btn-reset-map").addEventListener("click", resetMapView);
  // Catchment overview starts capped to the chart card's height; the button
  // removes/restores the cap so the full list is one click away.
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
const DASHBOARD_BUILD = "v35";

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initSlicers();
  setupEventListeners();
  setupSectionNav();
  const buildEl = document.getElementById("footer-build");
  if (buildEl) buildEl.textContent = `Build ${DASHBOARD_BUILD}`;
  loadData();
});
