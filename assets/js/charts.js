// Aggregation (pure functions over the clean record array) + Chart.js chart
// builders. Aggregation lives here rather than inline in render calls so it
// stays testable/readable independent of any specific chart library.

const SECTORS = [
  "CCCM", "General Protection", "Child Protection", "GBV", "HLP",
  "Food Security and Livelihoods", "Health", "Education", "Nutrition",
  "Shelter/NFI", "WASH",
];
const PRIORITY_SECTORS = ["Health", "WASH", "General Protection", "Shelter/NFI"];

const COLORS = {
  primary: "#17677A", secondaryTeal: "#4F9EB1", orange: "#EC6B4D",
  success: "#3A8D68", warning: "#E9A23B", critical: "#D9534F", unknown: "#9AA5B1",
};

// CCCM cluster sector icons (assets/icons/, provided by the cluster).
const SECTOR_ICONS = {
  "CCCM": "assets/icons/cccm.png",
  "General Protection": "assets/icons/protection.png",
  "Child Protection": "assets/icons/cp.png",
  "GBV": "assets/icons/gbv.png",
  "HLP": "assets/icons/hlp.png",
  "Food Security and Livelihoods": "assets/icons/fsl.png",
  "Health": "assets/icons/health.png",
  "Education": "assets/icons/education.png",
  "Nutrition": "assets/icons/nutrition.png",
  "Shelter/NFI": "assets/icons/shelter.png",
  "WASH": "assets/icons/wash.png",
};

// "?v=2" busts the day-long browser/CDN cache of the 404s these paths
// returned before the .vercelignore fix — without it, anyone who visited
// during the broken window keeps seeing broken-image glyphs for 24h.
// onerror hides the img entirely so a failed icon never shows a glyph.
const ICON_VERSION = "2";

function sectorIcon(sector, size = 18) {
  const src = SECTOR_ICONS[sector];
  return src
    ? `<img src="${src}?v=${ICON_VERSION}" alt="" width="${size}" height="${size}" class="sector-icon" loading="lazy" onerror="this.style.display='none'" />`
    : "";
}

// Clean look: no grid lines on any chart; keep the axis border only.
Chart.defaults.scale.grid.display = false;
Chart.defaults.scale.border = Object.assign({}, Chart.defaults.scale.border, { display: true });

// Value labels on bars/points — tiny custom plugin instead of pulling in
// chartjs-plugin-datalabels (keeps dependencies minimal per the perf
// requirements). Opt in per chart via options.plugins.barValues:
//   { format: (v) => "58%" }            -> label at the end of each bar/point
//   { format: ..., mode: "center" }     -> label centered inside each stacked segment
function _chartTextColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--text").trim();
  return v || "#26343A";
}

const barValueLabels = {
  id: "barValueLabels",
  afterDatasetsDraw(chart) {
    const opts = chart.options.plugins && chart.options.plugins.barValues;
    if (!opts) return;
    const horizontal = chart.options.indexAxis === "y";
    const center = opts.mode === "center";
    const { ctx } = chart;
    ctx.save();
    ctx.font = '600 11px "Segoe UI", Roboto, sans-serif';

    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      meta.data.forEach((el, i) => {
        const value = ds.data[i];
        if (value == null || (center && value === 0)) return;
        const label = opts.format ? opts.format(value) : String(value);

        if (center) {
          // Inside stacked segments, only when the segment is wide enough.
          const props = el.getProps(["x", "y", "base", "width", "height"], true);
          const segmentLength = horizontal ? Math.abs(props.x - props.base) : Math.abs(props.y - props.base);
          if (segmentLength < 24) return;
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const cx = horizontal ? (props.x + props.base) / 2 : props.x;
          const cy = horizontal ? props.y : (props.y + props.base) / 2;
          ctx.fillText(label, cx, cy);
        } else {
          ctx.fillStyle = _chartTextColor();
          if (horizontal) {
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(label, el.x + 5, el.y);
          } else {
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.fillText(label, el.x, el.y - 4);
          }
        }
      });
    });
    ctx.restore();
  },
};
Chart.register(barValueLabels);

