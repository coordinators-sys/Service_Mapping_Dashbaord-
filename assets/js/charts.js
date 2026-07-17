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
    ? `<img src="${src}?v=${ICON_VERSION}" alt="" width="${size}" height="${size}" class="sector-icon" loading="lazy" />`
    : "";
}

// Clean look: no grid lines on any chart; keep the axis border only.
Chart.defaults.scale.grid.display = false;
Chart.defaults.scale.border = Object.assign({}, Chart.defaults.scale.border, { display: true });

// Chart.js formatters (ticks, tooltips, value labels) are NOT guaranteed a
// number — depending on the callback they may receive a raw value, a parsed
// {x,y}, or a full tooltip/scale context object. Calling Math.round() on such
// an object throws "Cannot convert object to primitive value". safeNumber
// coerces any of those shapes to a finite number so no formatter can crash.
function safeNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") {
    if (typeof value.raw === "number") return value.raw;
    if (typeof value.parsed === "number") return value.parsed;
    if (typeof value.y === "number") return value.y;
    if (value.parsed && typeof value.parsed === "object" && typeof value.parsed.y === "number") return value.parsed.y;
  }
  // Number(x) itself THROWS on objects that refuse primitive conversion
  // (e.g. Chart.js option-resolver proxies) — a formatter must never throw
  // inside the draw loop, or the shared animator dies and every chart after
  // the throwing one stays blank.
  try {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (e) {
    return 0;
  }
}

function formatNumber(value) {
  return Math.round(safeNumber(value)).toLocaleString("en-US");
}

function formatPct(value) {
  return `${Math.round(safeNumber(value))}%`;
}

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
    // CRITICAL: read the RAW config, not chart.options. chart.options is a
    // Chart.js resolver Proxy that auto-invokes function-valued options as
    // "scriptable options" — reading opts.format through it CALLS format with
    // a resolution-context object instead of returning the function, which
    // crashed the whole draw loop ("Cannot convert object to primitive value")
    // and left every chart after the first one blank.
    const rawPlugins = chart.config && chart.config.options && chart.config.options.plugins;
    const opts = rawPlugins && rawPlugins.barValues;
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
        const raw = ds.data[i];
        if (raw == null || (center && safeNumber(raw) === 0)) return;
        const value = safeNumber(raw);
        const label = opts.format ? opts.format(value) : formatNumber(value);

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

const PCT_LABEL = { format: (v) => formatPct(v) };
const COUNT_LABEL = { format: (v) => formatNumber(v) };

function destroyChart(id) {
  const canvas = document.getElementById(id);
  const existing = canvas && Chart.getChart(canvas);
  if (existing) existing.destroy();
}

// ---------- Aggregation ----------
// All coverage math runs on the SEMANTIC LAYER (semantic.js): one cell per
// canonical site × sector × period, never raw records — a site reported by
// both Kobo and ZiteManager counts once. Cells are memoized per filtered
// record-array identity (a new array is produced on every filter change).
const _cellsCache = new WeakMap();

function siteSectorCells(records) {
  let cells = _cellsCache.get(records);
  if (!cells) {
    cells = buildSiteSectorStatus(records);
    _cellsCache.set(records, cells);
  }
  return cells;
}

function computeSectorCoverage(records, sectors = SECTORS) {
  return sectorCoverageFromCells(siteSectorCells(records), sectors);
}

