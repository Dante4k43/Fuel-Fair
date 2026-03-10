/**
 * Fuel Fair server.js
 * - Static frontend from /public
 * - Nominatim proxy endpoints (fix browser CORS)
 * - OSRM proxy endpoint (fix browser CORS)
 * - Profit calc endpoint
 * - EIA avg diesel endpoint (API v2 /seriesid)
 * - Auth (sessions + signup/signin/me/change-password)
 * - Save load + Loads list (NOW protected: login required)
 * - Preferences (truck_settings keyed by user_id)
 *
 * ENV:
 * - EIA_API_KEY (required for /api/gas/average)
 * - DATABASE_URL (used in db.js)
 * - NOMINATIM_UA (optional; recommended)
 * - SESSION_SECRET (required in production)
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

const pool = require('./db');

app.use(express.json());
app.use(express.static('public'));

app.set('trust proxy', 1);

app.use(
  session({
    store: new pgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
    },
  })
);

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'not_authenticated' });
  next();
}

async function requireAdmin(req, res, next) {
  try {
    if (!req.session?.userId) return res.status(401).json({ error: 'not_authenticated' });

    const r = await pool.query(`SELECT is_admin FROM users WHERE id = $1`, [req.session.userId]);
    if (!r.rows.length) return res.status(401).json({ error: 'user_not_found' });

    if (!r.rows[0].is_admin) return res.status(403).json({ error: 'not_authorized' });

    next();
  } catch (err) {
    console.error('requireAdmin error:', err);
    res.status(500).json({ error: 'server_error' });
  }
}

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

/* ------------------------------- OSRM Proxy ------------------------------- */

