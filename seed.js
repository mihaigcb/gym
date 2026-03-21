const db = require('./db');
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

// "17 Mar 2025" → "2025-03-17"
function parseDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toISOString().slice(0, 10);
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

// Skip seeding if data already exists
const existing = db.prepare('SELECT COUNT(*) as count FROM workouts').get();
if (existing.count > 0) {
  console.log(`Database already has ${existing.count} workouts, skipping seed.`);
  process.exit(0);
}

const content = fs.readFileSync('./gym_journal_export.csv', 'utf-8');
const rows = parseCSV(content);

// Group by date
const byDate = {};
for (const [date, group, exercise, setsStr, , maxWeightCol] of rows) {
  const iso = parseDate(date);
  if (!byDate[iso]) byDate[iso] = { groups: new Set(), exercises: [] };
  byDate[iso].groups.add(group);
  byDate[iso].exercises.push({
    name: exercise,
    group,
    sets_raw: setsStr,  // keep original newline-separated format
  });
}

// Clear existing data
db.prepare('DELETE FROM exercises').run();
db.prepare('DELETE FROM workouts').run();
db.prepare('DELETE FROM activity_log').run();
try { db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('workouts','exercises','activity_log')").run(); } catch(e) {}

const insertWorkout = db.prepare('INSERT INTO workouts (date, name) VALUES (?, ?)');
const insertExercise = db.prepare(
  'INSERT INTO exercises (workout_id, group_name, name, sets_raw, total_volume, max_weight) VALUES (?, ?, ?, ?, ?, ?)'
);

let workoutCount = 0, exerciseCount = 0;

const insertAll = db.transaction(() => {
  for (const [date, data] of Object.entries(byDate).sort()) {
    const workoutName = [...data.groups].join(' + ');
    const result = insertWorkout.run(date, workoutName);
    const workoutId = result.lastInsertRowid;
    workoutCount++;

    for (const ex of data.exercises) {
      const { totalVol, maxWeight } = computeStats(ex.sets_raw);
      insertExercise.run(workoutId, ex.group, ex.name, ex.sets_raw, totalVol, maxWeight);
      exerciseCount++;
    }
  }
});

insertAll();
console.log(`Seeded ${workoutCount} workouts and ${exerciseCount} exercises.`);