const PCT_LABEL = { format: (v) => `${Math.round(v)}%` };
const COUNT_LABEL = { format: (v) => String(v) };

function destroyChart(id) {
  const canvas = document.getElementById(id);
  const existing = canvas && Chart.getChart(canvas);
  if (existing) existing.destroy();
}

// ---------- Aggregation ----------

function computeSectorCoverage(records, sectors = SECTORS) {
  return sectors.map((sector) => {
    const rows = records.filter((r) => r.sector === sector);
    const covered = rows.filter((r) => r.coverageStatus === "Yes").length;
    const notCovered = rows.filter((r) => r.coverageStatus === "No").length;
    const unknown = rows.filter((r) => r.coverageStatus === "Unknown").length;
    const reportableTotal = covered + notCovered;
    return {
      sector, covered, notCovered, unknown, reportableTotal,
      coveragePct: reportableTotal ? (covered / reportableTotal) * 100 : 0,
    };
  });
}

function computeCoverageTrend(records, sector) {
  const scoped = sector ? records.filter((r) => r.sector === sector) : records;
  const byPeriod = new Map();
  scoped.forEach((r) => {
    if (!r.reportingPeriod) return;
    if (!byPeriod.has(r.reportingPeriod)) byPeriod.set(r.reportingPeriod, []);
    byPeriod.get(r.reportingPeriod).push(r.coverageStatus);
  });
  return Array.from(byPeriod.entries())
    .map(([period, statuses]) => {
      const covered = statuses.filter((s) => s === "Yes").length;
      const notCovered = statuses.filter((s) => s === "No").length;
      const total = covered + notCovered;
      return { period, coveragePct: total ? (covered / total) * 100 : 0 };
    })
    .sort((a, b) => a.period.localeCompare(b.period));
}

function computeAgenciesBySector(records) {
  return SECTORS.map((sector) => {
    const agencies = new Set(
      records.filter((r) => r.sector === sector && r.coverageStatus === "Yes" && r.agency).map((r) => r.agency)
    );
    return { sector, activeAgencies: agencies.size };
  }).sort((a, b) => b.activeAgencies - a.activeAgencies);
}

function computeAgenciesByDistrict(records, topN = 12) {
  const districts = Array.from(new Set(records.map((r) => r.district).filter(Boolean)));
  return districts
    .map((district) => {
      const agencies = new Set(
        records.filter((r) => r.district === district && r.coverageStatus === "Yes" && r.agency).map((r) => r.agency)
      );
      return { district, activeAgencies: agencies.size };
    })
    .sort((a, b) => b.activeAgencies - a.activeAgencies)
    .slice(0, topN);
}

function computeSitesByAgency(records, topN = 15) {
  const agencies = Array.from(new Set(records.map((r) => r.agency).filter(Boolean)));
  return agencies
    .map((agency) => {
      const sites = new Set(records.filter((r) => r.agency === agency && r.coverageStatus === "Yes").map(siteKey));
      return { agency, sitesCovered: sites.size };
    })
    .sort((a, b) => b.sitesCovered - a.sitesCovered)
    .slice(0, topN);
}

function computeSiteGapProfiles(records) {
  const bySite = new Map();
  records.forEach((r) => {
    const key = siteKey(r);
    if (!key) return;
    if (!bySite.has(key)) {
      bySite.set(key, { siteKey: key, siteName: siteLabel(r), region: r.region, district: r.district, statuses: {} });
    }
    const entry = bySite.get(key);
    if (!entry.statuses[r.sector]) entry.statuses[r.sector] = r.coverageStatus;
    else if (r.coverageStatus === "Yes") entry.statuses[r.sector] = "Yes"; // covered wins over conflicting rows
  });

  return Array.from(bySite.values()).map((site) => {
    const gaps = SECTORS.filter((s) => site.statuses[s] === "No");
    const noProvider = SECTORS.every((s) => site.statuses[s] !== "Yes");
    return { ...site, gaps, gapCount: gaps.length, noProvider };
  });
}

