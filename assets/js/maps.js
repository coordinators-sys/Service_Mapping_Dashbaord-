// Leaflet map: OpenStreetMap basemap, district/catchment CHOROPLETH.
//
// Rewritten July 2026. The previous map plotted individual site points from
// record coordinates — which the public tier deliberately does not carry, so
// the map rendered empty boundary outlines under a legend describing site
// dots. Districts and catchments are the grains the payload actually has, and
// they are also what OCHA reports by and donors fund by, so the polygons ARE
// now the data: filled by coverage, with a click-popup answering the reader's
// question on the spot — how many sites assessed, how much is missing, what is
// missing, who is there.

const SOMALIA_CENTER = [5.0, 46.0];
const SOMALIA_ZOOM = 6;

function statusColor(pct) {
  if (pct === null || pct === undefined) return COLORS.unknown;
  if (pct >= 70) return COLORS.success;
  if (pct >= 30) return COLORS.warning;
  return COLORS.critical;
}

function initMap() {
  if (state.maps.main) return state.maps.main;
  const map = L.map("map-container", { zoomControl: true }).setView(SOMALIA_CENTER, SOMALIA_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 18,
  }).addTo(map);

  state.maps.main = map;
  state.maps.boundaryLayer = L.layerGroup().addTo(map);
  state.maps.catchmentGroup = L.layerGroup();

  // Popup "Filter" buttons are injected as HTML strings; wire them here, once,
  // via the popupopen event rather than per-layer listeners.
  map.on("popupopen", (ev) => {
    const btn = ev.popup.getElement() && ev.popup.getElement().querySelector("[data-map-filter]");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const [dimension, value] = btn.getAttribute("data-map-filter").split("::");
      toggleFilterValue(dimension, value, false);
      map.closePopup();
    });
  });
  return map;
}

function _mapView() {
  const el = document.getElementById("map-view");
  return el ? el.value : "districts";
}

function _mapSector() {
  return filters.sector.size === 1 ? Array.from(filters.sector)[0] : null;
}

// ---------------------------------------------------------------------------
// Per-district rollup for the choropleth and its popups. Built from the same
// canonical cells as every chart, so the map can never disagree with them.
function computeDistrictMapStats(records, sectorOnly) {
  const cells = officialSiteSectorCells(records);
  const siteDistrict = new Map();
  records.forEach((r) => {
    const key = siteKey(r);
    if (key && r.district && !siteDistrict.has(key)) siteDistrict.set(key, r.district);
  });

  const stats = new Map();
  const entryFor = (district) => {
    let entry = stats.get(district);
    if (!entry) {
      entry = { sites: new Set(), covered: 0, notCovered: 0, missing: {}, providers: new Set(), assessments: new Set() };
      stats.set(district, entry);
    }
    return entry;
  };

  for (const c of cells) {
    const district = siteDistrict.get(c.site);
    if (!district) continue;
    if (sectorOnly && c.sector !== sectorOnly) continue;
    const entry = entryFor(district);
    entry.sites.add(c.site);
    if (c.status === "Yes") entry.covered += 1;
    else if (c.status === "No") {
      entry.notCovered += 1;
      entry.missing[c.sector] = (entry.missing[c.sector] || 0) + 1;
    }
  }
  records.forEach((r) => {
    if (!r.district) return;
    const entry = entryFor(r.district);
    if (r.coverageStatus === "Yes" && r.agency) entry.providers.add(r.agency);
    if (r.dataSource !== "zitemanager" && r.submissionUuid) entry.assessments.add(r.submissionUuid);
  });

  const out = new Map();
  stats.forEach((e, district) => {
    const reportable = e.covered + e.notCovered;
    out.set(district, {
      sitesAssessed: e.sites.size,
      covered: e.covered,
      notCovered: e.notCovered,
      coveragePct: reportable ? (e.covered / reportable) * 100 : null,
      topMissing: Object.entries(e.missing).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s),
      providers: e.providers.size,
      assessments: e.assessments.size,
    });
  });
  return out;
}

// The quick answer the reader clicked for. Facts with their denominators, one
// action, no jargon.
function _districtPopupHtml(name, s) {
  if (!s) {
    return `<div class="map-popup"><strong>${escapeHtml(name)}</strong>
      <p>${escapeHtml(t("pop_no_data"))}</p></div>`;
  }
  const cov = s.coveragePct === null ? "—" : Math.round(s.coveragePct) + "%";
  return `<div class="map-popup">
    <strong>${escapeHtml(name)}</strong>
    <table class="map-popup-table">
      <tr><td>${escapeHtml(t("pop_sites_assessed"))}</td><td>${formatNumber(s.sitesAssessed)}</td></tr>
      <tr><td>${escapeHtml(t("pop_coverage"))}</td><td>${cov} <span class="map-popup-n">(${formatNumber(s.covered)}/${formatNumber(s.covered + s.notCovered)})</span></td></tr>
      <tr><td>${escapeHtml(t("pop_providers"))}</td><td>${formatNumber(s.providers)}</td></tr>
      <tr><td>${escapeHtml(t("pop_assessments"))}</td><td>${formatNumber(s.assessments)}</td></tr>
    </table>
    ${s.topMissing.length ? `<div class="map-popup-missing">${escapeHtml(t("pop_top_missing"))}: ${s.topMissing.map((sec) => `${sectorIcon(sec, 13)} ${escapeHtml(sec)}`).join(" · ")}</div>` : ""}
    <button type="button" class="btn btn-light btn-sm" data-map-filter="district::${escapeHtml(name)}">${escapeHtml(t("pop_filter"))}</button>
  </div>`;
}

