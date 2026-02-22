import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import * as schema from "./schema.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type NeoDb = ReturnType<typeof createDb>;

export function createDb(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });

  runMigrations(db);

  return db;
}

function runMigrations(db: NeoDb) {
  db.run(sql`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    chat_type TEXT NOT NULL,
    chat_title TEXT,
    last_session_id TEXT,
    last_activity_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    user_id INTEGER,
    agent_type TEXT,
    session_id TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    num_turns INTEGER,
    telegram_message_id INTEGER,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    agent_type TEXT NOT NULL,
    status TEXT NOT NULL,
    total_cost_usd REAL DEFAULT 0,
    total_turns INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    chat_id INTEGER,
    user_id INTEGER,
    event_type TEXT NOT NULL,
    tool_name TEXT,
    tool_input TEXT,
    tool_output TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    cron_expression TEXT,
    next_run_at TEXT,
    last_run_at TEXT,
    prompt TEXT NOT NULL,
    agent_type TEXT DEFAULT 'general',
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS cost_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    chat_id INTEGER,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    created_at TEXT NOT NULL
  )`);

  // Indexes
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_conversations_chat_id ON conversations(chat_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON sessions(chat_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_audit_log_session_id ON audit_log(session_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_audit_log_chat_id ON audit_log(chat_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_memories_chat_id ON memories(chat_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_cost_tracking_session_id ON cost_tracking(session_id)`);
}

export { schema };
