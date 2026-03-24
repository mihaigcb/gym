const express = require('express');
const { pool, initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ── helpers ───────────────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function isoToDisplay(iso) {
  const [y, m, d] = iso.split('-');
  return `${parseInt(d)} ${MONTHS[parseInt(m)-1]} ${y}`;
}

function displayToIso(display) {
  const d = new Date(display);
  if (isNaN(d)) return display;
  return d.toISOString().slice(0, 10);
}

function computeStats(setsRaw) {
  let totalVol = 0, maxWeight = 0;
  for (const line of setsRaw.split('\n')) {
    const m = line.match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+)/i);
    if (m) {
      const w = parseFloat(m[1]), r = parseInt(m[2]);
      totalVol += Math.round(w * r);
      if (w > maxWeight) maxWeight = w;
    }
  }
  return { totalVol, maxWeight };
}

function formatSetsRaw(setsRaw) {
  return setsRaw.split('\n').filter(Boolean).map(l => {
    const m = l.match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+)/i);
    if (m) return `${m[1]}x${m[2]} (${Math.round(parseFloat(m[1])*parseInt(m[2]))}kg)`;
    return l;
  }).join('\n');
}

const GROUP_COLORS = {
  'Chest': '#f472b6', 'Back': '#60a5fa', 'Shoulders': '#fbbf24',
  'Triceps': '#a78bfa', 'Biceps': '#34d399',
  'Legs (upper)': '#f87171', 'Legs (lower)': '#fb923c'
};
const GROUPS = Object.keys(GROUP_COLORS);

// ── cache ─────────────────────────────────────────────────────────────────────

let _cache = null;
function invalidateCache() { _cache = null; }

// ── build data ────────────────────────────────────────────────────────────────

async function buildGymData() {
  if (_cache) return _cache;

  const { rows } = await pool.query(`
    SELECT e.id, e.group_name, e.name, e.sets_raw, e.total_volume, e.max_weight, w.date
    FROM exercises e
    JOIN workouts w ON w.id = e.workout_id
    ORDER BY w.date ASC, e.id ASC
  `);

  const lookup = new Map();
  for (const row of rows) {
    row._display = isoToDisplay(row.date);
    lookup.set(row.name + '\0' + row._display, row);
  }

  const exMap = new Map();
  for (const row of rows) {
    if (!exMap.has(row.name)) {
      exMap.set(row.name, { name: row.name, group: row.group_name, sessions: {} });
    }
    exMap.get(row.name).sessions[row._display] = {
      d: formatSetsRaw(row.sets_raw),
      v: row.total_volume,
      _id: row.id
    };
  }

  // Merge in exercises defined via "New exercise" that have no logs yet
  const defRows = (await pool.query('SELECT group_name, name FROM exercise_definitions')).rows;
  for (const row of defRows) {
    if (!exMap.has(row.name)) {
      exMap.set(row.name, { name: row.name, group: row.group_name, sessions: {} });
    }
  }

  const gymEx = Array.from(exMap.values()).map(ex => ({
    ...ex,
    chartData: Object.keys(ex.sessions)
      .sort((a, b) => new Date(a) - new Date(b))
      .map(date => {
        const r = lookup.get(ex.name + '\0' + date);
        return { date, totalVol: ex.sessions[date].v, maxWeight: r?.max_weight || 0 };
      })
  }));

  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const sortedDates = [...byDate.keys()].sort();
  const displayDates = sortedDates.map(isoToDisplay);
  const sets = {}, vol = {};
  const totalSets = [], totalVol = [];
  for (const g of GROUPS) { sets[g] = []; vol[g] = []; }

  for (const date of sortedDates) {
    const dateRows = byDate.get(date);
    let dateTotal = 0, dateTotalVol = 0;
    for (const g of GROUPS) {
      let groupSets = 0, groupVol = 0;
      for (const r of dateRows) {
        if (r.group_name !== g) continue;
        groupSets += r.sets_raw.split('\n').filter(Boolean).length;
        groupVol += r.total_volume || 0;
      }
      sets[g].push(groupSets);
      vol[g].push(groupVol);
      dateTotal += groupSets;
      dateTotalVol += groupVol;
    }
    totalSets.push(dateTotal);
    totalVol.push(dateTotalVol);
  }

  const summary = { dates: displayDates, groups: GROUPS, groupColors: GROUP_COLORS, sets, vol, totalSets, totalVol };

  const logResult = await pool.query(`
    SELECT e.id, e.group_name, e.name, e.sets_raw, w.date
    FROM exercises e JOIN workouts w ON w.id = e.workout_id
    ORDER BY e.id DESC LIMIT 200
  `);
  const actResult = await pool.query('SELECT * FROM activity_log ORDER BY id DESC LIMIT 100');

  const log = [
    ...logResult.rows.map(r => ({ id: r.id, type: 'exercise', group: r.group_name, name: r.name, date: r.date, sets: r.sets_raw })),
    ...actResult.rows.map(a => ({ id: a.id, type: 'activity', activityName: a.activity_name, date: a.date, count: a.count }))
  ].sort((a, b) => b.id - a.id);

  _cache = { gymEx, summary, log };
  return _cache;
}