function computeCoverageTrend(records, sector) {
  return coverageTrendFromCells(siteSectorCells(records), sector || null);
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
      bySite.set(key, { siteKey: key, siteName: siteLabel(r), region: r.region, district: r.district, catchment: r.catchment || null, statuses: {} });
    }
    const entry = bySite.get(key);
    if (!entry.statuses[r.sector]) entry.statuses[r.sector] = r.coverageStatus;
    else if (r.coverageStatus === "Yes") entry.statuses[r.sector] = "Yes"; // covered wins over conflicting rows
  });

  return Array.from(bySite.values()).map((site) => {
    const gaps = SECTORS.filter((s) => site.statuses[s] === "No");
    const unknownSectors = SECTORS.filter((s) => site.statuses[s] === "Unknown" || site.statuses[s] === undefined);
    const noProvider = SECTORS.every((s) => site.statuses[s] !== "Yes");
    const missingAllPriority = PRIORITY_SECTORS.every((p) => gaps.includes(p));

    // "Critical gap" = an approved threshold, distinct from "has any confirmed
    // gap". A site is critical if it meets ANY of: missing 3+ priority sectors;
    // missing all priority services; or missing both Health AND WASH.
    const priorityGaps = PRIORITY_SECTORS.filter((p) => gaps.includes(p)).length;
    const isCritical =
      priorityGaps >= 3 ||
      missingAllPriority ||
      (gaps.includes("Health") && gaps.includes("WASH"));

    return {
      ...site,
      gaps,
      gapCount: gaps.length,
      unknownSectors,
      unknownCount: unknownSectors.length,
      noProvider,
      missingAllPriority,
      isCritical,
    };
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
    // Flagship insight: percentage WITH its full count breakdown, never bare.
    const best = reportable.reduce((a, b) => (b.coveragePct > a.coveragePct ? b : a));
    insights.push(
      t("insight_highest_full", {
        sector: strong(best.sector),
        pct: strong(`${Math.round(best.coveragePct)}%`),
        assessed: strong(formatNumber(best.reportableTotal)),
        covered: strong(formatNumber(best.covered)),
        notCovered: strong(formatNumber(best.notCovered)),
        unknown: strong(formatNumber(best.unknown)),
      })
    );
    const worst = reportable.reduce((a, b) => (b.notCovered > a.notCovered ? b : a));
    if (worst.notCovered > 0) {
      insights.push(t("insight_gap", { sector: strong(worst.sector), n: strong(formatNumber(worst.notCovered)) }));
    }
    // Largest unknown-data burden — a distinct, decision-relevant gap.
    const mostUnknown = sectorCoverage.reduce((a, b) => (b.unknown > a.unknown ? b : a), { unknown: 0 });
    if (mostUnknown.unknown > 0) {
      insights.push(t("insight_unknown", { sector: strong(mostUnknown.sector), n: strong(formatNumber(mostUnknown.unknown)) }));
    }
  }
  const byDistrict = new Map();
  siteProfiles.forEach((s) => {
    if (s.gapCount >= 3) byDistrict.set(s.district, (byDistrict.get(s.district) || 0) + 1);
  });
  const topDistrict = Array.from(byDistrict.entries()).sort((a, b) => b[1] - a[1])[0];
  if (topDistrict) {
    insights.push(t("insight_district", { district: strong(escapeHtml(topDistrict[0])), n: strong(topDistrict[1]) }));
  }
  if (trendInsight) insights.push(...(Array.isArray(trendInsight) ? trendInsight : [trendInsight]));
  if (!insights.length) insights.push(t("insight_none"));
  return insights.slice(0, 6);
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
    prev: `${prev.period}: ${Math.round(prev.coveragePct)}% of ${formatNumber(prev.assessed)}`,
    curr: `${curr.period}: ${Math.round(curr.coveragePct)}% of ${formatNumber(curr.assessed)}`,
  };
  const allSites = delta > 0.5 ? t("insight_trend_up", params) : delta < -0.5 ? t("insight_trend_down", params) : t("insight_trend_flat", params);

  // Like-for-like: same comparison restricted to sites reported in BOTH
  // periods, computed on semantic cells (site×sector×period grain, no
  // record double-counting). Reliability guards: suppressed with an explicit
  // note unless the comparable cohort has >=100 sites AND represents >=30%
  // of the current period's cohort — below that, a "trend" is more likely a
  // cohort artifact than a real change.
  const sector = filters.sector.size === 1 ? Array.from(filters.sector)[0] : null;
  const cells = siteSectorCells(recordsIgnoringPeriodFilter).filter((c) => !sector || c.sector === sector);
  const sitesIn = (period) => new Set(cells.filter((c) => c.period === period).map((c) => c.site));
  const currSites = sitesIn(curr.period);
  const prevSites = sitesIn(prev.period);
  const shared = new Set([...currSites].filter((s) => prevSites.has(s)));

  let likeForLike = null;
  const cohortShare = currSites.size ? shared.size / currSites.size : 0;
  if (shared.size >= 100 && cohortShare >= 0.3) {
    const pctFor = (period) => {
      let c = 0, n = 0;
      for (const cell of cells) {
        if (cell.period !== period || !shared.has(cell.site)) continue;
        if (cell.status === "Yes") c += 1;
        else if (cell.status === "No") n += 1;
      }
      return c + n ? (c / (c + n)) * 100 : null;
    };
    const prevPct = pctFor(prev.period);
    const currPct = pctFor(curr.period);
    if (prevPct !== null && currPct !== null) {
      const d2 = currPct - prevPct;
      likeForLike = t(d2 >= 0 ? "insight_lfl_up" : "insight_lfl_down", {
        pts: strong(Math.abs(d2).toFixed(1)),
        n: strong(formatNumber(shared.size)),
      });
    }
  } else if (shared.size > 0) {
    likeForLike = t("insight_lfl_suppressed", {
      n: formatNumber(shared.size),
      share: Math.round(cohortShare * 100),
    });
  }
  return [allSites, likeForLike].filter(Boolean);
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
      layout: { padding: { top: 22, right: 24 } },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: (v) => formatPct(v) } },
      },
      plugins: {
        // Single series + the card title already names the metric — a legend
        // box only overlaps the point labels (as reported), so hide it.
        legend: { display: false },
        barValues: PCT_LABEL,
        tooltip: {
          callbacks: {
            // Tooltip callbacks receive a context object, not a number — hence
            // safeNumber. Show numerator/denominator, not just the percentage.
            label: (ctx2) => {
              const d = data[ctx2.dataIndex] || {};
              return `${formatPct(ctx2.parsed.y)} — ${formatNumber(d.covered)} of ${formatNumber(d.assessed)} covered`;
            },
            afterLabel: (ctx2) => {
              const d = data[ctx2.dataIndex] || {};
              return `Not covered: ${formatNumber(d.notCovered)} · Unknown: ${formatNumber(d.unknown)}`;
            },
          },
        },
      },
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
  const assessed = assessedSites.size;
  const confirmedGaps = siteProfiles.filter((s) => s.gapCount > 0).length;
  const criticalGaps = siteProfiles.filter((s) => s.isCritical).length;
  const unknownSites = siteProfiles.filter((s) => s.unknownCount > 0).length;
  const denom = (n) => t("kpi_of", { a: formatNumber(n), b: formatNumber(assessed) });

  document.getElementById("kpi-row").innerHTML = [
    kpiCard("kpi-assessed", formatNumber(assessed), t("kpi_sites_assessed"), t("tip_sites_assessed")),
    kpiCard("kpi-agencies", formatNumber(activeAgencies.size), t("kpi_active_agencies"), t("tip_active_agencies")),
    kpiCard("kpi-regions", formatNumber(regions.size), t("kpi_regions"), t("tip_regions")),
    kpiCard("kpi-districts", formatNumber(districts.size), t("kpi_districts"), t("tip_districts")),
    // Renamed: "Critical service gaps" -> "Sites with confirmed gaps" (>=1
    // confirmed unavailable sector). "Critical" is now a separate, thresholded KPI.
    kpiCard("kpi-confirmed-gaps", denom(confirmedGaps), t("kpi_confirmed_gaps"), t("tip_confirmed_gaps"), true),
    kpiCard("kpi-critical-gaps", denom(criticalGaps), t("kpi_critical_gaps"), t("tip_critical_gaps"), true),
    kpiCard("kpi-unknown-sites", denom(unknownSites), t("kpi_unknown_sites"), t("tip_unknown_sites")),
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
      const pct = s.reportableTotal ? `${Math.round(s.coveragePct)}%` : "—";
      // Tooltip carries the full status breakdown so the % is never shown
      // without its numerator/denominator + the unknown burden.
      const tip = `${s.sector} — ${t("chart_yes")}: ${s.covered}, ${t("chart_no")}: ${s.notCovered}, ${t("chart_unknown")}: ${s.unknown} (${t("coverage_of", { c: s.covered, n: s.reportableTotal })})`;
      return `<button type="button" class="sector-chip${active ? " active" : ""}" data-sector="${escapeHtml(s.sector)}" title="${escapeHtml(tip)}">
        ${sectorIcon(s.sector, 22)}
        <span class="sector-chip-name">${escapeHtml(s.sector)}</span>
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
    ? topDistricts.map(([d, v]) => `<div class="district-list-item"><strong>${escapeHtml(d)}</strong> <span class="badge badge-critical">${t("n_sites_3gaps", { n: v.gaps3 })}</span></div>`).join("")
    : `<div class="banner banner-info">${t("no_district_gaps")}</div>`;

  // All sites with a confirmed gap, most-critical first. Kept in module scope
  // so the "View all" toggle can re-render more without recomputing.
  _priorityAll = siteProfiles.filter((s) => s.gapCount > 0).sort((a, b) => b.gapCount - a.gapCount);
  _priorityShowAll = false;
  renderPrioritySitesTable();
}

let _priorityAll = [];
let _priorityShowAll = false;
const PRIORITY_TABLE_TOP = 10;

// Compact top-10 table. Instead of listing all 11 missing sectors inline, show
// "N sectors missing" — the full list lives in the row tooltip and the site
// drawer, per the brief.
function renderPrioritySitesTable() {
  const container = document.getElementById("priority-sites-list");
  if (!_priorityAll.length) {
    container.innerHTML = `<div class="banner banner-info">${t("no_priority_gaps")}</div>`;
    return;
  }
  const rows = _priorityShowAll ? _priorityAll : _priorityAll.slice(0, PRIORITY_TABLE_TOP);
  const body = rows
    .map((s) => {
      const missing = s.gaps.join(", ") || "—";
      const badgeClass = s.isCritical ? "badge-critical" : "badge-warning";
      return `<tr data-site="${escapeHtml(s.siteKey)}" title="${escapeHtml(t("missing_label", { list: missing }))}">
        <td><strong>${escapeHtml(s.siteName)}</strong><div class="cell-sub">${escapeHtml(s.siteKey)}</div></td>
        <td>${escapeHtml(s.district || "—")}</td>
        <td><span class="badge ${badgeClass}">${t("n_sectors_missing", { n: s.gapCount })}</span></td>
      </tr>`;
    })
    .join("");

  const toggle =
    _priorityAll.length > PRIORITY_TABLE_TOP
      ? `<button type="button" class="btn btn-light btn-sm" id="priority-view-all">${
          _priorityShowAll ? t("show_top", { n: PRIORITY_TABLE_TOP }) : t("view_all", { n: _priorityAll.length })
        }</button>`
      : "";

  container.innerHTML = `
    <table class="data-table compact-table">
      <thead><tr>
        <th data-i18n="col_site">${t("col_site")}</th>
        <th data-i18n="col_district">${t("col_district")}</th>
        <th>${t("col_gaps")}</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div class="table-foot">${toggle}</div>`;

  container.querySelectorAll("tr[data-site]").forEach((tr) => {
    tr.addEventListener("click", () => openSiteDrawer(tr.dataset.site));
  });
  const viewAll = container.querySelector("#priority-view-all");
  if (viewAll) viewAll.addEventListener("click", () => { _priorityShowAll = !_priorityShowAll; renderPrioritySitesTable(); });
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
  // Height sized to the capped row count (max 15 bars at ~24px) — roomy
  // labels, no scroll-wall.
  const catchmentCanvas = document.getElementById("chart-catchment-coverage");
  if (catchmentCanvas && catchmentCanvas.parentElement) {
    const rowCount = Math.min(15, data.length);
    catchmentCanvas.parentElement.style.height = `${Math.max(300, rowCount * 24 + 70)}px`;
  }

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
    kpiCard("kpi-ca-best", best ? `${friendlyCatchment(best.catchment)} (${best.coveragePct.toFixed(0)}%)` : "—", t("kpi_catchment_best"), t("tip_catchment_best")),
    kpiCard("kpi-ca-worst", worst ? `${friendlyCatchment(worst.catchment)} (${worst.coveragePct.toFixed(0)}%)` : "—", t("kpi_catchment_worst"), t("tip_catchment_worst"), true),
  ].join("");

  // Action-first view: the question this chart answers is "which catchments
  // need attention?" — so it ranks LOWEST coverage first, hides catchments
  // with fewer than 3 assessed sites (a 0% on 1 site is noise, not signal),
  // and caps at 15 rows. The complete list stays in the adjacent table and
  // the catchment CSV export; a note states what is shown vs. total.
  const eligible = data.filter((d) => d.coveragePct !== null && d.sitesAssessed >= 3);
  const chartData = [...eligible].sort((a, b) => a.coveragePct - b.coveragePct).slice(0, 15);
  const chartNote = document.getElementById("catchment-chart-note");
  if (chartNote) {
    chartNote.textContent = t("catchment_chart_note", {
      shown: chartData.length,
      eligible: eligible.length,
      total: data.length,
    });
  }
  const thresholdColor = (pct) => (pct < 30 ? COLORS.critical : pct < 60 ? COLORS.warning : COLORS.success);
  state.charts.catchmentCoverage = new Chart(document.getElementById("chart-catchment-coverage"), {
    type: "bar",
    data: {
      labels: chartData.map((d) => friendlyCatchment(d.catchment)),
      datasets: [{
        label: t("chart_coverage_pct"),
        data: chartData.map((d) => d.coveragePct ?? 0),
        backgroundColor: chartData.map((d) =>
          filters.catchment.has(d.catchment) ? COLORS.orange : thresholdColor(d.coveragePct ?? 0)
        ),
      }],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 46 } },
      scales: { x: { max: 100, title: { display: true, text: t("chart_coverage_pct") } } },
      plugins: {
        legend: { display: false },
        barValues: PCT_LABEL,
        tooltip: {
          callbacks: {
            label: (c) => {
              const d = chartData[c.dataIndex];
              return `${formatPct(c.parsed.x)} — ${formatNumber(d.sitesAssessed)} sites assessed, ${formatNumber(d.activeAgencies)} agencies`;
            },
          },
        },
      },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        toggleFilterValue("catchment", chartData[elements[0].index].catchment, evt.native && (evt.native.ctrlKey || evt.native.metaKey));
      },
    },
  });

  tbody.innerHTML = data.map((d) => `
    <tr data-catchment="${d.catchment}">
      <td title="${escapeHtml(d.catchment)}"><strong>${escapeHtml(friendlyCatchment(d.catchment))}</strong></td>
      <td>${escapeHtml(d.district || "—")}</td>
      <td>${d.sitesAssessed}</td>
      <td>${d.activeAgencies}</td>
      <td>${d.coveragePct === null ? "—" : d.coveragePct.toFixed(0) + "%"}</td>
      <td>${d.topMissing.map((s) => `<span class="drawer-sector drawer-sector-missing">${sectorIcon(s, 14)} ${s}</span>`).join("") || "—"}</td>
    </tr>`).join("");
  tbody.querySelectorAll("tr[data-catchment]").forEach((tr) => {
    tr.addEventListener("click", (evt) => toggleFilterValue("catchment", tr.dataset.catchment, evt.ctrlKey || evt.metaKey));
  });
}


// ---------- Reporting completeness (P2.1) ----------
// Denominator honesty: no per-round "expected to report" scope is configured
// yet, so the rate shown is "share of master-list sites reported" — labelled
// as such in the section note rather than claiming an expected-reporting rate.

function renderCompleteness(records) {
  const kpiRow = document.getElementById("completeness-kpi-row");
  if (!kpiRow) return;
  const master = state.masterSites || { total: 0, byDistrict: {} };

  const reportedSites = new Set(records.map(siteKey).filter(Boolean));
  const reported = reportedSites.size;
  const total = master.total || 0;
  const notReported = Math.max(0, total - reported);
  const rate = total ? (reported / total) * 100 : 0;

  // Stale = a site whose most recent record is older than 180 days.
  const now = Date.now();
  const latestBySite = new Map();
  records.forEach((r) => {
    const k = siteKey(r);
    if (!k || !r.lastUpdated) return;
    if (!latestBySite.has(k) || r.lastUpdated > latestBySite.get(k)) latestBySite.set(k, r.lastUpdated);
  });
  let stale = 0;
  latestBySite.forEach((d) => {
    if ((now - new Date(d).getTime()) / 86400000 > 180) stale += 1;
  });

  kpiRow.innerHTML = [
    kpiCard("kpi-master-sites", formatNumber(total), t("kpi_master_sites"), t("tip_master_sites")),
    kpiCard("kpi-sites-reported", formatNumber(reported), t("kpi_sites_reported"), t("tip_sites_reported")),
    kpiCard("kpi-sites-not-reported", formatNumber(notReported), t("kpi_sites_not_reported"), t("tip_sites_not_reported"), notReported > 0),
    kpiCard("kpi-reporting-rate", formatPct(rate), t("kpi_reporting_rate"), t("tip_reporting_rate")),
    kpiCard("kpi-stale-reports", formatNumber(stale), t("kpi_stale_reports"), t("tip_stale_reports")),
  ].join("");

  const note = document.getElementById("completeness-note");
  if (note) note.textContent = t("completeness_note");

  // Rate by district (reported sites in the CURRENT selection vs master list
  // per district), worst 15 by rate among districts with >=10 master sites.
  destroyChart("chart-rate-by-district");
  const seenPerDistrict = {};
  records.forEach((r) => {
    const k = siteKey(r);
    if (!k || !r.district) return;
    (seenPerDistrict[r.district] = seenPerDistrict[r.district] || new Set()).add(k);
  });

  const rows = Object.entries(master.byDistrict || {})
    .filter(([, n]) => n >= 10)
    .map(([district, masterCount]) => ({
      district,
      masterCount,
      reported: seenPerDistrict[district] ? seenPerDistrict[district].size : 0,
    }))
    .map((r) => ({ ...r, rate: r.masterCount ? (r.reported / r.masterCount) * 100 : 0 }))
    .sort((a, b) => a.rate - b.rate)
    .slice(0, 15);

  state.charts.rateByDistrict = new Chart(document.getElementById("chart-rate-by-district"), {
    type: "bar",
    data: {
      labels: rows.map((r) => r.district),
      datasets: [{
        label: t("kpi_reporting_rate"),
        data: rows.map((r) => r.rate),
        backgroundColor: rows.map((r) => (r.rate < 30 ? COLORS.critical : r.rate < 60 ? COLORS.warning : COLORS.success)),
      }],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 46 } },
      scales: { x: { max: 100, ticks: { callback: (v) => formatPct(v) } } },
      plugins: {
        legend: { display: false },
        barValues: PCT_LABEL,
        tooltip: {
          callbacks: {
            label: (c) => {
              const r = rows[c.dataIndex];
              return `${formatPct(c.parsed.x)} — ${formatNumber(r.reported)} of ${formatNumber(r.masterCount)} master-list sites`;
            },
          },
        },
      },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        toggleFilterValue("district", rows[elements[0].index].district, evt.native && (evt.native.ctrlKey || evt.native.metaKey));
      },
    },
  });
}

// ---------- Agency-sector matrix + single-provider sectors (P2.5) ----------

// Short sector names shown under the icons in the matrix header — icons
// alone are ambiguous to first-time users, full names don't fit 11 columns.
const SECTOR_ABBR = {
  "CCCM": "CCCM", "General Protection": "Prot", "Child Protection": "CP",
  "GBV": "GBV", "HLP": "HLP", "Food Security and Livelihoods": "FSL",
  "Health": "Health", "Education": "Edu", "Nutrition": "Nut",
  "Shelter/NFI": "SNFI", "WASH": "WASH",
};

function renderAgencyMatrix(records) {
  const container = document.getElementById("agency-matrix-container");
  if (!container) return;
  const covered = records.filter((r) => r.coverageStatus === "Yes" && r.agency);
  if (!covered.length) {
    container.innerHTML = `<div class="banner banner-info">${t("no_agency_activity")}</div>`;
    return;
  }
  // Top 15 agencies by sites covered keeps the matrix scannable; the full
  // agency list remains available in the Agencies charts and exports.
  const topAgencies = computeSitesByAgency(records, 15).map((r) => r.agency);

  // Pre-compute the whole grid so cells can be heat-shaded relative to the
  // largest cell, and totals derived without a second pass.
  const grid = topAgencies.map((agency) =>
    SECTORS.map((sector) => new Set(covered.filter((r) => r.agency === agency && r.sector === sector).map(siteKey)).size)
  );
  const maxCell = Math.max(1, ...grid.flat());
  const rowTotals = grid.map((row) => row.reduce((a, b) => a + b, 0));
  const colTotals = SECTORS.map((s) =>
    new Set(covered.filter((r) => r.sector === s).map(siteKey)).size
  );

  const headCells = SECTORS.map(
    (s) => `<th class="matrix-head" title="${escapeHtml(s)}"><div>${sectorIcon(s, 18)}</div><div class="matrix-abbr">${SECTOR_ABBR[s] || s}</div></th>`
  ).join("");

  let html = `<table class="data-table matrix-table"><thead><tr><th>${t("matrix_agency")}</th>${headCells}<th class="matrix-total-col">${t("matrix_total")}</th></tr></thead><tbody>`;
  topAgencies.forEach((agency, i) => {
    const cells = SECTORS.map((sector, j) => {
      const n = grid[i][j];
      // Heat scale: cell background intensity ~ value, dark cells get white text.
      const alpha = n ? 0.12 + 0.78 * (n / maxCell) : 0;
      const style = n ? ` style="background: rgba(23,103,122,${alpha.toFixed(2)}); color: ${alpha > 0.55 ? "#fff" : "inherit"};"` : "";
      return `<td class="matrix-cell${n ? "" : " matrix-zero"}"${style} data-agency="${escapeHtml(agency)}" title="${escapeHtml(agency)} — ${escapeHtml(sector)}: ${n} sites">${n || ""}</td>`;
    }).join("");
    html += `<tr><td class="matrix-agency" data-agency="${escapeHtml(agency)}"><strong>${escapeHtml(agency)}</strong></td>${cells}<td class="matrix-total-col"><strong>${rowTotals[i]}</strong></td></tr>`;
  });
  html += `<tr class="matrix-total-row"><td>${t("matrix_total")}</td>${colTotals.map((n, j) => `<td title="${escapeHtml(SECTORS[j])}: ${n} sites">${n || ""}</td>`).join("")}<td></td></tr>`;
  html += "</tbody></table>";
  container.innerHTML = html;
  container.querySelectorAll(".matrix-cell, .matrix-agency").forEach((cell) => {
    cell.addEventListener("click", (evt) => toggleFilterValue("agency", cell.dataset.agency, evt.ctrlKey || evt.metaKey));
  });
}

