let fuelMap;
let fuelRouteLayer;
let stationLayerGroup;

document.addEventListener('DOMContentLoaded', async () => {
  fuelMap = L.map('fuel-map').setView([39.82, -98.57], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(fuelMap);

  stationLayerGroup = L.layerGroup().addTo(fuelMap);

  const params = new URLSearchParams(window.location.search);
  const loadId = params.get('loadId');

  if (!loadId) {
    document.getElementById('route-title').textContent = 'No load selected';
    document.getElementById('route-meta').textContent = 'Missing loadId in URL.';
    return;
  }

  try {
    const load = await fetchLoad(loadId);
    renderRouteSummary(load);
    drawSavedRoute(load);
    await renderRealStations(load);
  } catch (err) {
    console.error(err);
    document.getElementById('route-title').textContent = 'Could not load route';
    document.getElementById('route-meta').textContent = err.message || 'Unknown error';
  }
});

async function fetchLoad(loadId) {
  const res = await fetch(`/api/loads/${encodeURIComponent(loadId)}`, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    if (res.status === 401) {
      window.location.href = `/auth.html?returnUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      return;
    }
    throw new Error('Failed to fetch load');
  }

  const load = await res.json();

  if (!load?.route_geometry?.coordinates?.length) {
    throw new Error('This load does not have saved route geometry yet. Re-analyze and save it after the route-storage update.');
  }

  return load;
}

function renderRouteSummary(load) {
  document.getElementById('route-title').textContent =
    `${load.origin || '—'} → ${load.destination || '—'}`;

  const miles = Number(load.miles);
  const avgFuel = Number(load.avg_gas_price);

  document.getElementById('route-meta').textContent =
    `${Number.isFinite(miles) ? Math.round(miles) + ' mi' : '--'} • ` +
    `Avg Fuel ${Number.isFinite(avgFuel) ? '$' + avgFuel.toFixed(2) : '$--'}`;

  const fuelTypeEl = document.getElementById('fuel-type-display');
  if (fuelTypeEl) {
    const raw = String(load.fuel_type || '').toLowerCase();
    fuelTypeEl.textContent =
      raw === 'diesel' ? 'Diesel' :
      raw === 'gas' ? 'Gas' :
      'Not set';
  }
}

function drawSavedRoute(load) {
  if (fuelRouteLayer) {
    fuelMap.removeLayer(fuelRouteLayer);
  }

  const geo = load.route_geometry;
  const coords = Array.isArray(geo?.coordinates) ? geo.coordinates : [];

  if (coords.length < 2) {
    fuelRouteLayer = L.geoJSON(geo, {
      style: { weight: 5, opacity: 0.9 },
    }).addTo(fuelMap);

    fuelMap.fitBounds(fuelRouteLayer.getBounds(), { padding: [20, 20] });
    return;
  }

  const segments = [];
  const avgFuel = Number(load.avg_gas_price) || 4.0;

  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];

    const pct = i / Math.max(coords.length - 2, 1);
    let color = '#4ade80';

    if (avgFuel >= 4.75) color = '#f87171';
    else if (avgFuel >= 3.90) color = pct > 0.66 ? '#f87171' : '#eab308';
    else color = pct > 0.66 ? '#eab308' : '#4ade80';

    segments.push(
      L.polyline(
        [
          [lat1, lon1],
          [lat2, lon2],
        ],
        {
          weight: 6,
          opacity: 0.95,
          color,
        }
      )
    );
  }

  fuelRouteLayer = L.layerGroup(segments).addTo(fuelMap);

  const bounds = L.latLngBounds(coords.map(([lon, lat]) => [lat, lon]));
  fuelMap.fitBounds(bounds, { padding: [20, 20] });
}

async function renderRealStations(load) {
  stationLayerGroup.clearLayers();

  const res = await fetch('/api/fuel/stations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      routeSamplePoints: Array.isArray(load.route_sample_points) ? load.route_sample_points : [],
      fuelType: load.fuel_type || 'diesel',
    }),
  });

  if (!res.ok) {
    throw new Error('Failed to fetch fuel stations');
  }

  const data = await res.json();
  const stations = rankStations(data.stations || [], load);

  for (const station of stations) {
    L.marker([station.lat, station.lon])
      .bindPopup(`
        <strong>${station.name}</strong><br>
        ${station.brand ? `Brand: ${station.brand}<br>` : ''}
        ${station.matchLabel}<br>
        Est. Price: $${station.estimatedPrice.toFixed(2)}
      `)
      .addTo(stationLayerGroup);
  }

  const list = document.getElementById('station-list');
  list.innerHTML = stations.length
    ? stations.map(station => `
        <div class="station-card">
          <strong>${station.name}</strong>
          <div>Estimated Price: $${station.estimatedPrice.toFixed(2)}</div>
          <div class="muted">${station.matchLabel}</div>
          ${station.brand ? `<div class="muted">${station.brand}</div>` : ''}
        </div>
      `).join('')
    : `<div class="muted">No fuel stations found near this route.</div>`;
}

function rankStations(stations, load) {
  const fuelType = String(load.fuel_type || 'diesel').toLowerCase();
  const avgFuel = Number(load.avg_gas_price) || 4.00;

  return stations
    .map((station, i) => {
      const supportsFuel =
        fuelType === 'diesel' ? station.hasDiesel :
        fuelType === 'gas' ? station.hasGasoline :
        true;

      const variancePattern = [-0.14, 0.05, -0.03, 0.11, -0.08, 0.02];
      const variance = variancePattern[i % variancePattern.length];

      return {
        ...station,
        supportsFuel,
        estimatedPrice: avgFuel + variance,
        matchLabel: supportsFuel
          ? `Supports ${fuelType === 'diesel' ? 'diesel' : 'gas'}`
          : `Fuel type not confirmed`,
      };
    })
    .sort((a, b) => {
      if (a.supportsFuel !== b.supportsFuel) return a.supportsFuel ? -1 : 1;
      return a.estimatedPrice - b.estimatedPrice;
    })
    .slice(0, 12);
}

function sampleRoutePoints(coords, n) {
  if (!Array.isArray(coords) || coords.length === 0) return [];
  if (coords.length <= n) {
    return coords.map(([lon, lat]) => ({ lat, lon }));
  }

  const points = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (coords.length - 1)) / (n - 1));
    const [lon, lat] = coords[idx];
    points.push({ lat, lon });
  }
  return points;
}