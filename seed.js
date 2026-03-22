const { pool, initDB } = require('./db');
const fs = require('fs');

function parseCSV(content) {
  const rows = [];
  let i = 0;
  const n = content.length;
  while (i < n && content[i] !== '\n') i++;
  i++;
  while (i < n) {
    const row = [];
    while (i < n) {
      if (content[i] === '"') {
        i++;
        let field = '';
        while (i < n) {
          if (content[i] === '"' && content[i + 1] === '"') { field += '"'; i += 2; }
          else if (content[i] === '"') { i++; break; }
          else { field += content[i++]; }
        }
        row.push(field.trim());
      } else {
        let field = '';
        while (i < n && content[i] !== ',' && content[i] !== '\n' && content[i] !== '\r') {
          field += content[i++];
        }
        row.push(field.trim());
      }
      if (i < n && content[i] === ',') { i++; continue; }
      if (i < n && (content[i] === '\n' || content[i] === '\r')) {
        while (i < n && (content[i] === '\n' || content[i] === '\r')) i++;
        break;
      }
      break;
    }
    if (row.length >= 4) rows.push(row);
  }
  return rows;
}

function parseDate(dateStr) {
  // Parse without timezone conversion to avoid off-by-one day in UTC+ zones
  const m = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (m) {
    const months = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
    return `${m[3]}-${months[m[2]]}-${String(m[1]).padStart(2,'0')}`;
  }
  return dateStr;
}

function computeStats(setsRaw) {
  const lines = setsRaw.split('\n').filter(Boolean);
  let totalVol = 0, maxWeight = 0;
  for (const line of lines) {
    const m = line.match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+)/i);
    if (m) {
      const w = parseFloat(m[1]), r = parseInt(m[2]);
      totalVol += Math.round(w * r);
      maxWeight = Math.max(maxWeight, w);
    }
  }
  return { totalVol, maxWeight };
}

async function main() {
  await initDB();

  const existing = (await pool.query('SELECT COUNT(*) as count FROM workouts')).rows[0];
  if (parseInt(existing.count) > 0) {
    console.log(`Database already has ${existing.count} workouts, skipping seed.`);
    await pool.end();
    return;
  }

  const content = fs.readFileSync('./gym_journal_export.csv', 'utf-8');
  const rows = parseCSV(content);

  const byDate = {};
  for (const [date, group, exercise, setsStr] of rows) {
    const iso = parseDate(date);
    if (!byDate[iso]) byDate[iso] = { groups: new Set(), exercises: [] };
    byDate[iso].groups.add(group);
    byDate[iso].exercises.push({ name: exercise, group, sets_raw: setsStr });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let workoutCount = 0, exerciseCount = 0;
    for (const [date, data] of Object.entries(byDate).sort()) {
      const workoutName = [...data.groups].join(' + ');
      const wRes = await client.query(
        'INSERT INTO workouts (date, name) VALUES ($1, $2) RETURNING id',
        [date, workoutName]
      );
      const workoutId = wRes.rows[0].id;
      workoutCount++;
      for (const ex of data.exercises) {
        const { totalVol, maxWeight } = computeStats(ex.sets_raw);
        await client.query(
          'INSERT INTO exercises (workout_id, group_name, name, sets_raw, total_volume, max_weight) VALUES ($1, $2, $3, $4, $5, $6)',
          [workoutId, ex.group, ex.name, ex.sets_raw, totalVol, maxWeight]
        );
        exerciseCount++;
      }
    }
    await client.query('COMMIT');
    console.log(`Seeded ${workoutCount} workouts and ${exerciseCount} exercises.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
