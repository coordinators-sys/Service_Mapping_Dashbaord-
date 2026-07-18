// Leaflet map: OpenStreetMap basemap (no token), district/catchment
// boundaries from static GeoJSON, site markers with simple zoom-based grid
// clustering (no external clustering plugin — Leaflet core only, per spec).

const SOMALIA_CENTER = [5.0, 46.0];
const SOMALIA_ZOOM = 6;
const CLUSTER_ZOOM_THRESHOLD = 7;

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
  state.maps.markerLayer = L.layerGroup().addTo(map);
  state.maps.boundaryLayer = L.layerGroup().addTo(map);

  map.on("zoomend", () => renderGeography(filtered()));
  return map;
}

function loadBoundaryLayer(map, geojson, options) {
  if (!geojson) return null;
  return L.geoJSON(geojson, {
    style: { color: "#17677A", weight: 1, fillOpacity: 0.03 },
    onEachFeature: (feature, layer) => {
      layer.on("mouseover", () => layer.setStyle({ weight: 3, fillOpacity: 0.12, color: "#EC6B4D" }));
      layer.on("mouseout", () => layer.setStyle({ color: "#17677A", weight: 1, fillOpacity: 0.03 }));
      if (options && options.onClick) layer.on("click", () => options.onClick(feature));
    },
  });
}

function sitePointsFromRecords(records) {
  // Marker COLOR is driven by canonical site×sector status (semantic layer,
  // Yes>No>Unknown), so a site's map color always matches the coverage
  // charts. Coordinates, agencies and freshness stay record-level facts.
  const statusMap = siteSectorStatusMap(siteSectorCells(records));
  const bySite = new Map();
  records.forEach((r) => {
    if (r.latitude == null || r.longitude == null) return;
    const key = siteKey(r);
    if (!key) return;
    if (!bySite.has(key)) {
      bySite.set(key, { key, name: siteLabel(r), lat: r.latitude, lon: r.longitude, statuses: statusMap.get(key) || {}, agencies: new Set(), lastUpdated: r.lastUpdated });
    }
    const entry = bySite.get(key);
    if (r.agency && r.coverageStatus === "Yes") entry.agencies.add(r.agency);
    if (r.lastUpdated && (!entry.lastUpdated || r.lastUpdated > entry.lastUpdated)) entry.lastUpdated = r.lastUpdated;
  });
  // Only ASSESSED sites go on the map (>=1 sector answered Yes or No) — same
  // rule as the sites table. Sites with zero assessment data would all render
  // as grey "unknown" dots that carry no information and confuse readers.
  return Array.from(bySite.values()).filter((p) =>
    Object.values(p.statuses).some((s) => s === "Yes" || s === "No")
  );
}

function pointColorForMode(point, mode) {
  const sector = filters.sector.size === 1 ? Array.from(filters.sector)[0] : null;

  if (mode === "sector" && sector) {
    const status = point.statuses[sector];
    if (status === "Yes") return COLORS.success;
    if (status === "No") return COLORS.critical;
    return COLORS.unknown;
  }
  if (mode === "agencies") {
    if (point.agencies.size >= 3) return COLORS.success;
    if (point.agencies.size >= 1) return COLORS.warning;
    return COLORS.critical;
  }
  if (mode === "gaps") {
    const gaps = PRIORITY_SECTORS.filter((s) => point.statuses[s] === "No").length;
    if (gaps === 0) return COLORS.success;
    if (gaps <= 1) return COLORS.warning;
    return COLORS.critical;
  }
  if (mode === "freshness") {
    if (!point.lastUpdated) return COLORS.unknown;
    const days = (Date.now() - new Date(point.lastUpdated).getTime()) / 86400000;
    if (days <= 90) return COLORS.success;
    if (days <= 180) return COLORS.warning;
    return COLORS.critical;
  }

  // overall
  const covered = Object.values(point.statuses).filter((s) => s === "Yes").length;
  const total = Object.values(point.statuses).filter((s) => s === "Yes" || s === "No").length;
  const pct = total ? (covered / total) * 100 : null;
  return statusColor(pct);
}

