import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

export function openDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "chat-director.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      premise TEXT NOT NULL DEFAULT '',
      visual_style TEXT NOT NULL DEFAULT '',
      characters_json TEXT NOT NULL DEFAULT '[]',
      boundaries_json TEXT NOT NULL,
      limits_json TEXT NOT NULL,
      youtube_json TEXT NOT NULL,
      hold INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      demo_auto_director INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      started_at TEXT,
      stopped_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      published_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      flagged INTEGER NOT NULL DEFAULT 0,
      flagged_term TEXT,
      used_by_job_id TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS story_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      scene_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS scene_summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      scene_index INTEGER NOT NULL,
      summary TEXT NOT NULL,
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      proposal_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      supporting_ids_json TEXT NOT NULL,
      progression_json TEXT NOT NULL,
      provider_job_id TEXT,
      provider_result_url TEXT,
      source_path TEXT,
      playback_path TEXT,
      last_frame_path TEXT,
      start_image_path TEXT,
      scene_index INTEGER,
      error TEXT,
      ambiguous INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS jobs_hash_idx
      ON jobs(session_id, proposal_hash);

    CREATE TABLE IF NOT EXISTS errors (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function metaGet(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function metaSet(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
