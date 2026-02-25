let map;
let routeLine;

let lastComputed = {
  rate: null,
  miles: null,
  mpg: null,
  fuelPrice: null,
  fuelCost: null,
  netRevenue: null,
  netPerMile: null,
};

document.addEventListener('DOMContentLoaded', () => {
  map = L.map('map').setView([39.82, -98.57], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  // Center on current location + fill origin (best effort)
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 10);
      L.marker([latitude, longitude]).addTo(map);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        const res = await fetch(`/api/nominatim/reverse?lat=${latitude}&lon=${longitude}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });

        clearTimeout(timeout);

        if (!res.ok) throw new Error('reverse geocode failed');
        const data = await res.json();

        const city =
          data?.address?.city ||
          data?.address?.town ||
          data?.address?.village ||
          data?.address?.hamlet ||
          '';

        const state = data?.address?.state || '';
        if (city && state) document.getElementById('origin').value = `${city}, ${state}`;
      } catch (e) {
        console.log('Location name fetch failed:', e.message);
      }
    },
    (err) => console.log('Geolocation failed:', err.message),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
});

async function calculateProfit() {
  const origin = document.getElementById('origin').value.trim();
  const dest = document.getElementById('destination').value.trim();

  const rate = parseFloat(document.getElementById('rate').value);
  const mpg = parseFloat(document.getElementById('mpg').value);
  const milesInput = document.getElementById('miles');

  // Show results section early (so user sees progress)
  document.getElementById('results-display').classList.remove('hidden');

  // Loading indicator for avg gas
  const avgGasEl = document.getElementById('avg-gas-price');
  if (avgGasEl) avgGasEl.innerText = '$...';

  // 1) Route (best effort)
  let routeInfo = null;
  if (origin && dest) routeInfo = await updateRoute(origin, dest);

  const miles = parseFloat(milesInput.value) || 0;

  // 2) Avg diesel price (EIA)
  let avgGasPrice = null;
  if (routeInfo?.samplePoints?.length) {
    avgGasPrice = await fetchAvgDieselPriceEIA(routeInfo.samplePoints);
  } else {
    console.log('No route samplePoints available; skipping gas average.');
  }

  if (avgGasEl) {
    avgGasEl.innerText = typeof avgGasPrice === 'number' ? `$${avgGasPrice.toFixed(2)}` : '$--';
  }

  // 3) Profit calc
  const response = await fetch('/api/calculate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rate,
      miles,
      mpg,
      fuelPrice: typeof avgGasPrice === 'number' ? avgGasPrice : undefined,
    }),
  });

  const data = await response.json();

  document.getElementById('score-value').innerText = data.score;
  document.getElementById('net-per-mile').innerText = `$${parseFloat(data.netPerMile).toFixed(2)}`;
  document.getElementById('total-fuel-cost').innerText = `$${Math.round(data.fuelCost)}`;
  document.getElementById('net-revenue').innerText = `$${Math.round(data.netRevenue)}`;
  document.getElementById('verdict-text').innerText = data.rating;
  document.getElementById('score-circle').style.borderColor = data.color;

  lastComputed = {
    rate,
    miles,
    mpg,
    fuelPrice: typeof avgGasPrice === 'number' ? avgGasPrice : null,
    fuelCost: data.fuelCost,
    netRevenue: data.netRevenue,
    netPerMile: data.netPerMile,
  };
}

async function saveThisLoad() {
  if (lastComputed.rate == null) return;

  await fetch('/api/save-load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rate: lastComputed.rate,
      miles: lastComputed.miles,
      fuelCost: lastComputed.fuelCost,
      netRevenue: lastComputed.netRevenue,
      netPerMile: lastComputed.netPerMile,
      avgGasPrice: lastComputed.fuelPrice,
    }),
  });
}

async function geocodeAddress(query) {
  const url = `/api/nominatim/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('geocode failed');

  const data = await res.json();
  if (!data?.length) throw new Error('no geocode results');

  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function updateRoute(from, to) {
  try {
    const a = await geocodeAddress(from);
    const b = await geocodeAddress(to);

    const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('route request failed');

    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) throw new Error('no route found');

    const miles = route.distance * 0.000621371;
    document.getElementById('miles').value = Math.round(miles);

    if (routeLine) map.removeLayer(routeLine);
    routeLine = L.geoJSON(route.geometry).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [20, 20] });

    const coords = route.geometry?.coordinates || [];
    const samplePoints = sampleRoutePoints(coords, 6);

    return { miles, geometry: route.geometry, samplePoints };
  } catch (e) {
    console.log('Routing failed:', e.message);
    return null;
  }
}

function sampleRoutePoints(coords, n) {
  if (!Array.isArray(coords) || coords.length === 0) return [];
  if (coords.length <= n) return coords.map(([lon, lat]) => ({ lat, lon }));

  const points = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (coords.length - 1)) / (n - 1));
    const [lon, lat] = coords[idx];
    points.push({ lat, lon });
  }
  return points;
}

async function fetchAvgDieselPriceEIA(samplePoints) {
  try {
    const res = await fetch('/api/gas/average', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: samplePoints }),
    });

    if (!res.ok) throw new Error('gas avg endpoint failed');
    const data = await res.json();

    if (typeof data?.avgFuelPrice === 'number') return data.avgFuelPrice;

    console.log('Gas avg returned null:', data);
    return null;
  } catch (e) {
    console.log('Avg diesel price failed:', e.message);
    return null;
  }
}