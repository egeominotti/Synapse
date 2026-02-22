/**
 * Core database layer: schema, sessions, messages, attachments, stats.
 * Extended by Database which adds Telegram sessions, runtime config, scheduled jobs.
 */

import { Database as BunDB } from "bun:sqlite"
import { existsSync, mkdirSync } from "fs"
import { dirname } from "path"
import { logger } from "./logger"

export class DatabaseCore {
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

      CREATE TABLE IF NOT EXISTS runtime_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        media_type TEXT NOT NULL,
        file_id TEXT,
        data BLOB NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL CHECK(schedule_type IN ('once', 'recurring', 'delay')),
        run_at TEXT NOT NULL,
        interval_ms INTEGER,
        created_at TEXT NOT NULL,
        last_run_at TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_telegram_sessions_session ON telegram_sessions(session_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_active ON scheduled_jobs(active, run_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_chat ON scheduled_jobs(chat_id);
    `)

    // Migration: add chat_id column to sessions (idempotent)
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN chat_id INTEGER")
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON sessions(chat_id)")
    } catch {
      // Column already exists — ignore
    }
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  upsertSession(sessionId: string, chatId?: number): void {
    const now = new Date().toISOString()
    if (chatId !== undefined) {
      this.db.run(
        `INSERT INTO sessions (session_id, created_at, updated_at, chat_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET updated_at = ?, chat_id = COALESCE(?, chat_id)`,
        [sessionId, now, now, chatId, now, chatId]
      )
    } else {
      this.db.run(
        `INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET updated_at = ?`,
        [sessionId, now, now, now]
      )
    }
  }

  touchSession(sessionId: string): void {
    this.db.run("UPDATE sessions SET updated_at = ? WHERE session_id = ?", [new Date().toISOString(), sessionId])
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
  ): number {
    this.db.run(
      `INSERT INTO messages (session_id, timestamp, prompt, response, duration_ms, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, timestamp, prompt, response, durationMs, inputTokens, outputTokens]
    )
    this.touchSession(sessionId)
    const row = this.db.query("SELECT last_insert_rowid() as id").get() as { id: number }
    return row.id
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

  getRecentMessages(
    sessionId: string,
    count: number
  ): Array<{
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

  /** Get recent messages across ALL sessions for a given chat (for memory injection). */
  getRecentMessagesByChatId(
    chatId: number,
    limit: number
  ): Array<{ prompt: string; response: string; timestamp: string }> {
    return this.db
      .query(
        `SELECT m.prompt, m.response, m.timestamp
         FROM messages m
         JOIN sessions s ON m.session_id = s.session_id
         WHERE s.chat_id = ?
         ORDER BY m.id DESC
         LIMIT ?`
      )
      .all(chatId, limit)
      .reverse() as Array<{ prompt: string; response: string; timestamp: string }>
  }

  // ---------------------------------------------------------------------------
  // Session stats
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

  /** Aggregate stats across ALL sessions (global). */
  getAllStats(): {
    totalMessages: number
    totalDurationMs: number
    totalInputTokens: number
    totalOutputTokens: number
    totalSessions: number
  } | null {
    const row = this.db
      .query(
        `SELECT
           COUNT(*) as total_messages,
           COALESCE(SUM(duration_ms), 0) as total_duration_ms,
           COALESCE(SUM(input_tokens), 0) as total_input_tokens,
           COALESCE(SUM(output_tokens), 0) as total_output_tokens,
           COUNT(DISTINCT session_id) as total_sessions
         FROM messages`
      )
      .get() as {
      total_messages: number
      total_duration_ms: number
      total_input_tokens: number
      total_output_tokens: number
      total_sessions: number
    } | null

    if (!row || row.total_messages === 0) return null

    return {
      totalMessages: row.total_messages,
      totalDurationMs: row.total_duration_ms,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalSessions: row.total_sessions,
    }
  }

  // ---------------------------------------------------------------------------
  // Session listing
  // ---------------------------------------------------------------------------

  listSessions(limit = 100): Array<{
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
           ORDER BY s.updated_at DESC
           LIMIT ?`
        )
        .all(limit) as Array<{
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
  // Attachments
  // ---------------------------------------------------------------------------

  insertAttachment(messageId: number, mediaType: string, data: Buffer, fileId?: string): void {
    this.db.run(
      `INSERT INTO attachments (message_id, media_type, file_id, data, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [messageId, mediaType, fileId ?? null, new Uint8Array(data), new Date().toISOString()]
    )
  }

  getAttachments(messageId: number): Array<{
    id: number
    media_type: string
    file_id: string | null
    data: Buffer
  }> {
    return this.db
      .query("SELECT id, media_type, file_id, data FROM attachments WHERE message_id = ?")
      .all(messageId) as Array<{
      id: number
      media_type: string
      file_id: string | null
      data: Buffer
    }>
  }

  getAttachmentsBySession(sessionId: string): Array<{
    message_id: number
    media_type: string
    file_id: string | null
  }> {
    return this.db
      .query(
        `SELECT a.message_id, a.media_type, a.file_id
         FROM attachments a
         JOIN messages m ON m.id = a.message_id
         WHERE m.session_id = ?
         ORDER BY a.id ASC`
      )
      .all(sessionId) as Array<{
      message_id: number
      media_type: string
      file_id: string | null
    }>
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Remove sessions (and cascaded messages/attachments) older than `days`.
   * Returns the number of sessions deleted.
   */
  cleanupOldSessions(days = 90): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()

    // Count first (changes includes CASCADE deletes which inflates the number)
    const row = this.db.query("SELECT COUNT(*) as cnt FROM sessions WHERE updated_at < ?").get(cutoff) as {
      cnt: number
    }
    if (row.cnt === 0) return 0

    // CASCADE handles messages + attachments automatically
    this.db.run("DELETE FROM sessions WHERE updated_at < ?", [cutoff])

    logger.info("Old sessions cleaned up", { deleted: row.cnt, olderThan: `${days}d` })
    return row.cnt
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close()
    logger.info("Database closed")
  }
}
