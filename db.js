const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'gym_journal.db'));

// Drop and recreate tables if schema is outdated (detected by missing total_volume column)
const existingCols = db.prepare("PRAGMA table_info(exercises)").all().map(c => c.name);
if (existingCols.length && !existingCols.includes('total_volume')) {
  db.exec(`DROP TABLE IF EXISTS exercises; DROP TABLE IF EXISTS workouts; DROP TABLE IF EXISTS activity_log;`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS workouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id INTEGER NOT NULL,
    group_name TEXT NOT NULL,
    name TEXT NOT NULL,
    sets_raw TEXT NOT NULL,
    total_volume REAL DEFAULT 0,
    max_weight REAL DEFAULT 0,
    FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    activity_name TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
