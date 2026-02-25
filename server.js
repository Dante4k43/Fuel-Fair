/**
 * Fuel Fair server.js (regenerated)
 * - Static frontend from /public
 * - Nominatim proxy endpoints (fix browser CORS)
 * - Profit calc endpoint
 * - EIA avg diesel endpoint (API v2 /seriesid)
 * - Save load endpoint
 *
 * ENV:
 * - EIA_API_KEY (required for /api/gas/average)
 * - DATABASE_URL (used in db.js)
 * - NOMINATIM_UA (optional; recommended)
 */

const express = require('express');
const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

const pool = require('./db');

app.use(express.json());
app.use(express.static('public'));

const NOMINATIM_UA =
  process.env.NOMINATIM_UA ||
  'Fuel-Fair/1.0 (https://github.com/Dante4k43/Fuel-Fair; contact: dantecaraballo01@gmail.com)';

async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

app.get('/api/nominatim/reverse', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?format=json&addressdetails=1&zoom=10` +
      `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;

    const r = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': NOMINATIM_UA,
          'Referer': 'http://localhost:3000/',
        },
      },
      8000
    );

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({
        error: 'nominatim reverse failed',
        upstreamStatus: r.status,
        upstreamBody: text.slice(0, 300),
      });
    }

    const data = await r.json();
    return res.json(data);
  } catch (e) {
    return res.status(502).json({ error: 'nominatim reverse exception', message: e.message });
  }
});

app.get('/api/nominatim/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });

    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?format=json&limit=1&addressdetails=1` +
      `&q=${encodeURIComponent(q)}`;

    const r = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': NOMINATIM_UA,
          'Referer': 'http://localhost:3000/',
        },
      },
      8000
    );

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({
        error: 'nominatim search failed',
        upstreamStatus: r.status,
        upstreamBody: text.slice(0, 300),
      });
    }

    const data = await r.json();
    return res.json(data);
  } catch (e) {
    return res.status(502).json({ error: 'nominatim search exception', message: e.message });
  }
});

/* ------------------------------- Calculator ------------------------------- */

app.post('/api/calculate', (req, res) => {
  const { rate, miles, mpg, fuelPrice = 4.15 } = req.body;

  const safeRate = Number(rate) || 0;
  const safeMiles = Number(miles) || 0;
  const safeMpg = Number(mpg) || 0;
  const safeFuelPrice = Number(fuelPrice) || 4.15;

  const fuelCost = safeMpg > 0 ? (safeMiles / safeMpg) * safeFuelPrice : 0;
  const netRevenue = safeRate - fuelCost;
  const netPerMile = safeMiles > 0 ? netRevenue / safeMiles : 0;

  let rating, score, color;
  if (netPerMile >= 2.75) { rating = "Excellent"; score = 95; color = "#4ade80"; }
  else if (netPerMile >= 2.30) { rating = "Good"; score = 80; color = "#84cc16"; }
  else if (netPerMile >= 1.90) { rating = "Borderline"; score = 65; color = "#eab308"; }
  else { rating = "Bad Load"; score = 20; color = "#f87171"; }

  res.json({ fuelCost, netRevenue, netPerMile, rating, score, color, fuelPriceUsed: safeFuelPrice });
});

/* ---------------------------- EIA Avg Diesel API --------------------------- */

app.post('/api/gas/average', async (req, res) => {
  const { points = [] } = req.body;
  const apiKey = process.env.EIA_API_KEY;

  if (!apiKey) {
    return res.status(200).json({ avgFuelPrice: null, error: "EIA_API_KEY not set" });
  }

  const sliced = Array.isArray(points) ? points.slice(0, 10) : [];
  if (sliced.length === 0) return res.json({ avgFuelPrice: null, samples: [] });

  try {
    const stateCodes = [];
    for (const p of sliced) {
      const lat = Number(p.lat);
      const lon = Number(p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const st = await reverseGeocodeStateCode(lat, lon);
      if (st) stateCodes.push(st);
    }

    const uniqueStates = [...new Set(stateCodes)];
    if (uniqueStates.length === 0) {
      return res.json({ avgFuelPrice: null, samples: [], debug: { stateCodes, uniqueStates } });
    }

    const seriesIds = uniqueStates.map(stateToEiaDieselSeriesId).filter(Boolean);
    const uniqueSeriesIds = [...new Set(seriesIds)];

    const samples = [];
    for (const sid of uniqueSeriesIds) {
      const price = await getLatestEiaSeriesValue(apiKey, sid);
      if (Number.isFinite(price)) samples.push({ seriesId: sid, price });
    }

    const prices = samples.map(s => s.price).filter(Number.isFinite);
    if (prices.length === 0) {
      return res.json({ avgFuelPrice: null, samples, debug: { stateCodes, uniqueStates, seriesIds, uniqueSeriesIds } });
    }

    const avgFuelPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    return res.json({ avgFuelPrice, states: uniqueStates, samples });
  } catch (err) {
    return res.status(200).json({ avgFuelPrice: null, error: err.message });
  }
});

/* ------------------------------- EIA Helpers ------------------------------ */

const eiaCache = new Map(); // seriesId -> { value, ts }

async function getLatestEiaSeriesValue(apiKey, seriesId) {
  const cached = eiaCache.get(seriesId);
  const now = Date.now();
  if (cached && (now - cached.ts) < 6 * 60 * 60 * 1000) return cached.value;

  const url = `https://api.eia.gov/v2/seriesid/${encodeURIComponent(seriesId)}?api_key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) return NaN;

  const data = await r.json();
  const latest = data?.response?.data?.[0];
  const value = latest ? Number(latest.value) : NaN;

  if (Number.isFinite(value)) eiaCache.set(seriesId, { value, ts: now });
  return value;
}

