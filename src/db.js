import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS chunks (
        purpose TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        rows_json TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        rows_hash TEXT,
        bytes INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (purpose, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS cache_entries (
        purpose TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        fields_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        revision INTEGER NOT NULL,
        reusable INTEGER NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (purpose, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS invalidations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purpose TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        field TEXT NOT NULL,
        reason TEXT NOT NULL,
        field_epoch INTEGER NOT NULL,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        fence INTEGER NOT NULL,
        reuse_json TEXT,
        results_json TEXT,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS index_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purpose TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        docs_json TEXT,
        signature TEXT NOT NULL,
        revision INTEGER NOT NULL,
        job_id TEXT,
        fence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        published_at TEXT,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS exports (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        purpose TEXT,
        outcome TEXT NOT NULL,
        code TEXT,
        detail_json TEXT
      );
      CREATE TABLE IF NOT EXISTS tombstones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        purpose TEXT NOT NULL,
        field TEXT NOT NULL,
        field_epoch INTEGER NOT NULL,
        cleared_chunks INTEGER NOT NULL,
        cleared_index_versions INTEGER NOT NULL,
        note TEXT NOT NULL
      );
    `);
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const chunkCols = this.db.prepare('PRAGMA table_info(chunks)').all().map((c) => c.name);
    if (!chunkCols.includes('rows_hash')) this.db.exec('ALTER TABLE chunks ADD COLUMN rows_hash TEXT');
    const jobCols = this.db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
    if (!jobCols.includes('results_json')) this.db.exec('ALTER TABLE jobs ADD COLUMN results_json TEXT');
  }

  metaGet(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  metaSet(key, value) {
    this.db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  audit(action, purpose, outcome, code, detail) {
    this.db.prepare(
      'INSERT INTO audit (at, action, purpose, outcome, code, detail_json) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(new Date().toISOString(), action, purpose ?? null, outcome, code ?? null, JSON.stringify(detail ?? {}));
  }
}