function computePriorityKpis(siteProfiles) {
  const missingAll = siteProfiles.filter((s) => PRIORITY_SECTORS.every((p) => s.gaps.includes(p))).length;
  const missing3 = siteProfiles.filter((s) => s.gapCount >= 3).length;
  const noHealth = siteProfiles.filter((s) => s.gaps.includes("Health")).length;
  const noWash = siteProfiles.filter((s) => s.gaps.includes("WASH")).length;
  const noProtection = siteProfiles.filter((s) => s.gaps.includes("General Protection")).length;
  return { missingAll, missing3, noHealth, noWash, noProtection };
}

function generateInsights(sectorCoverage, siteProfiles, trendInsight) {
  const insights = [];
  const strong = (v) => `<strong>${v}</strong>`;
  const reportable = sectorCoverage.filter((s) => s.reportableTotal > 0);
  if (reportable.length) {
    const best = reportable.reduce((a, b) => (b.coveragePct > a.coveragePct ? b : a));
    insights.push(t("insight_highest", { sector: strong(best.sector), pct: strong(best.coveragePct.toFixed(0)) }));
    const worst = reportable.reduce((a, b) => (b.notCovered > a.notCovered ? b : a));
    if (worst.notCovered > 0) {
      insights.push(t("insight_gap", { sector: strong(worst.sector), n: strong(worst.notCovered.toLocaleString()) }));
    }
  }
  const byDistrict = new Map();
  siteProfiles.forEach((s) => {
    if (s.gapCount >= 3) byDistrict.set(s.district, (byDistrict.get(s.district) || 0) + 1);
  });
  const topDistrict = Array.from(byDistrict.entries()).sort((a, b) => b[1] - a[1])[0];
  if (topDistrict) {
    insights.push(t("insight_district", { district: strong(topDistrict[0]), n: strong(topDistrict[1]) }));
  }
  if (trendInsight) insights.push(trendInsight);
  if (!insights.length) insights.push(t("insight_none"));
  return insights.slice(0, 4);
}

// Question 8: how coverage changes between reporting periods. Compares the
// two most recent periods present in the (period-unfiltered) selection.
function computeTrendInsight(recordsIgnoringPeriodFilter) {
  const trend = computeCoverageTrend(
    recordsIgnoringPeriodFilter,
    filters.sector.size === 1 ? Array.from(filters.sector)[0] : null
  );
  if (trend.length < 2) return null;
  const prev = trend[trend.length - 2];
  const curr = trend[trend.length - 1];
  const delta = curr.coveragePct - prev.coveragePct;
  const strong = (v) => `<strong>${v}</strong>`;
  const params = {
    pts: strong(Math.abs(delta).toFixed(1)),
    prev: `${prev.period}: ${prev.coveragePct.toFixed(0)}%`,
    curr: `${curr.period}: ${curr.coveragePct.toFixed(0)}%`,
  };
  if (delta > 0.5) return t("insight_trend_up", params);
  if (delta < -0.5) return t("insight_trend_down", params);
  return t("insight_trend_flat", params);
}

// ---------- Chart builders ----------

function renderSectorBarChart(records, sortMode) {
  destroyChart("chart-sector-bar");
  let data = computeSectorCoverage(records);
  if (sortMode === "coverage_asc") data = [...data].sort((a, b) => a.coveragePct - b.coveragePct);
  else if (sortMode === "gap_desc") data = [...data].sort((a, b) => b.notCovered - a.notCovered);
  else data = [...data].sort((a, b) => b.coveragePct - a.coveragePct);

  const ctx = document.getElementById("chart-sector-bar");
  state.charts.sectorBar = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map((d) => d.sector),
      datasets: [{
        label: t("chart_coverage_pct"),
        data: data.map((d) => d.coveragePct),
        backgroundColor: data.map((d) => (filters.sector.has(d.sector) ? COLORS.orange : COLORS.primary)),
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 46 } },
      scales: { x: { max: 100, title: { display: true, text: t("chart_coverage_pct") } } },
      plugins: {
        legend: { display: false },
        barValues: PCT_LABEL,
        tooltip: {
          callbacks: {
            label: (ctx2) => {
              const d = data[ctx2.dataIndex];
              return `${d.covered}/${d.reportableTotal} covered (${d.coveragePct.toFixed(1)}%)`;
            },
          },
        },
      },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const sector = data[elements[0].index].sector;
        toggleFilterValue("sector", sector, evt.native && (evt.native.ctrlKey || evt.native.metaKey));
      },
    },
  });
}