async function reverseGeocodeStateCode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&zoom=5&lat=${lat}&lon=${lon}`;
  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': NOMINATIM_UA }
  });
  if (!r.ok) return null;

  const data = await r.json();
  const addr = data?.address || {};

  if (typeof addr.state_code === 'string' && addr.state_code.length === 2) {
    return addr.state_code.toUpperCase();
  }

  const iso = addr['ISO3166-2-lvl4'];
  if (typeof iso === 'string' && iso.startsWith('US-') && iso.length === 5) {
    return iso.slice(3).toUpperCase();
  }

  const rawState = typeof addr.state === 'string' ? addr.state.trim() : '';
  if (rawState) {
    const normalized = rawState.toLowerCase().replace(/^state of\s+/, '').replace(/^commonwealth of\s+/, '').trim();
    const exact = US_STATE_NAME_TO_ABBR[normalized];
    if (exact) return exact;
    for (const [name, abbr] of Object.entries(US_STATE_NAME_TO_ABBR)) {
      if (normalized.includes(name)) return abbr;
    }
  }

  return null;
}

const US_STATE_NAME_TO_ABBR = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO",
  "connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID",
  "illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
  "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS",
  "missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH","new jersey":"NJ",
  "new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK",
  "oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  "tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT","virginia":"VA","washington":"WA",
  "west virginia":"WV","wisconsin":"WI","wyoming":"WY","district of columbia":"DC"
};

function stateToEiaDieselSeriesId(stateCode) {
  const s = (stateCode || '').toUpperCase();

  if (s === 'CA') return 'PET.EMD_EPD2D_PTE_SCA_DPG.W';

  const westNoCA = new Set(['AK','AZ','HI','NV','OR','WA']);
  if (westNoCA.has(s)) return 'PET.EMD_EPD2D_PTE_R5XCA_DPG.W';

  const rocky = new Set(['CO','ID','MT','UT','WY','NM']);
  if (rocky.has(s)) return 'PET.EMD_EPD2D_PTE_R40_DPG.W';

  const gulf = new Set(['AL','AR','LA','MS','OK','TX']);
  if (gulf.has(s)) return 'PET.EMD_EPD2D_PTE_R30_DPG.W';

  const midwest = new Set(['IL','IN','IA','KS','KY','MI','MN','MO','NE','ND','OH','SD','TN','WI']);
  if (midwest.has(s)) return 'PET.EMD_EPD2D_PTE_R20_DPG.W';

  const newEngland = new Set(['CT','ME','MA','NH','RI','VT']);
  if (newEngland.has(s)) return 'PET.EMD_EPD2D_PTE_R1X_DPG.W';

  const centralAtlantic = new Set(['DE','DC','MD','NJ','NY','PA']);
  if (centralAtlantic.has(s)) return 'PET.EMD_EPD2D_PTE_R1Y_DPG.W';

  const lowerAtlantic = new Set(['FL','GA','NC','SC','VA','WV']);
  if (lowerAtlantic.has(s)) return 'PET.EMD_EPD2D_PTE_R1Z_DPG.W';

  return 'PET.EMD_EPD2D_PTE_NUS_DPG.W';
}

/* ------------------------------- Save a Load ------------------------------ */

app.post('/api/save-load', async (req, res) => {
  const { rate, miles, fuelCost, netRevenue, netPerMile, avgGasPrice } = req.body;

  try {
    await pool.query(
      `INSERT INTO loads (rate, miles, fuel_cost, net_profit, net_per_mile, avg_gas_price, fuel_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        Number(rate) || 0,
        Number(miles) || 0,
        Number(fuelCost) || 0,
        Number(netRevenue) || 0,
        Number(netPerMile) || 0,
        avgGasPrice == null ? null : Number(avgGasPrice),
        avgGasPrice == null ? null : Number(avgGasPrice),
      ]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`Engine running at http://localhost:${port}`));