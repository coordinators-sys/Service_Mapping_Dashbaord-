// Application bootstrap: loads data + GeoJSON concurrently, wires every
// control, and defines renderAll() — the single function every filter
// change calls to keep every visual in sync.

function renderAll() {
  const records = filtered();
  renderCompleteness(records);
  renderOverview(records);
  renderCoverage(records);
  renderAgencies(records);
  renderAgencyMatrix(records);
  renderSingleProviderSectors(records);
  renderPriorityGaps(records);
  renderCatchments(records);
  renderDataQuality(records);
  renderGeography(records);
  renderSiteTable(records);
  updateHeaderInfo();
}

function setLoading(isLoading) {
  document.getElementById("loading-banner").classList.toggle("hidden", !isLoading);
}

function showApiError(message) {
  const banner = document.getElementById("api-error-banner");
  banner.textContent = message;
  banner.classList.remove("hidden");
}

function updateHeaderInfo() {
  const records = filtered();
  const assessedSites = new Set(records.map(siteKey).filter(Boolean)).size;
  const periods = Array.from(new Set(state.all.map((r) => r.reportingPeriod).filter(Boolean))).sort();
  const currentPeriod = periods.length ? periods[periods.length - 1] : "—";
  const lastSync = state.generatedAt ? new Date(state.generatedAt).toLocaleString() : t("header_never");
  document.getElementById("header-info-line").textContent = t("header_info", {
    period: currentPeriod,
    n: assessedSites.toLocaleString(),
    sync: lastSync,
  });
}

async function loadData() {
  setLoading(true);
  try {
    const [payload, districts, catchments, regions] = await Promise.all([
      fetch("/api/service-mapping").then((response) => {
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
    showApiError(`Could not load service-mapping data (${err.message}). Showing an empty dashboard.`);
    state.all = [];
  } finally {
    setLoading(false);
    populateInitialFilterOptions();
    applyFilters();
  }
}

function populateInitialFilterOptions() {
  refreshSlicerOptions();
}

// Single source of truth for methodology wording — rendered as HTML in the
// drawer AND exported as plain text via the download menu, so the two can't
// drift apart.
const METHODOLOGY_SECTIONS = [
  ["Data sources", "KoboToolbox service-mapping submissions plus IOM ZiteManager service-provider records, merged into one record set (each record is tagged with its source). Data refreshes from the sources on load, cached server-side for 5 minutes, with a daily scheduled refresh."],
  ["Reporting period", "Calendar months (YYYY-MM), derived from each submission's date. The dashboard is updated monthly."],
  ["Site denominator", "The CCCM master site list (permanent CCCM Site IDs) is the authoritative site reference. The reporting-completeness rate uses the FULL master list as denominator — no per-round 'expected to report' scope is configured yet, so that rate understates completeness where only part of the list was asked to report."],
  ["Covered", "At least one confirmed active provider delivers the sector at the site in the selected period."],
  ["Not covered (confirmed gap)", "The submission explicitly confirms the service is unavailable (a definite 'No')."],
  ["Unknown", "The question was blank, contradictory, or not assessed. Unknown is NEVER counted as 'No' — it is excluded from the coverage denominator entirely."],
  ["Coverage percentage", "Covered assessed sites ÷ (covered + not-covered assessed sites) × 100."],
  ["Sites with confirmed gaps", "Assessed sites with at least one sector explicitly confirmed unavailable."],
  ["Critical gap threshold", "A site is critical when it meets ANY of: missing 3+ priority sectors; missing all priority services; missing both Health and WASH. Priority sectors: Health, WASH, General Protection, Shelter/NFI."],
  ["Site matching hierarchy", "1) exact CCCM Site ID, 2) exact official name, 3) approved alternative name, 4) GPS proximity (150 m), 5) fuzzy name (flagged 'needs review'), 6) unmatched — flagged, never auto-created as a new site."],
  ["Catchment assignment", "Master-list sites are located inside the 2025 catchment boundary polygons; catchment labels are district-qualified (e.g. Baidoa · CA01) because CA codes repeat across districts."],
  ["Administrative names", "Region/district names are standardized against a reviewed alias table (e.g. 'Mogadishu Dayniile' → Daynile). Nothing is merged without review."],
  ["Period comparison", "Two comparisons are shown: all reported sites per period, and like-for-like (only sites reported in BOTH periods, shown when at least 20 such sites exist) so trend claims are not artifacts of a changed reporting cohort."],
  ["Known limitations", "No per-service breakdown (the form asks per sector); partner types not yet mapped; flood/river-risk layers not yet integrated; no per-round expected-reporting scope."],
];

function buildMethodologyContent() {
  return `
    <h2>Methodology &amp; indicator definitions</h2>
    ${METHODOLOGY_SECTIONS.map(([h, b]) => `<p><strong>${h}</strong> — ${b}</p>`).join("")}
    <p style="color:var(--text-muted);font-size:0.8rem;">Last methodology update: 2026-07-17.</p>
    <button type="button" class="btn btn-primary" id="btn-download-methodology">${t("download_methodology")}</button>
  `;
}

function buildMethodologyText() {
  return [
    "CCCM Cluster Somalia — Service Mapping Dashboard: Methodology & indicator definitions",
    "",
    ...METHODOLOGY_SECTIONS.map(([h, b]) => `${h}:\n${b}\n`),
    "Last methodology update: 2026-07-17",
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

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initSlicers();
  setupEventListeners();
  setupSectionNav();
  loadData();
});
