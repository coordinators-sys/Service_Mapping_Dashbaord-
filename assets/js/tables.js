// SERVICE COVERAGE BY LOCATION table: search, sort, pagination, badges,
// row click opens the site profile drawer. Rendered entirely client-side —
// dataset size (assessed sites in the current filter) is small enough that
// server-side pagination isn't needed per the perf requirements' "keep
// dependencies minimal" guidance.

// Pagination note: the full cleaned dataset is already client-side (the
// charts need all of it) and the API is a stateless serverless function, so
// "server-side" table paging would re-invoke a Kobo-backed function per page
// and be strictly slower. The operational goal — never render every site row
// into the DOM — is met here: only the current page (25/50/100 rows) is
// rendered, search is debounced, and page-size is user-selectable.
let tablePageSize = 25;
let tableSortField = "region";
let tableSortDir = 1;
let tablePage = 1;

// Values are [translation key, badge class]; label resolved via t() at render
// time so badges follow the interface language.
const MATCH_BADGE = {
  matched_by_site_code: ["badge_matched_id", "badge-success"],
  matched_by_official_name: ["badge_matched_name", "badge-success"],
  matched_by_alternative_name: ["badge_matched_alt", "badge-success"],
  matched_by_gps: ["badge_matched_gps", "badge-warning"],
  probable_name_match: ["badge_needs_review", "badge-warning"],
  unmatched: ["badge_unmatched", "badge-critical"],
};

function buildSiteTableRows(records) {
  const bySite = new Map();
  records.forEach((r) => {
    const key = siteKey(r);
    if (!key) return;
    if (!bySite.has(key)) {
      bySite.set(key, {
        siteKey: key, siteName: siteLabel(r), region: r.region, district: r.district,
        catchment: r.catchment, agencies: new Set(), statuses: {}, lastUpdated: r.lastUpdated,
        matchStatus: r.matchStatus, dataQualityStatus: r.dataQualityStatus,
      });
    }
    const entry = bySite.get(key);
    if (r.agency && r.coverageStatus === "Yes") entry.agencies.add(r.agency);
    if (r.sector) entry.statuses[r.sector] = entry.statuses[r.sector] === "Yes" ? "Yes" : r.coverageStatus;
    if (r.lastUpdated && (!entry.lastUpdated || r.lastUpdated > entry.lastUpdated)) entry.lastUpdated = r.lastUpdated;
  });

  return Array.from(bySite.values()).map((s) => {
    const available = SECTORS.filter((sec) => s.statuses[sec] === "Yes");
    const missing = SECTORS.filter((sec) => s.statuses[sec] === "No");
    const reportable = available.length + missing.length;
    return {
      ...s,
      activeAgencies: s.agencies.size,
      sectorsAvailable: available,
      sectorsMissing: missing,
      coverageScore: reportable ? Math.round((available.length / reportable) * 100) : null,
    };
  });
}

function renderSiteTable(records) {
  const allRows = buildSiteTableRows(records);
  const search = (document.getElementById("sites-table-search").value || "").toLowerCase().trim();
  const rows = search
    ? allRows.filter((r) =>
        [r.region, r.district, r.siteName, r.catchment, r.siteKey, ...Array.from(r.agencies)]
          .filter(Boolean).join(" ").toLowerCase().includes(search)
      )
    : allRows;

  rows.sort((a, b) => {
    const va = a[tableSortField], vb = b[tableSortField];
    if (va === vb) return 0;
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return va > vb ? tableSortDir : -tableSortDir;
  });

  document.getElementById("sites-table-count").textContent = t("n_assessed_sites", { n: allRows.length.toLocaleString() });
  _drawerSiteOrder = rows.map((r) => r.siteKey); // prev/next follows table order

  const totalPages = Math.max(1, Math.ceil(rows.length / tablePageSize));
  tablePage = Math.min(tablePage, totalPages);
  const pageRows = rows.slice((tablePage - 1) * tablePageSize, tablePage * tablePageSize);

  const tbody = document.getElementById("sites-table-body");
  tbody.innerHTML = pageRows.map((r) => {
    const [badgeKey, badgeClass] = MATCH_BADGE[r.matchStatus] || ["badge_needs_review", "badge-warning"];
    const badgeLabel = t(badgeKey);
    const rowClass = r.dataQualityStatus === "critical" ? "row-critical" : "";
    return `<tr class="${rowClass}" data-site="${r.siteKey}">
      <td>${r.region || ""}</td>
      <td>${r.district || ""}</td>
      <td>${r.siteName}</td>
      <td>${r.catchment || "—"}</td>
      <td>${r.siteKey}</td>
      <td>${r.activeAgencies}</td>
      <td>${r.sectorsAvailable.join(", ") || "—"}</td>
      <td>${r.sectorsMissing.join(", ") || "—"}</td>
      <td>${r.coverageScore === null ? "—" : r.coverageScore + "%"}</td>
      <td>${r.lastUpdated ? r.lastUpdated.slice(0, 10) : "—"}</td>
      <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
    </tr>`;
  }).join("") || `<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:24px;">${t("no_sites_match")}</td></tr>`;

  tbody.querySelectorAll("tr[data-site]").forEach((tr) => {
    tr.addEventListener("click", () => openSiteDrawer(tr.dataset.site));
  });

  renderTablePagination(totalPages);
}