function _catchmentPopupHtml(name, c) {
  if (!c) {
    return `<div class="map-popup"><strong>${escapeHtml(friendlyCatchment(name))}</strong>
      <p>${escapeHtml(t("pop_no_data"))}</p></div>`;
  }
  const cov = c.coveragePct === null ? "—" : Math.round(c.coveragePct) + "%";
  return `<div class="map-popup">
    <strong>${escapeHtml(friendlyCatchment(name))}</strong> <span class="map-popup-n">${escapeHtml(c.district || "")}</span>
    <table class="map-popup-table">
      <tr><td>${escapeHtml(t("col_catch_assessments"))}</td><td>${formatNumber(c.catchmentAssessments)}</td></tr>
      <tr><td>${escapeHtml(t("pop_sites_assessed"))}</td><td>${formatNumber(c.sitesAssessed)}</td></tr>
      <tr><td>${escapeHtml(t("pop_coverage"))}</td><td>${cov}</td></tr>
      <tr><td>${escapeHtml(t("pop_providers"))}</td><td>${formatNumber(c.activeAgencies)}</td></tr>
    </table>
    ${c.topMissing && c.topMissing.length ? `<div class="map-popup-missing">${escapeHtml(t("pop_top_missing"))}: ${c.topMissing.map((sec) => `${sectorIcon(sec, 13)} ${escapeHtml(sec)}`).join(" · ")}</div>` : ""}
    <button type="button" class="btn btn-light btn-sm" data-map-filter="catchment::${escapeHtml(name)}">${escapeHtml(t("pop_filter"))}</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Styles: choropleth fill + filter emphasis in one place.

function _districtChoroplethStyle(name, stats, view) {
  const s = stats.get(name);
  const filled = view !== "catchments";
  const pct = s ? s.coveragePct : null;
  const selectedDim = filters.district.size && !filters.district.has(name);
  return {
    color: filters.district.has(name) ? "#0E4655" : "#17677A",
    weight: filters.district.has(name) ? 3 : 1,
    opacity: selectedDim ? 0.35 : 0.9,
    fillColor: filled && s ? statusColor(pct) : "#9AA5B1",
    fillOpacity: !filled ? 0.02 : selectedDim ? 0.08 : s ? 0.45 : 0.04,
  };
}

function _catchmentChoroplethStyle(name, catchStats, view) {
  if (view !== "catchments") return { opacity: 0, fillOpacity: 0, interactive: false };
  const c = catchStats.get(name);
  const dim = filters.catchment.size && !filters.catchment.has(name);
  return {
    color: "#8a4a2a",
    weight: filters.catchment.has(name) ? 3 : 1.2,
    opacity: dim ? 0.3 : 1,
    fillColor: c && c.coveragePct !== null ? statusColor(c.coveragePct) : "#9AA5B1",
    fillOpacity: dim ? 0.06 : c ? 0.55 : 0.08,
  };
}

// ---------------------------------------------------------------------------

function renderGeography(records) {
  const map = initMap();
  const view = _mapView();
  const sector = view === "sector" ? _mapSector() : null;

  const districtStats = computeDistrictMapStats(records, sector);
  const catchStats = new Map();
  computeCatchmentAnalysis(records).forEach((c) => catchStats.set(c.catchment, c));

  if (state.geo && !state.maps.boundariesLoaded) {
    state.maps.districtLayers = [];
    if (state.geo.districts) {
      const districts = L.geoJSON(state.geo.districts, {
        style: () => ({}),
        onEachFeature: (feature, layer) => {
          const name = feature.properties.name;
          state.maps.districtLayers.push({ name, layer });
          layer.on("mouseover", () => layer.setStyle({ weight: 3, opacity: 1 }));
          layer.on("mouseout", () => layer.setStyle(_districtChoroplethStyle(name, state.maps._districtStats || new Map(), _mapView())));
        },
      });
      districts.addTo(state.maps.boundaryLayer);
      // Frame Somalia, not the Horn of Africa: fit the actual boundary extent.
      try { map.fitBounds(districts.getBounds(), { padding: [8, 8] }); } catch (e) { /* empty geojson */ }
      state.maps.districtBounds = (() => { try { return districts.getBounds(); } catch (e) { return null; } })();
    }
    state.maps.catchmentLayers = [];
    if (state.geo.catchments) {
      const catchments = L.geoJSON(state.geo.catchments, {
        style: () => ({}),
        onEachFeature: (feature, layer) => {
          state.maps.catchmentLayers.push({ name: feature.properties.name, district: feature.properties.district, layer });
        },
      });
      catchments.addTo(state.maps.catchmentGroup);
    }
    state.maps.boundariesLoaded = true;
  }

  // Stash for mouseout restores.
  state.maps._districtStats = districtStats;

  // Catchment layer only participates in the catchment view — in the district
  // views it is pure noise over the choropleth.
  const wantCatchments = view === "catchments";
  if (wantCatchments && !map.hasLayer(state.maps.catchmentGroup)) state.maps.catchmentGroup.addTo(map);
  if (!wantCatchments && map.hasLayer(state.maps.catchmentGroup)) map.removeLayer(state.maps.catchmentGroup);

  (state.maps.districtLayers || []).forEach(({ name, layer }) => {
    layer.setStyle(_districtChoroplethStyle(name, districtStats, view));
    const stats = districtStats.get(name);
    layer.unbindTooltip();
    const cov = stats && stats.coveragePct !== null ? ` — ${Math.round(stats.coveragePct)}%` : "";
    layer.bindTooltip(`${escapeHtml(name)}${cov}`, { sticky: true });
    layer.unbindPopup();
    layer.bindPopup(() => _districtPopupHtml(name, stats), { maxWidth: 320 });
  });

  (state.maps.catchmentLayers || []).forEach(({ name, layer }) => {
    layer.setStyle(_catchmentChoroplethStyle(name, catchStats, view));
    const c = catchStats.get(name);
    layer.unbindTooltip();
    if (wantCatchments) {
      const cov = c && c.coveragePct !== null ? ` — ${Math.round(c.coveragePct)}%` : "";
      layer.bindTooltip(`${escapeHtml(friendlyCatchment(name))}${cov}`, { sticky: true });
      layer.unbindPopup();
      layer.bindPopup(() => _catchmentPopupHtml(name, c), { maxWidth: 320 });
    }
  });

  autoZoomToSelection();
  renderMapLegend(view, sector);
}

// Fit the map to the selected district/catchment POLYGONS (the public payload
// carries no point coordinates by design).
function autoZoomToSelection() {
  const map = state.maps.main;
  if (!map) return;
  const geoActive = filters.district.size || filters.catchment.size;
  const signature = geoActive
    ? `${[...filters.district].sort()}|${[...filters.catchment].sort()}`
    : "";
  if (signature === state.maps.lastZoomSignature) return;
  state.maps.lastZoomSignature = signature;

  if (!geoActive) {
    if (state.maps.districtBounds) map.fitBounds(state.maps.districtBounds, { padding: [8, 8] });
    else map.setView(SOMALIA_CENTER, SOMALIA_ZOOM);
    return;
  }
  let bounds = null;
  const extend = (layer) => {
    try {
      const b = layer.getBounds();
      bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
    } catch (e) { /* layer without bounds */ }
  };
  (state.maps.districtLayers || []).forEach(({ name, layer }) => { if (filters.district.has(name)) extend(layer); });
  (state.maps.catchmentLayers || []).forEach(({ name, layer }) => { if (filters.catchment.has(name)) extend(layer); });
  if (bounds) map.fitBounds(bounds.pad(0.25), { maxZoom: 11, animate: true });
}

function renderMapLegend(view, sector) {
  const legend = document.getElementById("map-legend");
  if (!legend) return;
  const grain = view === "catchments" ? t("legend_grain_map_catchment")
    : view === "sector"
      ? (sector ? t("legend_grain_map_sector", { sector }) : t("legend_pick_sector"))
      : t("legend_grain_map_district");
  legend.innerHTML = `
    <span class="legend-grain"><strong>${escapeHtml(grain)}</strong></span>
    <span><span class="legend-dot" style="background:${COLORS.success}"></span> ${t("legend_cov_high")}</span>
    <span><span class="legend-dot" style="background:${COLORS.warning}"></span> ${t("legend_cov_mid")}</span>
    <span><span class="legend-dot" style="background:${COLORS.critical}"></span> ${t("legend_cov_low")}</span>
    <span><span class="legend-dot" style="background:#9AA5B1"></span> ${t("legend_nodata")}</span>
    <span class="legend-hint">${escapeHtml(t("legend_click_hint"))}</span>
  `;
}

function resetMapView() {
  const map = state.maps.main;
  if (!map) return;
  if (state.maps.districtBounds) map.fitBounds(state.maps.districtBounds, { padding: [8, 8] });
  else map.setView(SOMALIA_CENTER, SOMALIA_ZOOM);
}

function toggleMapFullscreen() {
  const container = document.getElementById("map-container");
  container.classList.toggle("fullscreen");
  setTimeout(() => state.maps.main && state.maps.main.invalidateSize(), 200);
}
