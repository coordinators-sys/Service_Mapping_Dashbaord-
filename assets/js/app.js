// Application bootstrap: loads data + GeoJSON concurrently, wires every
// control, and defines renderAll() — the single function every filter
// change calls to keep every visual in sync.

function renderAll() {
  const records = filtered();
  renderOverview(records);
  renderCoverage(records);
  renderAgencies(records);
  renderPriorityGaps(records);
  renderCatchments(records);
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

function buildMethodologyContent() {
  return `
    <h2>Methodology &amp; indicator definitions</h2>
    <p><strong>Assessed site</strong> — a distinct CCCM Site ID with a valid report during the selected reporting period.</p>
    <p><strong>Covered site</strong> — an assessed site with at least one confirmed active service provider for the selected sector.</p>
    <p><strong>Service gap</strong> — an assessed site where the selected service is confirmed unavailable.</p>
    <p><strong>Unknown</strong> — the service question was blank, not applicable, inconsistent, or not reported. Unknown values are <strong>never</strong> counted as "No" — they are excluded from the coverage percentage's denominator entirely.</p>
    <p><strong>Coverage percentage</strong> = covered assessed sites ÷ (covered + not-covered assessed sites) × 100.</p>
    <p><strong>Priority sectors</strong>: Health, WASH, General Protection, Shelter/NFI.</p>
    <p>Data source: KoboToolbox submissions, matched against the CCCM master site list by permanent CCCM Site ID first (name/GPS matching only as fallback).</p>
    <p style="color:var(--text-muted);font-size:0.8rem;">Not yet implemented in this build: shareable filtered URLs, full-screen map on mobile Safari (desktop/Chromium supported), and Somali translation of this methodology text — flagged here rather than silently omitted.</p>
  `;
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