function renderTablePagination(totalPages) {
  const container = document.getElementById("sites-table-pagination");
  if (totalPages <= 1) { container.innerHTML = ""; return; }
  let html = "";
  for (let p = 1; p <= totalPages; p++) {
    if (totalPages > 9 && p > 3 && p < totalPages - 2 && Math.abs(p - tablePage) > 1) {
      if (p === 4 || p === totalPages - 3) html += `<span>…</span>`;
      continue;
    }
    html += `<button class="${p === tablePage ? "active" : ""}" data-page="${p}">${p}</button>`;
  }
  container.innerHTML = html;
  container.querySelectorAll("button[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      tablePage = parseInt(btn.dataset.page, 10);
      renderSiteTable(filtered());
    });
  });
}

function setupTableInteractions() {
  let searchTimer = null;
  document.getElementById("sites-table-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      tablePage = 1;
      renderSiteTable(filtered());
    }, 200); // debounced — re-filtering ~1,900 site rows per keystroke is wasteful
  });
  const pageSize = document.getElementById("sites-table-pagesize");
  if (pageSize) pageSize.addEventListener("change", () => {
    tablePageSize = parseInt(pageSize.value, 10) || 25;
    tablePage = 1;
    renderSiteTable(filtered());
  });
  document.querySelectorAll("#sites-table th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const field = th.dataset.sort;
      if (tableSortField === field) tableSortDir *= -1;
      else { tableSortField = field; tableSortDir = 1; }
      renderSiteTable(filtered());
    });
  });
}

// Ordered site list for prev/next navigation — refreshed by renderSiteTable
// so the drawer walks the same order the user sees in the table.
let _drawerSiteOrder = [];

