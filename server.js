const express = require('express');
const db = require('./db');

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

function buildGymData() {
  if (_cache) return _cache;

  const rows = db.prepare(`
    SELECT e.id, e.group_name, e.name, e.sets_raw, e.total_volume, e.max_weight, w.date
    FROM exercises e
    JOIN workouts w ON w.id = e.workout_id
    ORDER BY w.date ASC, e.id ASC
  `).all();

  // Pre-compute display dates and build a lookup map: "name\0date" → row
  const lookup = new Map();
  for (const row of rows) {
    row._display = isoToDisplay(row.date);
    lookup.set(row.name + '\0' + row._display, row);
  }

  // Build GYM_EX
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

  const gymEx = Array.from(exMap.values()).map(ex => ({
    ...ex,
    chartData: Object.keys(ex.sessions)
      .sort((a, b) => new Date(a) - new Date(b))
      .map(date => {
        const row = lookup.get(ex.name + '\0' + date);
        return { date, totalVol: ex.sessions[date].v, maxWeight: row?.max_weight || 0 };
      })
  }));

  // Build SUMMARY — group rows by date using a Map
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

  // Log entries
  const logRows = db.prepare(`
    SELECT e.id, e.group_name, e.name, e.sets_raw, w.date
    FROM exercises e JOIN workouts w ON w.id = e.workout_id
    ORDER BY e.id DESC LIMIT 200
  `).all();
  const logActivities = db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 100').all();

  const log = [
    ...logRows.map(r => ({ id: r.id, type: 'exercise', group: r.group_name, name: r.name, date: r.date, sets: r.sets_raw })),
    ...logActivities.map(a => ({ id: a.id, type: 'activity', activityName: a.activity_name, date: a.date, count: a.count }))
  ].sort((a, b) => b.id - a.id);

  _cache = { gymEx, summary, log };
  return _cache;
}

// ── routes ────────────────────────────────────────────────────────────────────

app.get('/api/data', (req, res) => res.json(buildGymData()));

app.post('/api/exercises', (req, res) => {
  const { date, groupName, name, setsRaw } = req.body;
  if (!date || !groupName || !name || !setsRaw) return res.status(400).json({ error: 'Missing fields' });
  const isoDate = date.includes('-') ? date : displayToIso(date);
  const { totalVol, maxWeight } = computeStats(setsRaw);
  let workout = db.prepare('SELECT id FROM workouts WHERE date = ?').get(isoDate);
  if (!workout) {
    const r = db.prepare('INSERT INTO workouts (date, name) VALUES (?, ?)').run(isoDate, groupName);
    workout = { id: r.lastInsertRowid };
  }
  const result = db.prepare(
    'INSERT INTO exercises (workout_id, group_name, name, sets_raw, total_volume, max_weight) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(workout.id, groupName, name, setsRaw, totalVol, maxWeight);
  invalidateCache();
  res.status(201).json({ id: result.lastInsertRowid });
});

app.put('/api/exercises/:id', (req, res) => {
  const { setsRaw } = req.body;
  if (!setsRaw) return res.status(400).json({ error: 'Missing setsRaw' });
  const { totalVol, maxWeight } = computeStats(setsRaw);
  const r = db.prepare('UPDATE exercises SET sets_raw=?, total_volume=?, max_weight=? WHERE id=?')
    .run(setsRaw, totalVol, maxWeight, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  invalidateCache();
  res.json({ updated: true });
});

app.delete('/api/exercises/:id', (req, res) => {
  const r = db.prepare('DELETE FROM exercises WHERE id=?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  invalidateCache();
  res.json({ deleted: true });
});

app.post('/api/activities', (req, res) => {
  const { date, activityName, count } = req.body;
  if (!date || !activityName) return res.status(400).json({ error: 'Missing fields' });
  const isoDate = date.includes('-') ? date : displayToIso(date);
  const result = db.prepare('INSERT INTO activity_log (date, activity_name, count) VALUES (?, ?, ?)')
    .run(isoDate, activityName, count || 1);
  invalidateCache();
  res.status(201).json({ id: result.lastInsertRowid });
});

app.delete('/api/activities/:id', (req, res) => {
  const r = db.prepare('DELETE FROM activity_log WHERE id=?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  invalidateCache();
  res.json({ deleted: true });
});

app.listen(PORT, () => console.log(`Gym Journal running at http://localhost:${PORT}`));