// ── routes ────────────────────────────────────────────────────────────────────

app.get('/api/data', async (req, res) => {
  try {
    res.json(await buildGymData());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/exercises/define', async (req, res) => {
  const { groupName, name } = req.body;
  if (!groupName || !name) return res.status(400).json({ error: 'Missing fields' });
  try {
    await pool.query(
      'INSERT INTO exercise_definitions (group_name, name) VALUES ($1, $2) ON CONFLICT (group_name, name) DO NOTHING',
      [groupName, name.trim()]
    );
    invalidateCache();
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/exercises', async (req, res) => {
  const { date, groupName, name, setsRaw } = req.body;
  if (!date || !groupName || !name || !setsRaw) return res.status(400).json({ error: 'Missing fields' });
  const isoDate = date.includes('-') ? date : displayToIso(date);
  const { totalVol, maxWeight } = computeStats(setsRaw);
  try {
    let workout = (await pool.query('SELECT id FROM workouts WHERE date = $1', [isoDate])).rows[0];
    if (!workout) {
      const r = await pool.query('INSERT INTO workouts (date, name) VALUES ($1, $2) RETURNING id', [isoDate, groupName]);
      workout = r.rows[0];
    }
    const result = await pool.query(
      'INSERT INTO exercises (workout_id, group_name, name, sets_raw, total_volume, max_weight) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [workout.id, groupName, name, setsRaw, totalVol, maxWeight]
    );
    invalidateCache();
    res.status(201).json({ id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/exercises/:id', async (req, res) => {
  const { setsRaw, date } = req.body;
  if (!setsRaw) return res.status(400).json({ error: 'Missing setsRaw' });
  const { totalVol, maxWeight } = computeStats(setsRaw);
  try {
    // If a new date is provided, move the exercise to the correct workout row
    if (date) {
      const isoDate = date.includes('-') ? date : displayToIso(date);
      // Get current exercise to know its group_name
      const exRow = (await pool.query('SELECT workout_id, group_name, name FROM exercises WHERE id=$1', [req.params.id])).rows[0];
      if (!exRow) return res.status(404).json({ error: 'Not found' });
      // Find or create workout for the new date
      let workout = (await pool.query('SELECT id FROM workouts WHERE date=$1', [isoDate])).rows[0];
      if (!workout) {
        const wr = await pool.query('INSERT INTO workouts (date, name) VALUES ($1, $2) RETURNING id', [isoDate, exRow.group_name]);
        workout = wr.rows[0];
      }
      await pool.query(
        'UPDATE exercises SET sets_raw=$1, total_volume=$2, max_weight=$3, workout_id=$4 WHERE id=$5',
        [setsRaw, totalVol, maxWeight, workout.id, req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE exercises SET sets_raw=$1, total_volume=$2, max_weight=$3 WHERE id=$4',
        [setsRaw, totalVol, maxWeight, req.params.id]
      );
    }
    invalidateCache();
    res.json({ updated: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/exercises/:id', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM exercises WHERE id=$1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    invalidateCache();
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/activities', async (req, res) => {
  const { date, activityName, count } = req.body;
  if (!date || !activityName) return res.status(400).json({ error: 'Missing fields' });
  const isoDate = date.includes('-') ? date : displayToIso(date);
  try {
    const result = await pool.query(
      'INSERT INTO activity_log (date, activity_name, count) VALUES ($1, $2, $3) RETURNING id',
      [isoDate, activityName, count || 1]
    );
    invalidateCache();
    res.status(201).json({ id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/activities/:id', async (req, res) => {
  const { date, activityName, count } = req.body;
  if (!date || !activityName) return res.status(400).json({ error: 'Missing fields' });
  const isoDate = date.includes('-') ? date : displayToIso(date);
  try {
    const r = await pool.query(
      'UPDATE activity_log SET date=$1, activity_name=$2, count=$3 WHERE id=$4',
      [isoDate, activityName, count || 1, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    invalidateCache();
    res.json({ updated: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/activities/:id', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM activity_log WHERE id=$1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    invalidateCache();
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WITHINGS ──────────────────────────────────────────────────────────────────

const WITHINGS_CLIENT_ID     = process.env.WITHINGS_CLIENT_ID;
const WITHINGS_CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET;
const WITHINGS_REDIRECT_URI  = process.env.WITHINGS_REDIRECT_URI ||
  'https://fulfilling-truth-production-71a1.up.railway.app/auth/withings/callback';

// Meastype codes: 1=weight, 6=fat%, 8=fat mass, 76=muscle mass, 88=bone mass
const WITHINGS_MEASTYPES = '1,6,8,76,88';

async function getWithingsToken() {
  const row = (await pool.query('SELECT * FROM withings_tokens LIMIT 1')).rows[0];
  if (!row) return null;
  // Refresh if expiring within 5 minutes
  if (row.expires_at - Math.floor(Date.now() / 1000) < 300) {
    const body = new URLSearchParams({
      action: 'requesttoken', grant_type: 'refresh_token',
      client_id: WITHINGS_CLIENT_ID, client_secret: WITHINGS_CLIENT_SECRET,
      refresh_token: row.refresh_token
    });
    const resp = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const data = await resp.json();
    if (data.status !== 0) return null;
    const { access_token, refresh_token, expires_in } = data.body;
    const expires_at = Math.floor(Date.now() / 1000) + expires_in;
    await pool.query(
      'UPDATE withings_tokens SET access_token=$1, refresh_token=$2, expires_at=$3 WHERE userid=$4',
      [access_token, refresh_token, expires_at, row.userid]
    );
    return access_token;
  }
  return row.access_token;
}

async function syncWithings() {
  const token = await getWithingsToken();
  if (!token) throw new Error('Not connected to Withings');
  const params = new URLSearchParams({
    action: 'getmeas', meastype: WITHINGS_MEASTYPES, category: '1'
  });
  const resp = await fetch('https://wbsapi.withings.net/measure?' + params, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await resp.json();
  if (data.status !== 0) throw new Error('Withings API error: ' + data.status);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const grp of data.body.measuregrps) {
      const date = new Date(grp.date * 1000).toISOString().slice(0, 10);
      const m = {};
      for (const measure of grp.measures) {
        m[measure.type] = +(measure.value * Math.pow(10, measure.unit)).toFixed(3);
      }
      await client.query(`
        INSERT INTO withings_measurements (date, weight, fat_ratio, fat_mass, muscle_mass, bone_mass)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (date) DO UPDATE SET
          weight      = COALESCE($2, withings_measurements.weight),
          fat_ratio   = COALESCE($3, withings_measurements.fat_ratio),
          fat_mass    = COALESCE($4, withings_measurements.fat_mass),
          muscle_mass = COALESCE($5, withings_measurements.muscle_mass),
          bone_mass   = COALESCE($6, withings_measurements.bone_mass)
      `, [date, m[1]||null, m[6]||null, m[8]||null, m[76]||null, m[88]||null]);
    }
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Start OAuth
app.get('/auth/withings', (req, res) => {
  if (!WITHINGS_CLIENT_ID) return res.status(500).send('WITHINGS_CLIENT_ID not set');
  const url = 'https://account.withings.com/oauth2_user/authorize2?' + new URLSearchParams({
    response_type: 'code', client_id: WITHINGS_CLIENT_ID,
    scope: 'user.metrics', redirect_uri: WITHINGS_REDIRECT_URI,
    state: Math.random().toString(36).slice(2)
  });
  res.redirect(url);
});

// OAuth callback
app.get('/auth/withings/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/#progress?withings=denied');
  try {
    const body = new URLSearchParams({
      action: 'requesttoken', grant_type: 'authorization_code',
      client_id: WITHINGS_CLIENT_ID, client_secret: WITHINGS_CLIENT_SECRET,
      code, redirect_uri: WITHINGS_REDIRECT_URI
    });
    const resp = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const data = await resp.json();
    if (data.status !== 0) throw new Error('Token exchange failed: ' + data.status);
    const { access_token, refresh_token, expires_in, userid } = data.body;
    const expires_at = Math.floor(Date.now() / 1000) + expires_in;
    await pool.query(`
      INSERT INTO withings_tokens (userid, access_token, refresh_token, expires_at)
      VALUES ($1,$2,$3,$4) ON CONFLICT (userid) DO UPDATE
      SET access_token=$2, refresh_token=$3, expires_at=$4
    `, [String(userid), access_token, refresh_token, expires_at]);
    await syncWithings();
    res.redirect('/#progress?withings=connected');
  } catch(e) {
    console.error('Withings callback error:', e.message);
    res.redirect('/#progress?withings=error');
  }
});

app.get('/api/withings/status', async (req, res) => {
  const row = (await pool.query('SELECT userid FROM withings_tokens LIMIT 1')).rows[0];
  res.json({ connected: !!row });
});

app.post('/api/withings/sync', async (req, res) => {
  try {
    await syncWithings();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/withings/disconnect', async (req, res) => {
  await pool.query('DELETE FROM withings_tokens');
  res.json({ disconnected: true });
});

app.get('/api/withings/measurements', async (req, res) => {
  try {
    const rows = (await pool.query(
      'SELECT date, weight, fat_ratio, fat_mass, muscle_mass, bone_mass FROM withings_measurements ORDER BY date ASC'
    )).rows;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`Gym Journal running at http://localhost:${PORT}`));
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
