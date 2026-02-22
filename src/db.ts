/**
 * SQLite database layer using bun:sqlite.
 * Single file at ~/.claude-agent/neo.db (configurable).
 * WAL mode for concurrent reads + atomic writes.
 */

import { Database as BunDB } from "bun:sqlite"
import { existsSync, mkdirSync } from "fs"
import { dirname } from "path"
import { logger } from "./logger"

export class Database {
  readonly db: BunDB

  constructor(dbPath: string) {
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      logger.info("Created database directory", { path: dir })
    }

    this.db = new BunDB(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.initSchema()

    logger.info("Database initialized", { path: dbPath })
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS telegram_sessions (
        chat_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    `)
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  upsertSession(sessionId: string): void {
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET updated_at = ?`,
      [sessionId, now, now, now]
    )
  }

  touchSession(sessionId: string): void {
    this.db.run("UPDATE sessions SET updated_at = ? WHERE session_id = ?", [
      new Date().toISOString(),
      sessionId,
    ])
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  insertMessage(
    sessionId: string,
    timestamp: string,
    prompt: string,
    response: string,
    durationMs: number,
    inputTokens: number,
    outputTokens: number
  ): void {
    this.db.run(
      `INSERT INTO messages (session_id, timestamp, prompt, response, duration_ms, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, timestamp, prompt, response, durationMs, inputTokens, outputTokens]
    )
    this.touchSession(sessionId)
  }

  getMessages(sessionId: string): Array<{
    timestamp: string
    prompt: string
    response: string
    duration_ms: number
    input_tokens: number
    output_tokens: number
  }> {
    return this.db
      .query(
        `SELECT timestamp, prompt, response, duration_ms, input_tokens, output_tokens
         FROM messages WHERE session_id = ? ORDER BY id ASC`
      )
      .all(sessionId) as Array<{
        timestamp: string
        prompt: string
        response: string
        duration_ms: number
        input_tokens: number
        output_tokens: number
      }>
  }

  getRecentMessages(sessionId: string, count: number): Array<{
    timestamp: string
    prompt: string
    response: string
    duration_ms: number
    input_tokens: number
    output_tokens: number
  }> {
    return this.db
      .query(
        `SELECT timestamp, prompt, response, duration_ms, input_tokens, output_tokens
         FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(sessionId, count)
      .reverse() as Array<{
        timestamp: string
        prompt: string
        response: string
        duration_ms: number
        input_tokens: number
        output_tokens: number
      }>
  }

  // ---------------------------------------------------------------------------
  // Session stats (computed via aggregates — single source of truth)
  // ---------------------------------------------------------------------------

  getSessionStats(sessionId: string): {
    totalMessages: number
    totalDurationMs: number
    totalInputTokens: number
    totalOutputTokens: number
  } | null {
    const row = this.db
      .query(
        `SELECT
           COUNT(*) as total_messages,
           COALESCE(SUM(duration_ms), 0) as total_duration_ms,
           COALESCE(SUM(input_tokens), 0) as total_input_tokens,
           COALESCE(SUM(output_tokens), 0) as total_output_tokens
         FROM messages WHERE session_id = ?`
      )
      .get(sessionId) as {
        total_messages: number
        total_duration_ms: number
        total_input_tokens: number
        total_output_tokens: number
      } | null

    if (!row || row.total_messages === 0) return null

    return {
      totalMessages: row.total_messages,
      totalDurationMs: row.total_duration_ms,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
    }
  }

  // ---------------------------------------------------------------------------
  // Session listing
  // ---------------------------------------------------------------------------

  listSessions(): Array<{
    sessionId: string
    createdAt: string
    messageCount: number
  }> {
    return (
      this.db
        .query(
          `SELECT s.session_id, s.created_at, COUNT(m.id) as message_count
           FROM sessions s
           LEFT JOIN messages m ON m.session_id = s.session_id
           GROUP BY s.session_id
           ORDER BY s.updated_at DESC`
        )
        .all() as Array<{
          session_id: string
          created_at: string
          message_count: number
        }>
    ).map((row) => ({
      sessionId: row.session_id,
      createdAt: row.created_at,
      messageCount: row.message_count,
    }))
  }

  getSession(sessionId: string): { session_id: string; created_at: string; updated_at: string } | null {
    return this.db
      .query("SELECT session_id, created_at, updated_at FROM sessions WHERE session_id = ?")
      .get(sessionId) as { session_id: string; created_at: string; updated_at: string } | null
  }

  /** Partial match — find sessions whose ID starts with the given prefix */
  findSessionByPrefix(prefix: string): string | null {
    const rows = this.db
      .query("SELECT session_id FROM sessions WHERE session_id LIKE ? LIMIT 2")
      .all(prefix + "%") as Array<{ session_id: string }>
    if (rows.length === 1) return rows[0].session_id
    return null
  }

  deleteSessionMessages(sessionId: string): void {
    this.db.run("DELETE FROM messages WHERE session_id = ?", [sessionId])
    this.db.run("DELETE FROM sessions WHERE session_id = ?", [sessionId])
  }

  // ---------------------------------------------------------------------------
  // Telegram sessions
  // ---------------------------------------------------------------------------

  getTelegramSession(chatId: number): string | undefined {
    const row = this.db
      .query("SELECT session_id FROM telegram_sessions WHERE chat_id = ?")
      .get(chatId) as { session_id: string } | null
    return row?.session_id
  }

  setTelegramSession(chatId: number, sessionId: string): void {
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO telegram_sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET session_id = ?, updated_at = ?`,
      [chatId, sessionId, now, sessionId, now]
    )
  }

  deleteTelegramSession(chatId: number): void {
    this.db.run("DELETE FROM telegram_sessions WHERE chat_id = ?", [chatId])
  }

  getAllTelegramSessions(): Array<{ chat_id: number; session_id: string }> {
    return this.db
      .query("SELECT chat_id, session_id FROM telegram_sessions")
      .all() as Array<{ chat_id: number; session_id: string }>
  }

  countTelegramSessions(): number {
    const row = this.db.query("SELECT COUNT(*) as count FROM telegram_sessions").get() as { count: number }
    return row.count
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close()
    logger.info("Database closed")
  }
}