app.get('/api/osrm/route', async (req, res) => {
  try {
    const { fromLon, fromLat, toLon, toLat } = req.query;

    if (![fromLon, fromLat, toLon, toLat].every(v => v != null)) {
      return res.status(400).json({ error: 'fromLon, fromLat, toLon, toLat required' });
    }

    const simple = req.query.simple === '1';

    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${encodeURIComponent(fromLon)},${encodeURIComponent(fromLat)};` +
      `${encodeURIComponent(toLon)},${encodeURIComponent(toLat)}` +
      (simple
        ? `?overview=false&steps=false&annotations=false`
        : `?overview=full&geometries=geojson`);

    const r = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 30000);

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({
        error: 'osrm route failed',
        upstreamStatus: r.status,
        upstreamBody: text.slice(0, 300),
      });
    }

    const data = await r.json();
    return res.json(data);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.toLowerCase().includes('aborted')) {
      return res.status(504).json({
        error: 'osrm route timeout',
        message: 'OSRM took too long (increase timeout or try again).',
      });
    }
    return res.status(502).json({ error: 'osrm route exception', message: msg });
  }
});

/* ----------------------------- Nominatim Proxy ---------------------------- */

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
          Referer: 'http://localhost:3000/',
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
          Referer: 'http://localhost:3000/',
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
  const { points = [], fuelType = 'diesel', routeMiles} = req.body;
  const kind = fuelType === 'gas' ? 'gas' : 'diesel';

  const sliced = Array.isArray(points) ? points.slice(0, 12) : [];
  if (sliced.length < 2) {
    return res.json({ avgFuelPrice: null, samples: [], error: 'not_enough_points' });
  }

  const cache = fuelCaches?.[kind];
  if (!cache?.ready) {
    return res.json({ avgFuelPrice: null, samples: [], error: `${kind}_cache_warming` });
  }

  try {
    // 1) Compute miles per SERIES ID using segment midpoints
    const milesBySeries = new Map(); // seriesId -> miles
    const stateBySeries = new Map(); // seriesId -> Set(states) (optional debug)

    for (let i = 0; i < sliced.length - 1; i++) {
      const a = sliced[i];
      const b = sliced[i + 1];

      const lat1 = Number(a.lat), lon1 = Number(a.lon);
      const lat2 = Number(b.lat), lon2 = Number(b.lon);
      if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) continue;

      const segMiles = haversineMiles(lat1, lon1, lat2, lon2);
      if (!Number.isFinite(segMiles) || segMiles <= 0) continue;

      // midpoint -> state
      const midLat = (lat1 + lat2) / 2;
      const midLon = (lon1 + lon2) / 2;

      const st = await reverseGeocodeStateCode(midLat, midLon);
      if (!st) continue;

      const sid = stateToSeriesIdForFuel(st, kind);

      milesBySeries.set(sid, (milesBySeries.get(sid) || 0) + segMiles);

      if (!stateBySeries.has(sid)) stateBySeries.set(sid, new Set());
      stateBySeries.get(sid).add(st);
    }

    if (milesBySeries.size === 0) {
      return res.json({ avgFuelPrice: null, samples: [], error: 'no_miles_bucketed' });
    }

    // --- Scale haversine segment miles to match OSRM route miles (production accuracy) ---
    let haversineTotal = 0;
    for (const m of milesBySeries.values()) haversineTotal += m;

    const osrmMiles = Number(routeMiles);
    const canScale =
      Number.isFinite(osrmMiles) && osrmMiles > 0 &&
      Number.isFinite(haversineTotal) && haversineTotal > 0;

    const scale = canScale ? (osrmMiles / haversineTotal) : 1;

    if (scale !== 1) {
      for (const [sid, m] of milesBySeries.entries()) {
        milesBySeries.set(sid, m * scale);
      }
    }

    // 2) Weighted average using PREWARMED cache values
    let totalMiles = 0;
    let weightedSum = 0;

    const samples = [];
    const missingSeries = [];

    for (const [sid, miles] of milesBySeries.entries()) {
      const cached = cache.map.get(sid);
      const price = cached?.value;

      if (!Number.isFinite(price)) {
        missingSeries.push(sid);
        continue;
      }

      samples.push({
        seriesId: sid,
        miles: Number(miles.toFixed(2)),
        price,
        cached: true,
        ts: cached.ts,
        // optional: which states ended up mapping into this series
        states: [...(stateBySeries.get(sid) || new Set())]
      });

      weightedSum += price * miles;
      totalMiles += miles;
    }

    // No fallback: if anything required is missing, fail fast
    if (!totalMiles) {
      return res.json({
        avgFuelPrice: null,
        samples,
        error: 'missing_series',
        missingSeries
      });
    }

    const avgFuelPrice = weightedSum / totalMiles;

    const totalMilesOut =
    Number.isFinite(osrmMiles) && osrmMiles > 0
      ? Number(osrmMiles.toFixed(2))
      : Number(totalMiles.toFixed(2));

    return res.json({
      avgFuelPrice,
      fuelType: kind,
      totalMiles: totalMilesOut,
      scaleApplied: canScale ? Number(scale.toFixed(4)) : null,
      samples
    });
  } catch (err) {
    console.error('gas/average weighted error:', err);
    return res.json({ avgFuelPrice: null, error: err.message });
  }
});
/* ------------------------------- EIA Helpers ------------------------------ */

const eiaCache = new Map(); // seriesId -> { value, ts }

async function getLatestEiaSeriesValue(apiKey, seriesId) {
  try {
    const cached = eiaCache.get(seriesId);
    const now = Date.now();
    if (cached && (now - cached.ts) < 6 * 60 * 60 * 1000) return cached.value;

    const url = `https://api.eia.gov/v2/seriesid/${encodeURIComponent(seriesId)}?api_key=${encodeURIComponent(apiKey)}`;

    console.log('[EIA] fetching', seriesId);

    const r = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 45000);

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.log('[EIA] non-OK', r.status, seriesId, body.slice(0, 200));
      return NaN;
    }

    const data = await r.json().catch(() => null);

    console.log('[EIA] parsed', seriesId, {
      hasResponse: !!data?.response,
      first: data?.response?.data?.[0]
        ? { period: data.response.data[0].period, value: data.response.data[0].value }
        : null
    });

    const latest = data?.response?.data?.[0];
    const value = latest ? Number(latest.value) : NaN;

    if (Number.isFinite(value)) eiaCache.set(seriesId, { value, ts: now });
    return value;
  } catch (err) {
    // THIS is what you’re missing right now
    console.error('[EIA] exception', seriesId, err?.message || err);
    return NaN;
  }
}