function renderCoverageTrendChart(records) {
  destroyChart("chart-coverage-trend");
  const sector = filters.sector.size === 1 ? Array.from(filters.sector)[0] : null;
  const data = computeCoverageTrend(records, sector);
  const ctx = document.getElementById("chart-coverage-trend");
  state.charts.coverageTrend = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map((d) => d.period),
      datasets: [{
        label: sector ? `${sector} — ${t("chart_coverage_pct")}` : t("chart_coverage_pct"),
        data: data.map((d) => d.coveragePct),
        borderColor: COLORS.primary, backgroundColor: COLORS.primary, tension: 0.25, fill: false,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 18 } },
      scales: { y: { min: 0, max: 100 } },
      plugins: { barValues: PCT_LABEL },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const period = data[elements[0].index].period;
        toggleFilterValue("period", period, evt.native && (evt.native.ctrlKey || evt.native.metaKey));
      },
    },
  });
}

function renderAgenciesBySectorChart(records) {
  destroyChart("chart-agencies-by-sector");
  const data = computeAgenciesBySector(records);
  const ctx = document.getElementById("chart-agencies-by-sector");
  state.charts.agenciesBySector = new Chart(ctx, {
    type: "bar",
    data: { labels: data.map((d) => d.sector), datasets: [{ label: t("chart_active_agencies"), data: data.map((d) => d.activeAgencies), backgroundColor: COLORS.secondaryTeal }] },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 30 } },
      plugins: { legend: { display: false }, barValues: COUNT_LABEL },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        toggleFilterValue("sector", data[elements[0].index].sector, evt.native && (evt.native.ctrlKey || evt.native.metaKey));
      },
    },
  });
}

function renderServiceAvailabilityChart(records) {
  destroyChart("chart-service-availability");
  const data = computeSectorCoverage(records).sort((a, b) => a.coveragePct - b.coveragePct);
  const ctx = document.getElementById("chart-service-availability");
  state.charts.serviceAvailability = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map((d) => d.sector),
      datasets: [
        { label: t("chart_yes"), data: data.map((d) => d.covered), backgroundColor: COLORS.success },
        { label: t("chart_no"), data: data.map((d) => d.notCovered), backgroundColor: COLORS.orange },
        { label: t("chart_unknown"), data: data.map((d) => d.unknown), backgroundColor: COLORS.unknown },
      ],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: { barValues: { format: (v) => v.toLocaleString(), mode: "center" } },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        toggleFilterValue("sector", data[elements[0].index].sector, evt.native && (evt.native.ctrlKey || evt.native.metaKey));
      },
    },
  });
}

function renderAgenciesByDistrictChart(records) {
  destroyChart("chart-agencies-by-district");
  const data = computeAgenciesByDistrict(records);
  const ctx = document.getElementById("chart-agencies-by-district");
  state.charts.agenciesByDistrict = new Chart(ctx, {
    type: "bar",
    data: { labels: data.map((d) => d.district), datasets: [{ label: t("chart_active_agencies"), data: data.map((d) => d.activeAgencies), backgroundColor: COLORS.primary }] },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 30 } },
      plugins: { legend: { display: false }, barValues: COUNT_LABEL },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        toggleFilterValue("district", data[elements[0].index].district, evt.native && (evt.native.ctrlKey || evt.native.metaKey));
      },
    },
  });
}

function renderSitesByAgencyChart(records) {
  destroyChart("chart-sites-by-agency");
  const data = computeSitesByAgency(records);
  const ctx = document.getElementById("chart-sites-by-agency");
  state.charts.sitesByAgency = new Chart(ctx, {
    type: "bar",
    data: { labels: data.map((d) => d.agency), datasets: [{ label: t("chart_sites_covered"), data: data.map((d) => d.sitesCovered), backgroundColor: COLORS.orange }] },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 30 } },
      plugins: { legend: { display: false }, barValues: COUNT_LABEL },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        toggleFilterValue("agency", data[elements[0].index].agency, evt.native && (evt.native.ctrlKey || evt.native.metaKey));
      },
    },
  });
}

