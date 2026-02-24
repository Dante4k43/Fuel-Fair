const express = require('express');
const app = express();
const port = 3000;
const pool = require('./db');

app.use(express.json());
app.use(express.static('public'));

/**
 * Profit Engine
 * fuelPrice is optional — if provided, it overrides the default.
 */
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

/**
 * FREE Avg Diesel Price (EIA) along route:
 * 1) reverse geocode sample points -> state code
 * 2) map state -> EIA diesel region series
 * 3) fetch latest weekly price for each region series from EIA
 * 4) average them
 *
 * Requires: EIA_API_KEY (free key)
 */
app.post('/api/gas/average', async (req, res) => {
  const { points = [] } = req.body;
  const apiKey = process.env.EIA_API_KEY;

  if (!apiKey) {
    return res.status(200).json({ avgFuelPrice: null, error: "EIA_API_KEY not set" });
  }

  const sliced = Array.isArray(points) ? points.slice(0, 10) : [];
  if (sliced.length === 0) return res.json({ avgFuelPrice: null, samples: [] });

  try {
    // 1) states from sample points
    const stateCodes = [];
    for (const p of sliced) {
      const lat = Number(p.lat);
      const lon = Number(p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const st = await reverseGeocodeStateCode(lat, lon);
      if (st) stateCodes.push(st);
    }

    const uniqueStates = [...new Set(stateCodes)];
    if (uniqueStates.length === 0) return res.json({ avgFuelPrice: null, samples: [] });

    // 2) state -> series
    const seriesIds = uniqueStates
      .map(stateToEiaDieselSeriesId)
      .filter(Boolean);

    const uniqueSeriesIds = [...new Set(seriesIds)];
    if (uniqueSeriesIds.length === 0) return res.json({ avgFuelPrice: null, samples: [] });

    // 3) fetch latest price per series
    const samples = [];
    for (const sid of uniqueSeriesIds) {
      const price = await getLatestEiaSeriesValue(apiKey, sid);
      if (Number.isFinite(price)) samples.push({ seriesId: sid, price });
    }

    const prices = samples.map(s => s.price).filter(Number.isFinite);
   if (prices.length === 0) {
      return res.json({
        avgFuelPrice: null,
        samples,
        debug: {
          stateCodes,
          uniqueStates,
          seriesIds,
          uniqueSeriesIds
        }
      });
    }


    const avgFuelPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

    return res.json({
      avgFuelPrice,
      states: uniqueStates,
      samples
    });
  } catch (err) {
    return res.status(200).json({ avgFuelPrice: null, error: err.message });
  }
});

// ---------- EIA helpers ----------

// Simple in-memory cache to reduce EIA calls (6 hours)
const eiaCache = new Map(); // seriesId -> { value, ts }

async function getLatestEiaSeriesValue(apiKey, seriesId) {
  const cached = eiaCache.get(seriesId);
  const now = Date.now();
  if (cached && (now - cached.ts) < 6 * 60 * 60 * 1000) return cached.value;

  // ✅ APIv2 backward-compat route for v1 series IDs:
  // https://api.eia.gov/v2/seriesid/APIv1-SERIESID-HERE?api_key=KEY
  const url = `https://api.eia.gov/v2/seriesid/${encodeURIComponent(seriesId)}?api_key=${encodeURIComponent(apiKey)}`;

  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) return NaN;

  const data = await r.json();

  // v2 response includes a data array with "value"
  // We'll take the first row (latest) if present.
  const latest = data?.response?.data?.[0];
  const value = latest ? Number(latest.value) : NaN;

  if (Number.isFinite(value)) eiaCache.set(seriesId, { value, ts: now });
  return value;
}
async function reverseGeocodeStateCode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
  const r = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Fuel-Fair/1.0 (diesel avg)'
    }
  });

  if (!r.ok) return null;

  const data = await r.json();
  const addr = data?.address || {};

  // 1) Best case
  if (typeof addr.state_code === 'string' && addr.state_code.length === 2) {
    return addr.state_code.toUpperCase();
  }

  // 2) Common Nominatim field: "ISO3166-2-lvl4": "US-CA"
  const iso = addr['ISO3166-2-lvl4'];
  if (typeof iso === 'string' && iso.startsWith('US-') && iso.length === 5) {
    return iso.slice(3).toUpperCase();
  }

  // 3) Fallback: map full state name to abbreviation
  const stateName = typeof addr.state === 'string' ? addr.state.trim() : '';
  if (stateName) {
    const abbr = US_STATE_NAME_TO_ABBR[stateName.toLowerCase()];
    if (abbr) return abbr;
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

/**
 * Region mapping (free + stable):
 * We map states to EIA’s diesel pricing regions (PADD subregions / regions),
 * plus special handling for CA and "West Coast excluding CA".
 *
 * Series IDs used are published by EIA (example list includes SCA and R5XCA). :contentReference[oaicite:2]{index=2}
 */
function stateToEiaDieselSeriesId(stateCode) {
  const s = (stateCode || '').toUpperCase();

  // Special
  if (s === 'CA') return 'PET.EMD_EPD2D_PTE_SCA_DPG.W';

  // West Coast excluding CA
  const westNoCA = new Set(['AK','AZ','HI','NV','OR','WA']);
  if (westNoCA.has(s)) return 'PET.EMD_EPD2D_PTE_R5XCA_DPG.W';

  // Rocky Mountain (R40)
  const rocky = new Set(['CO','ID','MT','UT','WY','NM']);
  if (rocky.has(s)) return 'PET.EMD_EPD2D_PTE_R40_DPG.W';

  // Gulf Coast (R30)
  const gulf = new Set(['AL','AR','LA','MS','OK','TX']);
  if (gulf.has(s)) return 'PET.EMD_EPD2D_PTE_R30_DPG.W';

  // Midwest (R20)
  const midwest = new Set(['IL','IN','IA','KS','KY','MI','MN','MO','NE','ND','OH','SD','TN','WI']);
  if (midwest.has(s)) return 'PET.EMD_EPD2D_PTE_R20_DPG.W';

  // East Coast split
  const newEngland = new Set(['CT','ME','MA','NH','RI','VT']);
  if (newEngland.has(s)) return 'PET.EMD_EPD2D_PTE_R1X_DPG.W';

  const centralAtlantic = new Set(['DE','DC','MD','NJ','NY','PA']);
  if (centralAtlantic.has(s)) return 'PET.EMD_EPD2D_PTE_R1Y_DPG.W';

  const lowerAtlantic = new Set(['FL','GA','NC','SC','VA','WV']);
  if (lowerAtlantic.has(s)) return 'PET.EMD_EPD2D_PTE_R1Z_DPG.W';

  // Fallback to U.S. average
  return 'PET.EMD_EPD2D_PTE_NUS_DPG.W';
}

// --- Save a load ---
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