let map;
let routeLine; // Leaflet layer handle for the drawn route

document.addEventListener('DOMContentLoaded', () => {
  // Init map (default: USA)
  map = L.map('map').setView([39.82, -98.57], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  // Try to locate user and center the map + fill origin
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;

      map.setView([latitude, longitude], 10);
      L.marker([latitude, longitude]).addTo(map);

      // Reverse geocode to fill origin (best effort)
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
          {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          }
        );

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

        if (city && state) {
          document.getElementById('origin').value = `${city}, ${state}`;
        }
      } catch (e) {
        console.log('Location name fetch failed:', e.message);
      }
    },
    (err) => {
      console.log('Geolocation failed:', err.message);
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
});

async function calculateProfit() {
  const origin = document.getElementById('origin').value.trim();
  const dest = document.getElementById('destination').value.trim();

  const rate = parseFloat(document.getElementById('rate').value);
  const milesInput = document.getElementById('miles');
  const mpg = parseFloat(document.getElementById('mpg').value);

  // Best-effort: update miles + draw route if origin/dest given
  if (origin && dest) {
    await updateRoute(origin, dest);
  }

  const miles = parseFloat(milesInput.value) || 0;

  const response = await fetch('/api/calculate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rate, miles, mpg }),
  });

  const data = await response.json();

  document.getElementById('results-display').classList.remove('hidden');

  document.getElementById('score-value').innerText = data.score;
  document.getElementById('net-per-mile').innerText = `$${parseFloat(data.netPerMile).toFixed(2)}`;
  document.getElementById('total-fuel-cost').innerText = `$${Math.round(data.fuelCost)}`;
  document.getElementById('net-revenue').innerText = `$${Math.round(data.netRevenue)}`;
  document.getElementById('verdict-text').innerText = data.rating;
  document.getElementById('score-circle').style.borderColor = data.color;
}

async function geocodeAddress(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('geocode failed');

  const data = await res.json();
  if (!data || !data.length) throw new Error('no geocode results');

  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function updateRoute(from, to) {
  try {
    const a = await geocodeAddress(from);
    const b = await geocodeAddress(to);

    // OSRM expects lon,lat pairs
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('route request failed');

    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) throw new Error('no route found');

    // meters -> miles
    const miles = route.distance * 0.000621371;
    document.getElementById('miles').value = Math.round(miles);

    // Draw route line
    if (routeLine) map.removeLayer(routeLine);
    routeLine = L.geoJSON(route.geometry).addTo(map);

    map.fitBounds(routeLine.getBounds(), { padding: [20, 20] });
  } catch (e) {
    console.log('Routing failed:', e.message);
    // Never throw — routing should not break calculator
  }
}