// ---------- Key figures / priority gaps rendering ----------

function kpiCard(id, value, label, tooltip, negative, delta) {
  const deltaHtml = delta !== undefined && delta !== null
    ? `<div class="kpi-delta ${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(1)} pts</div>`
    : "";
  return `<div class="kpi-card" id="${id}" title="${tooltip}">
    <span class="kpi-info">ⓘ</span>
    <div class="kpi-value${negative ? " negative" : ""}">${value}</div>
    <div class="kpi-label">${label}</div>
    ${deltaHtml}
  </div>`;
}

function renderOverview(records) {
  const assessedSites = new Set(records.map(siteKey).filter(Boolean));
  const activeAgencies = new Set(records.filter((r) => r.coverageStatus === "Yes" && r.agency).map((r) => r.agency));
  const regions = new Set(records.map((r) => r.region).filter(Boolean));
  const districts = new Set(records.map((r) => r.district).filter(Boolean));
  const siteProfiles = computeSiteGapProfiles(records);
  const sitesWithServices = siteProfiles.filter((s) => !s.noProvider).length;
  const criticalGaps = siteProfiles.filter((s) => s.gapCount > 0).length;

  document.getElementById("kpi-row").innerHTML = [
    kpiCard("kpi-assessed", assessedSites.size.toLocaleString(), t("kpi_sites_assessed"), t("tip_sites_assessed")),
    kpiCard("kpi-agencies", activeAgencies.size.toLocaleString(), t("kpi_active_agencies"), t("tip_active_agencies")),
    kpiCard("kpi-regions", regions.size.toLocaleString(), t("kpi_regions"), t("tip_regions")),
    kpiCard("kpi-districts", districts.size.toLocaleString(), t("kpi_districts"), t("tip_districts")),
    kpiCard("kpi-with-services", sitesWithServices.toLocaleString(), t("kpi_sites_services"), t("tip_sites_services")),
    kpiCard("kpi-critical-gaps", criticalGaps.toLocaleString(), t("kpi_critical_gaps"), t("tip_critical_gaps"), true),
  ].join("");

  const sectorCoverage = computeSectorCoverage(records);
  const trendInsight = computeTrendInsight(filtered("period"));
  document.getElementById("insight-banner").innerHTML =
    `<ul>${generateInsights(sectorCoverage, siteProfiles, trendInsight).map((i) => `<li>${i}</li>`).join("")}</ul>`;

  renderSectorChips(sectorCoverage);
}

// Clickable sector-icon chips: one per sector with its coverage %, using the
// cluster's own icons. Clicking cross-filters the whole dashboard (ctrl/cmd
// -click for multi-select), same semantics as clicking a chart bar.
function renderSectorChips(sectorCoverage) {
  const container = document.getElementById("sector-chips");
  container.innerHTML = sectorCoverage
    .map((s) => {
      const active = filters.sector.has(s.sector);
      const pct = s.reportableTotal ? `${s.coveragePct.toFixed(0)}%` : "—";
      return `<button type="button" class="sector-chip${active ? " active" : ""}" data-sector="${s.sector}" title="${s.sector}: ${pct}">
        ${sectorIcon(s.sector, 22)}
        <span class="sector-chip-name">${s.sector}</span>
        <span class="sector-chip-pct">${pct}</span>
      </button>`;
    })
    .join("");
  container.querySelectorAll(".sector-chip").forEach((chip) => {
    chip.addEventListener("click", (evt) => {
      toggleFilterValue("sector", chip.dataset.sector, evt.ctrlKey || evt.metaKey);
    });
  });
}

