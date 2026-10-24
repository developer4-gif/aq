import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Opens (creating if needed) the database and applies pending sql/*.sql migrations in order, each in a transaction. */
export function openDb(file, sqlDir) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  migrate(db, sqlDir);
  return db;
}

export function migrate(db, sqlDir) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((r) => r.name));
  const files = fs.readdirSync(sqlDir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(sqlDir, f), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${f} failed: ${e.message}`);
    }
  }
}

/** Runs fn inside BEGIN IMMEDIATE..COMMIT (not re-entrant). */
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
}
