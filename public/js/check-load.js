let map;
let routeLine;

// Toggle this ON later when auth.html exists and you're ready to enforce signup.
const ENABLE_SIGNUP_GATE = true;

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

/* -------------------------------------------------------------------------- */
/*                               AUTH + GATING                                */
/* -------------------------------------------------------------------------- */

async function getMe() {
  try {
    const res = await fetch('/api/auth/me', { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.user || null;
  } catch {
    return null;
  }
}

function getAnalyzeCount() {
  return Number(localStorage.getItem('analyzeCount') || '0');
}

function setAnalyzeCount(n) {
  localStorage.setItem('analyzeCount', String(n));
}

function redirectToAuth() {
  const returnUrl = encodeURIComponent('/check-load.html');
  window.location.href = `/auth.html?returnUrl=${returnUrl}`;
}

/* -------------------------------------------------------------------------- */
/*                               DOM READY                                    */
/* -------------------------------------------------------------------------- */

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

  // ✅ Auto-update ONLY miles + route as user edits origin/destination
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
/*                            RESULTS UI (LOADING)                             */
/* -------------------------------------------------------------------------- */

function resetResultsUI() {
  const scoreValue = document.getElementById('score-value');
  const verdictText = document.getElementById('verdict-text');
  const scoreCircle = document.getElementById('score-circle');

  if (scoreValue) scoreValue.innerText = '--';
  if (verdictText) verdictText.innerText = 'Analyzing...';
  if (scoreCircle) scoreCircle.style.borderColor = 'transparent';

  const netPerMile = document.getElementById('net-per-mile');
  const avgGas = document.getElementById('avg-gas-price');
  const fuelCost = document.getElementById('total-fuel-cost');
  const netRevenue = document.getElementById('net-revenue');

  if (netPerMile) netPerMile.innerText = '$--';
  if (avgGas) avgGas.innerText = '$--';
  if (fuelCost) fuelCost.innerText = '$--';
  if (netRevenue) netRevenue.innerText = '$--';
}

function setResultsVisibleDuringAnalyze(isAnalyzing) {
  const statsGrid = document.querySelector('#results-display .stats-grid');
  const decisionRow = document.querySelector('#results-display .form-row');

  if (isAnalyzing) {
    statsGrid?.classList.add('hidden');
    decisionRow?.classList.add('hidden');
  } else {
    statsGrid?.classList.remove('hidden');
    decisionRow?.classList.remove('hidden');
  }
}

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
    // ✅ miles-only routing (fast, no geometry)
    const routeInfo = await updateRoute(origin, dest, { simple: true, draw: false });

    if (routeInfo?.miles && !userEditedMiles) {
      const milesEl = document.getElementById('miles');
      if (milesEl) milesEl.value = Math.round(routeInfo.miles);
    }
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
  // ✅ Keep `me` in scope (fixes ReferenceError)
  let me = null;

  // ✅ Force signup after 3 analyzes (only when gate enabled)
  if (ENABLE_SIGNUP_GATE) {
    me = await getMe();
    if (!me) {
      const count = getAnalyzeCount();
      if (count >= 3) {
        redirectToAuth();
        return;
      }
    }
  }

  const analyzeBtn = document.getElementById('analyze-btn');
  const verdictText = document.getElementById('verdict-text');

  analyzeBtn.disabled = true;
  analyzeBtn.innerText = 'Analyzing...';

  document.getElementById('results-display')?.classList.remove('hidden');
  resetResultsUI();
  setResultsVisibleDuringAnalyze(true);

  const origin = document.getElementById('origin')?.value?.trim() || '';
  const dest = document.getElementById('destination')?.value?.trim() || '';

  let routeInfo = null;

  try {
    // Full routing on analyze (for sample points + optional drawing)
    if (origin && dest) {
      routeInfo = await updateRoute(origin, dest, { simple: false, draw: true });

      if (routeInfo?.miles && !userEditedMiles) {
        const milesEl = document.getElementById('miles');
        if (milesEl) milesEl.value = Math.round(routeInfo.miles);
      }
    }

    // Avg diesel ONLY on analyze
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

    // Profit calc (uses avg diesel if available)
    await calculateProfitInternal(avgGasPrice, true);

    // Count analyzes only when gate enabled AND user is logged out
    if (ENABLE_SIGNUP_GATE && !me) {
      setAnalyzeCount(getAnalyzeCount() + 1);
    }

    setResultsVisibleDuringAnalyze(false);
  } catch (err) {
    console.error('Analyze error:', err);
    verdictText.innerText = 'Error analyzing load';
    setResultsVisibleDuringAnalyze(false);
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerText = 'Analyze Profit';
  }
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
  if (lastComputed.rate == null) return;

  const origin = document.getElementById('origin')?.value || null;
  const destination = document.getElementById('destination')?.value || null;

  const res = await fetch('/api/save-load', {
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

  if (res.status === 401) {
    const returnUrl = encodeURIComponent('/check-load.html');
    window.location.href = `/auth.html?returnUrl=${returnUrl}`;
  }
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

/**
 * updateRoute(from, to, { simple, draw })
 * - simple=true  => fast miles-only (requires server to support simple=1)
 * - simple=false => full geometry for sampling + drawing
 * - draw=false   => don't draw route line / fit bounds (for auto-miles)
 */
async function updateRoute(from, to, { simple = false, draw = true } = {}) {
  try {
    const a = await geocodeAddress(from);
    const b = await geocodeAddress(to);

    const url =
      `/api/osrm/route?fromLon=${a.lon}&fromLat=${a.lat}&toLon=${b.lon}&toLat=${b.lat}` +
      `&simple=${simple ? '1' : '0'}`;

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('route request failed');

    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) throw new Error('no route found');

    const miles = route.distance * 0.000621371;

    let samplePoints = [];
    // Only sample if geometry exists (simple mode won't have it)
    if (!simple && route.geometry?.coordinates?.length) {
      const coords = route.geometry.coordinates;
      samplePoints = sampleRoutePoints(coords, 6);

      if (draw) {
        if (routeLine) map.removeLayer(routeLine);
        routeLine = L.geoJSON(route.geometry).addTo(map);
        map.fitBounds(routeLine.getBounds(), { padding: [20, 20] });
      }
    }

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