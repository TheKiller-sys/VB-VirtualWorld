// src/persistence/db.js
// Conexión SQLite con WAL, migraciones y utilidades.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('db');

let db = null;

export function getDb() {
  if (!db) throw new Error('DB no inicializada. Llama a initDb() primero.');
  return db;
}

export function initDb() {
  if (db) return db;

  const dbPath = path.resolve(env.worldDbPath);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // WAL para mejor concurrencia lectura/escritura
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -16000'); // ~16MB

  log.info(`DB abierta en ${dbPath}`);

  runMigrations(db);

  return db;
}

export function closeDb() {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_) {}
  db.close();
  db = null;
  log.info('DB cerrada');
}

// ============================================================
// Migraciones
// ============================================================

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const current = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version')
    .get().v;

  const migrations = [
    {
      version: 1,
      up: () => {
        database.exec(`
          CREATE TABLE IF NOT EXISTS entities (
            id TEXT PRIMARY KEY,
            is_simulated INTEGER NOT NULL DEFAULT 0,
            label TEXT,
            x REAL NOT NULL,
            y REAL NOT NULL,
            vx REAL NOT NULL DEFAULT 0,
            vy REAL NOT NULL DEFAULT 0,
            turn_count INTEGER NOT NULL DEFAULT 0,
            sentiment REAL NOT NULL DEFAULT 0,
            intensity REAL NOT NULL DEFAULT 0.5,
            dominant_emotion TEXT NOT NULL DEFAULT 'neutral',
            dominant_intent TEXT NOT NULL DEFAULT 'charla',
            topics_json TEXT NOT NULL DEFAULT '[]',
            traits_json TEXT NOT NULL DEFAULT '{}',
            born_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            last_updated_at INTEGER NOT NULL,
            interaction_count INTEGER NOT NULL DEFAULT 0,
            dead INTEGER NOT NULL DEFAULT 0
          );

          CREATE INDEX IF NOT EXISTS idx_entities_dead ON entities(dead);
          CREATE INDEX IF NOT EXISTS idx_entities_last_seen ON entities(last_seen_at);
          CREATE INDEX IF NOT EXISTS idx_entities_simulated ON entities(is_simulated);

          CREATE TABLE IF NOT EXISTS relationships (
            a TEXT NOT NULL,
            b TEXT NOT NULL,
            strength REAL NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (a, b),
            FOREIGN KEY (a) REFERENCES entities(id) ON DELETE CASCADE,
            FOREIGN KEY (b) REFERENCES entities(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_rel_strength ON relationships(strength);

          CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
          CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

          CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tick INTEGER NOT NULL,
            entity_count INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_snapshots_created ON snapshots(created_at);
        `);
      },
    },
    {
      version: 2,
      up: () => {
        // Reservado para futuras migraciones
      },
    },
  ];

  const pending = migrations.filter(m => m.version > current);
  if (pending.length === 0) {
    log.debug(`Schema en versión ${current}`);
    return;
  }

  const insertVersion = database.prepare(
    'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)'
  );

  const tx = database.transaction(() => {
    for (const m of pending) {
      log.info(`Aplicando migración v${m.version}`);
      m.up();
      insertVersion.run(m.version, Date.now());
    }
  });

  tx();
  log.info(`Migraciones aplicadas: ${pending.length}`);
}

// ============================================================
// Utilidades
// ============================================================

export function isDbReady() {
  return db !== null;
}