function renderPriorityGaps(records) {
  const siteProfiles = computeSiteGapProfiles(records);
  const kpis = computePriorityKpis(siteProfiles);
  const assessed = siteProfiles.length;

  document.getElementById("priority-kpi-row").innerHTML = [
    kpiCard("kpi-missing-all", t("kpi_of", { a: kpis.missingAll, b: assessed }), t("kpi_missing_all"), t("tip_missing_all"), true),
    kpiCard("kpi-missing-3", t("kpi_of", { a: kpis.missing3, b: assessed }), t("kpi_missing_3"), t("tip_missing_3"), true),
    kpiCard("kpi-no-health", t("kpi_of", { a: kpis.noHealth, b: assessed }), t("kpi_no_health"), t("tip_no_health"), true),
    kpiCard("kpi-no-wash", t("kpi_of", { a: kpis.noWash, b: assessed }), t("kpi_no_wash"), t("tip_no_wash"), true),
    kpiCard("kpi-no-protection", t("kpi_of", { a: kpis.noProtection, b: assessed }), t("kpi_no_protection"), t("tip_no_protection"), true),
  ].join("");

  const byDistrict = new Map();
  siteProfiles.forEach((s) => {
    if (!byDistrict.has(s.district)) byDistrict.set(s.district, { total: 0, gaps3: 0 });
    const entry = byDistrict.get(s.district);
    entry.total += 1;
    if (s.gapCount >= 3) entry.gaps3 += 1;
  });
  const topDistricts = Array.from(byDistrict.entries())
    .filter(([, v]) => v.gaps3 > 0)
    .sort((a, b) => b[1].gaps3 - a[1].gaps3)
    .slice(0, 10);
  document.getElementById("top-underserved-districts").innerHTML = topDistricts.length
    ? topDistricts.map(([d, v]) => `<div class="district-list-item"><strong>${d}</strong> <span class="badge badge-critical">${t("n_sites_3gaps", { n: v.gaps3 })}</span></div>`).join("")
    : `<div class="banner banner-info">${t("no_district_gaps")}</div>`;

  const priority = siteProfiles.filter((s) => s.gapCount > 0).sort((a, b) => b.gapCount - a.gapCount).slice(0, 25);
  document.getElementById("priority-sites-list").innerHTML = priority.length
    ? priority.map((s) => `
        <div class="priority-list-item" data-site="${s.siteKey}">
          <strong>${s.siteName}</strong> (${s.siteKey})
          <span class="badge ${s.gapCount >= 3 ? "badge-critical" : "badge-warning"}">${t("n_gaps", { n: s.gapCount })}</span>
          <div style="color:var(--text-muted)">${s.district}, ${s.region}</div>
          <div>${t("missing_label", { list: s.gaps.join(", ") || "—" })}</div>
        </div>`).join("")
    : `<div class="banner banner-info">${t("no_priority_gaps")}</div>`;

  document.querySelectorAll("#priority-sites-list [data-site]").forEach((el) => {
    el.addEventListener("click", () => openSiteDrawer(el.dataset.site));
  });
}

function renderCoverage(records) {
  const sortMode = document.getElementById("sort-sector-bar").value;
  renderSectorBarChart(records, sortMode);
  renderCoverageTrendChart(records);
  renderAgenciesBySectorChart(records);
  renderServiceAvailabilityChart(records);
}

function renderAgencies(records) {
  renderAgenciesByDistrictChart(records);
  renderSitesByAgencyChart(records);
}

// ---------- Catchment analysis ----------
// Catchments come from the 2025 CA shapefiles: master-list sites are located
// inside catchment polygons at build time (build_data.py), so every record
// matched to such a site carries a `catchment` value. Records outside any
// mapped catchment (most of the country — boundaries exist for Baidoa-area
// sites only so far) are excluded from this section, not counted as gaps.