const fuelCaches = {
  diesel: { ready: false, map: new Map() },   // seriesId -> { value, ts }
  gas:    { ready: false, map: new Map() }
};

const DIESEL_SERIES = [
  'PET.EMD_EPD2D_PTE_R30_DPG.W',
  'PET.EMD_EPD2D_PTE_R20_DPG.W',
  'PET.EMD_EPD2D_PTE_R1Z_DPG.W',
  'PET.EMD_EPD2D_PTE_R1Y_DPG.W',
  'PET.EMD_EPD2D_PTE_R5XCA_DPG.W',
  'PET.EMD_EPD2D_PTE_R40_DPG.W',
  'PET.EMD_EPD2D_PTE_SCA_DPG.W',
  'PET.EMD_EPD2D_PTE_NUS_DPG.W'
];

const GAS_SERIES = [
  'PET.EMM_EPMR_PTE_R30_DPG.W',
  'PET.EMM_EPMR_PTE_R20_DPG.W',
  'PET.EMM_EPMR_PTE_R1Z_DPG.W',
  'PET.EMM_EPMR_PTE_R1Y_DPG.W',
  'PET.EMM_EPMR_PTE_R5XCA_DPG.W',
  'PET.EMM_EPMR_PTE_R40_DPG.W',
  'PET.EMM_EPMR_PTE_SCA_DPG.W',
  'PET.EMM_EPMR_PTE_NUS_DPG.W'
];

async function warmFuelCache(kind) {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    console.log(`[fuel-cache] no EIA_API_KEY, cannot warm (${kind})`);
    return;
  }

  const seriesList = kind === 'gas' ? GAS_SERIES : DIESEL_SERIES;
  const cache = fuelCaches[kind];

  console.log(`[fuel-cache] warming ${kind}...`);
  cache.ready = false;

  for (const sid of seriesList) {
    try {
      const url = `https://api.eia.gov/v2/seriesid/${encodeURIComponent(sid)}?api_key=${encodeURIComponent(apiKey)}`;
      const r = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 90000);

      if (!r.ok) {
        console.log(`[fuel-cache] non-OK ${kind}`, r.status, sid);
        continue;
      }

      const data = await r.json().catch(() => null);
      const latest = data?.response?.data?.[0];
      const value = latest ? Number(latest.value) : NaN;

      if (Number.isFinite(value)) {
        cache.map.set(sid, { value, ts: Date.now() });
        console.log(`[fuel-cache] set ${kind}`, sid, value);
      }
    } catch (e) {
      console.log(`[fuel-cache] error ${kind}`, sid, e.message);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  cache.ready = cache.map.size >= 3;
  console.log(`[fuel-cache] ready ${kind}?`, cache.ready, 'count=', cache.map.size);
}

// warm on startup
setTimeout(() => { warmFuelCache('diesel'); warmFuelCache('gas'); }, 1000);

// refresh every 6 hours
setInterval(() => { warmFuelCache('diesel'); warmFuelCache('gas'); }, 6 * 60 * 60 * 1000);