function openSiteDrawer(key) {
  const rows = state.all.filter((r) => siteKey(r) === key);
  if (!rows.length) return;
  const first = rows[0];
  const agencies = new Set(rows.filter((r) => r.coverageStatus === "Yes" && r.agency).map((r) => r.agency));
  const available = SECTORS.filter((s) => rows.some((r) => r.sector === s && r.coverageStatus === "Yes"));
  const missing = SECTORS.filter((s) => rows.some((r) => r.sector === s && r.coverageStatus === "No") && !available.includes(s));
  const unknown = SECTORS.filter((s) => !available.includes(s) && !missing.includes(s));
  // Agencies grouped by the sector they cover at this site.
  const agenciesBySector = available
    .map((s) => {
      const a = Array.from(new Set(rows.filter((r) => r.sector === s && r.coverageStatus === "Yes" && r.agency).map((r) => r.agency)));
      return a.length ? `${s}: ${a.join(", ")}` : null;
    })
    .filter(Boolean);
  const activities = rows.filter((r) => r.activity).map((r) => `${r.sector}: ${r.activity}`);
  const reportable = available.length + missing.length;
  const coverageScore = reportable ? Math.round((available.length / reportable) * 100) : null;
  const [badgeKey] = MATCH_BADGE[first.matchStatus] || ["badge_needs_review"];
  const lastUpdated = rows.map((r) => r.lastUpdated).filter(Boolean).sort().slice(-1)[0];
  const matchDistance = first.matchDistanceMeters != null ? `${first.matchDistanceMeters} m` : null;

  const idx = _drawerSiteOrder.indexOf(key);
  const prevKey = idx > 0 ? _drawerSiteOrder[idx - 1] : null;
  const nextKey = idx >= 0 && idx < _drawerSiteOrder.length - 1 ? _drawerSiteOrder[idx + 1] : null;

  document.getElementById("site-drawer-content").innerHTML = `
    <h2>${siteLabel(first)}</h2>
    <p style="color:var(--text-muted)">${first.matchedSiteCode || first.siteCodeRaw || ""}</p>
    <div class="drawer-actions">
      <button type="button" class="btn btn-light btn-sm" id="drawer-copy-id">${t("drawer_copy_id")}</button>
      ${first.latitude != null ? `<button type="button" class="btn btn-light btn-sm" id="drawer-zoom">${t("drawer_zoom")}</button>` : ""}
      <span class="drawer-nav">
        <button type="button" class="btn btn-light btn-sm" id="drawer-prev" ${prevKey ? "" : "disabled"}>‹</button>
        <button type="button" class="btn btn-light btn-sm" id="drawer-next" ${nextKey ? "" : "disabled"}>›</button>
      </span>
    </div>
    <table class="data-table">
      <tr><td>${t("drawer_region")}</td><td>${first.region || "—"}</td></tr>
      <tr><td>${t("drawer_district")}</td><td>${first.district || "—"}</td></tr>
      <tr><td>${t("drawer_catchment")}</td><td>${first.catchment || "—"}</td></tr>
      <tr><td>${t("drawer_coordinates")}</td><td>${first.latitude ?? "—"}, ${first.longitude ?? "—"}</td></tr>
      <tr><td>${t("drawer_coverage_score")}</td><td>${coverageScore === null ? "—" : coverageScore + "%"}</td></tr>
      <tr><td>${t("drawer_active_agencies")}</td><td>${agenciesBySector.map((x) => `<div>${x}</div>`).join("") || Array.from(agencies).join(", ") || t("drawer_none")}</td></tr>
      <tr><td>${t("drawer_available")}</td><td>${available.map((s) => `<span class="drawer-sector">${sectorIcon(s, 16)} ${s}</span>`).join("") || "—"}</td></tr>
      <tr><td>${t("drawer_missing")}</td><td>${missing.map((s) => `<span class="drawer-sector drawer-sector-missing">${sectorIcon(s, 16)} ${s}</span>`).join("") || "—"}</td></tr>
      <tr><td>${t("drawer_unknown")}</td><td>${unknown.map((s) => `<span class="drawer-sector drawer-sector-unknown">${sectorIcon(s, 16)} ${s}</span>`).join("") || "—"}</td></tr>
      <tr><td>${t("drawer_matching")}</td><td>${t(badgeKey)}${matchDistance ? ` (${matchDistance})` : ""}</td></tr>
      <tr><td>${t("drawer_last_updated")}</td><td>${lastUpdated ? lastUpdated.slice(0, 10) : "—"}</td></tr>
    </table>
    <h3 style="font-size:0.85rem;text-transform:uppercase;color:var(--text-muted);margin-top:16px;">${t("drawer_activities")}</h3>
    <ul>${activities.map((a) => `<li>${a}</li>`).join("") || `<li>${t("drawer_none_reported")}</li>`}</ul>
  `;

  document.getElementById("drawer-copy-id").addEventListener("click", (e) => {
    navigator.clipboard.writeText(first.matchedSiteCode || first.siteCodeRaw || "").then(() => {
      e.target.textContent = t("drawer_copied");
      setTimeout(() => { e.target.textContent = t("drawer_copy_id"); }, 1500);
    });
  });
  const zoomBtn = document.getElementById("drawer-zoom");
  if (zoomBtn) zoomBtn.addEventListener("click", () => {
    closeSiteDrawer();
    document.getElementById("section-maps").scrollIntoView({ behavior: "smooth" });
    if (state.maps.main) state.maps.main.setView([first.latitude, first.longitude], 13);
  });
  const prevBtn = document.getElementById("drawer-prev");
  const nextBtn = document.getElementById("drawer-next");
  if (prevKey) prevBtn.addEventListener("click", () => openSiteDrawer(prevKey));
  if (nextKey) nextBtn.addEventListener("click", () => openSiteDrawer(nextKey));

  document.getElementById("site-drawer").classList.remove("hidden");
  document.getElementById("drawer-overlay").classList.remove("hidden");
}

function closeSiteDrawer() {
  document.getElementById("site-drawer").classList.add("hidden");
  document.getElementById("drawer-overlay").classList.add("hidden");
}