function computeCatchmentAnalysis(records) {
  const inCatchment = records.filter((r) => r.catchment);
  const byCatchment = new Map();
  inCatchment.forEach((r) => {
    if (!byCatchment.has(r.catchment)) {
      byCatchment.set(r.catchment, { catchment: r.catchment, district: r.district, sites: new Set(), agencies: new Set(), covered: 0, notCovered: 0, missing: {} });
    }
    const entry = byCatchment.get(r.catchment);
    const key = siteKey(r);
    if (key) entry.sites.add(key);
    if (r.coverageStatus === "Yes") {
      entry.covered += 1;
      if (r.agency) entry.agencies.add(r.agency);
    } else if (r.coverageStatus === "No") {
      entry.notCovered += 1;
      if (r.sector) entry.missing[r.sector] = (entry.missing[r.sector] || 0) + 1;
    }
  });

  return Array.from(byCatchment.values())
    .map((e) => {
      const reportable = e.covered + e.notCovered;
      return {
        catchment: e.catchment,
        district: e.district,
        sitesAssessed: e.sites.size,
        activeAgencies: e.agencies.size,
        coveragePct: reportable ? (e.covered / reportable) * 100 : null,
        topMissing: Object.entries(e.missing).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s),
      };
    })
    .sort((a, b) => String(a.catchment).localeCompare(String(b.catchment)));
}

function renderCatchments(records) {
  const data = computeCatchmentAnalysis(records);
  const kpiRow = document.getElementById("catchment-kpi-row");
  const tbody = document.getElementById("catchment-table-body");
  destroyChart("chart-catchment-coverage");

  if (!data.length) {
    kpiRow.innerHTML = "";
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px;">${t("no_catchment_data")}</td></tr>`;
    return;
  }

  const totalSites = data.reduce((s, d) => s + d.sitesAssessed, 0);
  const ranked = data.filter((d) => d.coveragePct !== null && d.sitesAssessed >= 3);
  const best = ranked.length ? ranked.reduce((a, b) => (b.coveragePct > a.coveragePct ? b : a)) : null;
  const worst = ranked.length ? ranked.reduce((a, b) => (b.coveragePct < a.coveragePct ? b : a)) : null;

  kpiRow.innerHTML = [
    kpiCard("kpi-ca-count", data.length.toLocaleString(), t("kpi_catchments_covered"), t("tip_catchments_covered")),
    kpiCard("kpi-ca-sites", totalSites.toLocaleString(), t("kpi_catchment_sites"), t("tip_catchment_sites")),
    kpiCard("kpi-ca-best", best ? `${best.catchment} (${best.coveragePct.toFixed(0)}%)` : "—", t("kpi_catchment_best"), t("tip_catchment_best")),
    kpiCard("kpi-ca-worst", worst ? `${worst.catchment} (${worst.coveragePct.toFixed(0)}%)` : "—", t("kpi_catchment_worst"), t("tip_catchment_worst"), true),
  ].join("");

  const chartData = [...data].sort((a, b) => (b.coveragePct ?? -1) - (a.coveragePct ?? -1));
  state.charts.catchmentCoverage = new Chart(document.getElementById("chart-catchment-coverage"), {
    type: "bar",
    data: {
      labels: chartData.map((d) => d.catchment),
      datasets: [{
        label: t("chart_coverage_pct"),
        data: chartData.map((d) => d.coveragePct ?? 0),
        backgroundColor: chartData.map((d) => (filters.catchment.has(d.catchment) ? COLORS.orange : COLORS.primary)),
      }],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 46 } },
      scales: { x: { max: 100, title: { display: true, text: t("chart_coverage_pct") } } },
      plugins: { legend: { display: false }, barValues: PCT_LABEL },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        toggleFilterValue("catchment", chartData[elements[0].index].catchment, evt.native && (evt.native.ctrlKey || evt.native.metaKey));
      },
    },
  });

  tbody.innerHTML = data.map((d) => `
    <tr data-catchment="${d.catchment}">
      <td><strong>${d.catchment}</strong></td>
      <td>${d.district || "—"}</td>
      <td>${d.sitesAssessed}</td>
      <td>${d.activeAgencies}</td>
      <td>${d.coveragePct === null ? "—" : d.coveragePct.toFixed(0) + "%"}</td>
      <td>${d.topMissing.map((s) => `<span class="drawer-sector drawer-sector-missing">${sectorIcon(s, 14)} ${s}</span>`).join("") || "—"}</td>
    </tr>`).join("");
  tbody.querySelectorAll("tr[data-catchment]").forEach((tr) => {
    tr.addEventListener("click", (evt) => toggleFilterValue("catchment", tr.dataset.catchment, evt.ctrlKey || evt.metaKey));
  });
}

