let map;
let routeLine;

// Stored after analysis so Accept/Reject can persist the same values
let lastComputed = {
  rate: null,
  miles: null,
  mpg: null,
  fuelPrice: null,
  fuelCost: null,
  netRevenue: null,
  netPerMile: null,
};

let isAutoUpdating = false;
let userEditedMiles = false;

function debounce(fn, ms = 900) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

document.addEventListener('DOMContentLoaded', () => {
  map = L.map('map').setView([39.82, -98.57], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  // Track manual miles edits so we don’t overwrite them
  const milesEl = document.getElementById('miles');
  if (milesEl) {
    milesEl.addEventListener('input', () => {
      userEditedMiles = true;
    });
  }

  // ✅ Auto-update ONLY miles + route (no diesel/profit) as user edits origin/destination
  const debouncedMilesOnly = debounce(() => autoUpdateMilesOnly(), 900);
  const originEl = document.getElementById('origin');
  const destEl = document.getElementById('destination');

  if (originEl) originEl.addEventListener('input', debouncedMilesOnly);
  if (destEl) destEl.addEventListener('input', debouncedMilesOnly);
  if (destEl) destEl.addEventListener('blur', () => autoUpdateMilesOnly());

  // Center on current location + fill origin (best effort)
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;

      map.setView([latitude, longitude], 10);
      L.marker([latitude, longitude]).addTo(map);

      try {
        const res = await fetch(`/api/nominatim/reverse?lat=${latitude}&lon=${longitude}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error('reverse geocode failed');

        const data = await res.json();

        const city =
          data?.address?.city ||
          data?.address?.town ||
          data?.address?.village ||
          data?.address?.hamlet ||
          '';

        const state = data?.address?.state || '';

        if (city && state && originEl && !originEl.value.trim()) {
          originEl.value = `${city}, ${state}`;
          // optional: trigger miles-only update if destination already filled
          autoUpdateMilesOnly();
        }
      } catch (e) {
        console.log('Location name fetch failed:', e.message);
      }
    },
    (err) => console.log('Geolocation failed:', err.message),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
});

/* -------------------------------------------------------------------------- */
/*                            AUTO MILES (NO ANALYSIS)                        */
/* -------------------------------------------------------------------------- */

async function autoUpdateMilesOnly() {
  if (isAutoUpdating) return;

  const origin = document.getElementById('origin')?.value?.trim() || '';
  const dest = document.getElementById('destination')?.value?.trim() || '';
  if (!origin || !dest) return;

  isAutoUpdating = true;
  try {
    const routeInfo = await updateRoute(origin, dest);

    if (routeInfo?.miles && !userEditedMiles) {
      const milesEl = document.getElementById('miles');
      if (milesEl) milesEl.value = Math.round(routeInfo.miles);
    }

    // IMPORTANT: do NOT fetch diesel here
    // IMPORTANT: do NOT run profit calc here
  } catch (e) {
    console.log('Auto miles update failed:', e.message);
  } finally {
    isAutoUpdating = false;
  }
}

/* -------------------------------------------------------------------------- */
/*                               ANALYZE BUTTON                               */
/* -------------------------------------------------------------------------- */

async function calculateProfit() {
  const origin = document.getElementById('origin')?.value?.trim() || '';
  const dest = document.getElementById('destination')?.value?.trim() || '';

  // Show results area (so user sees progress)
  document.getElementById('results-display')?.classList.remove('hidden');

  // Ensure route/miles up-to-date at analyze time
  let routeInfo = null;
  if (origin && dest) {
    routeInfo = await updateRoute(origin, dest);

    if (routeInfo?.miles && !userEditedMiles) {
      const milesEl = document.getElementById('miles');
      if (milesEl) milesEl.value = Math.round(routeInfo.miles);
    }
  }

  // Fetch avg diesel ONLY on analyze
  const avgGasEl = document.getElementById('avg-gas-price');
  if (avgGasEl) avgGasEl.innerText = '$...';

  let avgGasPrice = null;
  if (routeInfo?.samplePoints?.length) {
    avgGasPrice = await fetchAvgDieselPriceEIA(routeInfo.samplePoints);
  }

  if (avgGasEl) {
    avgGasEl.innerText =
      typeof avgGasPrice === 'number' ? `$${avgGasPrice.toFixed(2)}` : '$--';
  }

  // Run profit calc (uses avg diesel if available)
  await calculateProfitInternal(avgGasPrice, true);
}

async function calculateProfitInternal(forcedGasPrice = null, showResults = true) {
  const rate = parseFloat(document.getElementById('rate')?.value);
  const mpg = parseFloat(document.getElementById('mpg')?.value);
  const miles = parseFloat(document.getElementById('miles')?.value) || 0;

  if (showResults) document.getElementById('results-display')?.classList.remove('hidden');

  const response = await fetch('/api/calculate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rate,
      miles,
      mpg,
      fuelPrice: typeof forcedGasPrice === 'number' ? forcedGasPrice : undefined,
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
    fuelPrice: typeof forcedGasPrice === 'number' ? forcedGasPrice : null,
    fuelCost: data.fuelCost,
    netRevenue: data.netRevenue,
    netPerMile: data.netPerMile,
  };
}

/* -------------------------------------------------------------------------- */
/*                             ACCEPT / REJECT SAVE                           */
/* -------------------------------------------------------------------------- */

async function submitDecision(decision) {
  // decision: "accepted" | "rejected"
  if (lastComputed.rate == null) return;

  const origin = document.getElementById('origin')?.value || null;
  const destination = document.getElementById('destination')?.value || null;

  await fetch('/api/save-load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      decision,
      origin,
      destination,
      rate: lastComputed.rate,
      miles: lastComputed.miles,
      fuelCost: lastComputed.fuelCost,
      netRevenue: lastComputed.netRevenue,
      netPerMile: lastComputed.netPerMile,
      avgGasPrice: lastComputed.fuelPrice,
    }),
  });
}

/* -------------------------------------------------------------------------- */
/*                                   ROUTING                                  */
/* -------------------------------------------------------------------------- */

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

    if (routeLine) map.removeLayer(routeLine);
    routeLine = L.geoJSON(route.geometry).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [20, 20] });

    const coords = route.geometry?.coordinates || [];
    const samplePoints = sampleRoutePoints(coords, 6);

    return { miles, samplePoints };
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

/* -------------------------------------------------------------------------- */
/*                             DIESEL (EIA via API)                           */
/* -------------------------------------------------------------------------- */

async function fetchAvgDieselPriceEIA(samplePoints) {
  try {
    const res = await fetch('/api/gas/average', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: samplePoints }),
    });

    if (!res.ok) throw new Error('gas avg endpoint failed');
    const data = await res.json();

    return typeof data?.avgFuelPrice === 'number' ? data.avgFuelPrice : null;
  } catch (e) {
    console.log('Avg diesel price failed:', e.message);
    return null;
  }
}