async function reverseGeocodeStateCode(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const url = `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&zoom=5&lat=${lat}&lon=${lon}`;

  const r = await fetchWithTimeout(
    url,
    { headers: { Accept: 'application/json', 'User-Agent': NOMINATIM_UA } },
    6000
  );

  if (!r.ok) return null;

  const data = await r.json().catch(() => null);
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
    const normalized = rawState
      .toLowerCase()
      .replace(/^state of\s+/, '')
      .replace(/^commonwealth of\s+/, '')
      .trim();

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

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.7613; // miles
  const toRad = d => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

// Your existing mapper returns DIESEL series IDs.
// This converts to GAS series IDs when needed.
function stateToSeriesIdForFuel(stateCode, fuelType) {
  let sid = stateToEiaDieselSeriesId(stateCode); // returns PET.EMD_EPD2D...
  if ((fuelType || 'diesel') === 'gas') {
    sid = sid.replace('PET.EMD_EPD2D', 'PET.EMM_EPMR'); // GAS equivalent
  }
  return sid;
}

/* ------------------------------- Auth Routes ------------------------------ */

app.post('/api/auth/signup', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';

    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
    if (password.length < 8) return res.status(400).json({ error: 'password_too_short' });

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email`,
      [email, hash]
    );

    req.session.userId = result.rows[0].id;
    return res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (String(err.message).toLowerCase().includes('duplicate')) {
      return res.status(409).json({ error: 'email_already_exists' });
    }
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';

    const userRes = await pool.query(
      `SELECT id, email, password_hash FROM users WHERE LOWER(email)=LOWER($1)`,
      [email]
    );

    const user = userRes.rows[0];
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    req.session.userId = user.id;
    return res.json({ success: true, user: { id: user.id, email: user.email } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/signout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session?.userId) return res.json({ user: null });

  const r = await pool.query(
    `SELECT id, email, created_at, is_admin FROM users WHERE id = $1`,
    [req.session.userId]
  );

  return res.json({ user: r.rows[0] || null });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const currentPassword = req.body?.currentPassword || '';
    const newPassword = req.body?.newPassword || '';

    if (newPassword.length < 8) return res.status(400).json({ error: 'password_too_short' });

    const r = await pool.query(`SELECT password_hash FROM users WHERE id=$1`, [req.session.userId]);
    const ok = await bcrypt.compare(currentPassword, r.rows[0]?.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'wrong_password' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [newHash, req.session.userId]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------ Preferences ------------------------------ */
/* truck_settings is now per-user via truck_settings.user_id UNIQUE */

app.get('/api/preferences', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT truck_type, fuel_type, fair_load_score_threshold, default_mpg, target_net_per_mile
       FROM truck_settings
       WHERE user_id = $1`,
      [req.session.userId]
    );

    if (!r.rows.length) {
      return res.json({
        truck_type: '',
        fuel_type: '',
        fair_load_score_threshold: 75,
        default_mpg: 6.5,
        target_net_per_mile: 2.0
      });
    }

    return res.json(r.rows[0]);
  } catch (err) {
    console.error('GET PREFS ERROR:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/preferences', requireAuth, async (req, res) => {
  try {
    const truck_type = (req.body?.truck_type ?? '').toString();
    const fuel_type = (req.body?.fuel_type ?? '').toString();

    const fair_load_score_threshold = Number.isFinite(Number(req.body?.fair_load_score_threshold))
      ? Number(req.body.fair_load_score_threshold)
      : 75;

    const default_mpg = Number.isFinite(Number(req.body?.default_mpg))
      ? Number(req.body.default_mpg)
      : 6.5;

    const target_net_per_mile = Number.isFinite(Number(req.body?.target_net_per_mile))
      ? Number(req.body.target_net_per_mile)
      : 2.0;

    const result = await pool.query(
      `
      INSERT INTO truck_settings
        (user_id, truck_type, fuel_type, fair_load_score_threshold, default_mpg, target_net_per_mile)
      VALUES
        ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id)
      DO UPDATE SET
        truck_type = EXCLUDED.truck_type,
        fuel_type = EXCLUDED.fuel_type,
        fair_load_score_threshold = EXCLUDED.fair_load_score_threshold,
        default_mpg = EXCLUDED.default_mpg,
        target_net_per_mile = EXCLUDED.target_net_per_mile
      RETURNING truck_type, fuel_type, fair_load_score_threshold, default_mpg, target_net_per_mile
      `,
      [
        req.session.userId,
        truck_type || null,
        fuel_type || null,
        fair_load_score_threshold,
        default_mpg,
        target_net_per_mile
      ]
    );

    return res.json({ success: true, preferences: result.rows[0] });
  } catch (err) {
    console.error('SAVE PREFS ERROR:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* ------------------------------ Save a Load ------------------------------- */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/api/admin/exports/loads.csv', requireAdmin, async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const params = [];
    let where = 'WHERE 1=1';

    if (from && !Number.isNaN(from.getTime())) {
      params.push(from);
      where += ` AND l.created_at >= $${params.length}`;
    }
    if (to && !Number.isNaN(to.getTime())) {
      // include end-of-day for a date input (optional nice touch)
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      params.push(end);
      where += ` AND l.created_at <= $${params.length}`;
    }

    const result = await pool.query(
      `
      SELECT
        l.id,
        u.email AS user_email,
        ts.truck_type,
        ts.fuel_type,
        l.decision,
        l.origin,
        l.destination,
        l.rate,
        l.miles,
        l.fuel_cost,
        l.net_profit,
        l.net_per_mile,
        l.avg_gas_price,
        l.created_at
      FROM loads l
      LEFT JOIN users u ON u.id = l.user_id
      LEFT JOIN truck_settings ts ON ts.user_id = l.user_id
      ${where}
      ORDER BY l.created_at DESC
      `,
      params
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fuel-fair-loads-export.csv"');
    res.setHeader('Cache-Control', 'no-store');

    const header = [
      'load_id','user_email','truck_type','fuel_type','decision',
      'origin','destination','rate','miles','fuel_cost','net_profit',
      'net_per_mile','avg_gas_price','created_at'
    ].join(',') + '\n';

    let csv = header;

    for (const row of result.rows) {
      csv += [
        csvEscape(row.id),
        csvEscape(row.user_email),
        csvEscape(row.truck_type),
        csvEscape(row.fuel_type),
        csvEscape(row.decision),
        csvEscape(row.origin),
        csvEscape(row.destination),
        csvEscape(row.rate),
        csvEscape(row.miles),
        csvEscape(row.fuel_cost),
        csvEscape(row.net_profit),
        csvEscape(row.net_per_mile),
        csvEscape(row.avg_gas_price),
        csvEscape(row.created_at),
      ].join(',') + '\n';
    }

    res.status(200).send(csv);
  } catch (err) {
    console.error('ADMIN EXPORT ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'admin.html'));
});

app.post('/api/save-load', async (req, res) => {
  const {
    decision,
    analysisId, // ✅ add if you implemented Step 3
    origin,
    destination,
    rate,
    miles,
    fuelCost,
    netRevenue,
    netPerMile,
    avgGasPrice
  } = req.body || {};

  try {
    // logged in? attach user_id
    const userId = req.session?.userId ?? null;

    // not logged in? attach anon_id (stored in session)
    if (!userId) {
      if (!req.session.anonId) {
        req.session.anonId = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
      }
    }
    const anonId = userId ? null : (req.session?.anonId ?? null);

    const result = await pool.query(
      `
      INSERT INTO loads
        (user_id, anon_id, analysis_id, decision, origin, destination,
         rate, miles,
         fuel_cost, net_profit, net_per_mile,
         avg_gas_price, fuel_price)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT DO NOTHING
      RETURNING id, created_at
      `,
      [
        userId,
        anonId,
        analysisId ?? null,
        decision ?? null,
        origin ?? null,
        destination ?? null,
        rate == null ? null : Number(rate),
        miles == null ? null : Number(miles),
        fuelCost == null ? null : Number(fuelCost),
        netRevenue == null ? null : Number(netRevenue),
        netPerMile == null ? null : Number(netPerMile),
        avgGasPrice == null ? null : Number(avgGasPrice),
        avgGasPrice == null ? null : Number(avgGasPrice),
      ]
    );

    if (!result.rows.length) {
      return res.json({ success: true, duplicate: true });
    }

    return res.json({ success: true, load: result.rows[0] });
  } catch (err) {
    console.error('SAVE LOAD ERROR:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});
/* ------------------------------ Loads Listing ----------------------------- */
/* ✅ NOW per-user + still requires login */

app.get('/api/loads', requireAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 8, 50);
    const offset = (page - 1) * limit;

    // ✅ users should only see accepted loads
    const totalResult = await pool.query(
      `SELECT COUNT(*) FROM loads WHERE user_id = $1 AND decision = 'accepted'`,
      [req.session.userId]
    );
    const total = Number(totalResult.rows[0].count);

    const result = await pool.query(
      `
      SELECT id,
             decision,
             origin,
             destination,
             rate,
             miles,
             fuel_cost,
             net_profit,
             net_per_mile,
             avg_gas_price,
             created_at
      FROM loads
      WHERE user_id = $1 AND decision = 'accepted'
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [req.session.userId, limit, offset]
    );

    res.json({
      data: result.rows,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });

  } catch (err) {
    console.error('GET LOADS ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`Engine running at http://localhost:${port}`));