function renderGeography(records) {
  const map = initMap();
  state.maps.markerLayer.clearLayers();

  if (state.geo && !state.maps.boundariesLoaded) {
    const districts = loadBoundaryLayer(map, state.geo.districts, {
      onClick: (f) => toggleFilterValue("district", f.properties.name, false),
    });
    if (districts) districts.addTo(state.maps.boundaryLayer);

    // Catchment polygons (2025 CA shapefiles) — dashed orange outline to
    // stand apart from district boundaries; click filters by catchment.
    if (state.geo.catchments) {
      const catchments = L.geoJSON(state.geo.catchments, {
        style: { color: "#EC6B4D", weight: 1.5, dashArray: "4 3", fillOpacity: 0.04 },
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(`${escapeHtml(feature.properties.name)} (${escapeHtml(feature.properties.district || "")})`);
          layer.on("mouseover", () => layer.setStyle({ weight: 3, fillOpacity: 0.15 }));
          layer.on("mouseout", () => layer.setStyle({ weight: 1.5, fillOpacity: 0.04 }));
          layer.on("click", () => toggleFilterValue("catchment", feature.properties.name, false));
        },
      });
      catchments.addTo(state.maps.boundaryLayer);
    }
    state.maps.boundariesLoaded = true;
  }

  const mode = document.getElementById("map-mode").value;
  const points = sitePointsFromRecords(records);
  const zoom = map.getZoom();

  if (zoom < CLUSTER_ZOOM_THRESHOLD && points.length > 40) {
    renderClusteredPoints(points, mode);
  } else {
    points.forEach((point) => {
      const color = pointColorForMode(point, mode);
      const marker = L.circleMarker([point.lat, point.lon], {
        radius: 6, color, fillColor: color, fillOpacity: 0.85, weight: 1,
      });
      marker.bindTooltip(escapeHtml(point.name));
      marker.on("click", () => openSiteDrawer(point.key));
      marker.addTo(state.maps.markerLayer);
    });
  }

  autoZoomToSelection(points);
  renderMapLegend(mode);
}

// When a geographic filter (district/catchment/site) is active, fit the map
// to the sites in the current selection so users don't have to pan/zoom
// manually. National extent is restored when those filters are cleared.
// Guarded by a signature so we don't re-fit (and fight the user's manual
// zoom) on every unrelated re-render.
function autoZoomToSelection(points) {
  const map = state.maps.main;
  if (!map) return;
  const geoActive = filters.district.size || filters.catchment.size || filters.site.size;
  const signature = geoActive
    ? `${[...filters.district].sort()}|${[...filters.catchment].sort()}|${[...filters.site].sort()}`
    : "";
  if (signature === state.maps.lastZoomSignature) return;
  state.maps.lastZoomSignature = signature;

  if (!geoActive) {
    map.setView(SOMALIA_CENTER, SOMALIA_ZOOM);
    return;
  }
  const coords = points.filter((p) => p.lat != null && p.lon != null).map((p) => [p.lat, p.lon]);
  if (!coords.length) return;
  if (coords.length === 1) map.setView(coords[0], 13);
  else map.fitBounds(L.latLngBounds(coords).pad(0.2), { maxZoom: 13, animate: true });

  // Bring the map into view so the zoom is actually seen — the filter bar
  // sits at the top of the page but the map is a section below it, so a
  // geographic filter would otherwise zoom off-screen. Only scrolls when the
  // map is mostly out of view, so it won't yank the page if you're already
  // looking at the map. invalidateSize() re-fits Leaflet after the scroll.
  const section = document.getElementById("section-maps");
  if (section) {
    const rect = section.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const visible = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
    if (visible < Math.min(rect.height, vh) * 0.4) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => map.invalidateSize(), 350);
    }
  }
}

function renderClusteredPoints(points, mode) {
  const cellSize = 0.4; // degrees
  const cells = new Map();
  points.forEach((p) => {
    const cellKey = `${Math.round(p.lat / cellSize)}:${Math.round(p.lon / cellSize)}`;
    if (!cells.has(cellKey)) cells.set(cellKey, []);
    cells.get(cellKey).push(p);
  });
  cells.forEach((groupPoints) => {
    const avgLat = groupPoints.reduce((s, p) => s + p.lat, 0) / groupPoints.length;
    const avgLon = groupPoints.reduce((s, p) => s + p.lon, 0) / groupPoints.length;
    const dominantColor = pointColorForMode(groupPoints[0], mode);
    const marker = L.circleMarker([avgLat, avgLon], {
      radius: Math.min(22, 8 + Math.sqrt(groupPoints.length) * 2),
      color: dominantColor, fillColor: dominantColor, fillOpacity: 0.75, weight: 1,
    });
    marker.bindTooltip(`${groupPoints.length} sites`);
    marker.on("click", () => state.maps.main.setView([avgLat, avgLon], CLUSTER_ZOOM_THRESHOLD + 1));
    marker.addTo(state.maps.markerLayer);
  });
}

function renderMapLegend(mode) {
  const legend = document.getElementById("map-legend");
  legend.innerHTML = `
    <span><span class="legend-dot" style="background:${COLORS.success}"></span> ${t("legend_adequate")}</span>
    <span><span class="legend-dot" style="background:${COLORS.warning}"></span> ${t("legend_partial")}</span>
    <span><span class="legend-dot" style="background:${COLORS.critical}"></span> ${t("legend_critical")}</span>
    <span><span class="legend-dot" style="background:${COLORS.unknown}"></span> ${t("legend_unknown")}</span>
  `;
}

function resetMapView() {
  if (state.maps.main) state.maps.main.setView(SOMALIA_CENTER, SOMALIA_ZOOM);
}

function toggleMapFullscreen() {
  const container = document.getElementById("map-container");
  container.classList.toggle("fullscreen");
  setTimeout(() => state.maps.main && state.maps.main.invalidateSize(), 200);
}
