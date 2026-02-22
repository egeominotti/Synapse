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
    const row = this.db.query("SELECT session_id FROM telegram_sessions WHERE chat_id = ?").get(chatId) as {
      session_id: string
    } | null
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
    return this.db.query("SELECT chat_id, session_id FROM telegram_sessions").all() as Array<{
      chat_id: number
      session_id: string
    }>
  }

  countTelegramSessions(): number {
    const row = this.db.query("SELECT COUNT(*) as count FROM telegram_sessions").get() as { count: number }
    return row.count
  }

  // ---------------------------------------------------------------------------
  // Attachments (images)
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
  // Runtime config
  // ---------------------------------------------------------------------------

  getConfig(key: string): string | null {
    const row = this.db.query("SELECT value FROM runtime_config WHERE key = ?").get(key) as { value: string } | null
    return row?.value ?? null
  }

  setConfig(key: string, value: string): void {
    this.db.run(
      `INSERT INTO runtime_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
      [key, value, new Date().toISOString(), value, new Date().toISOString()]
    )
  }

  deleteConfig(key: string): void {
    this.db.run("DELETE FROM runtime_config WHERE key = ?", [key])
  }

  getAllConfig(): Array<{ key: string; value: string }> {
    return this.db.query("SELECT key, value FROM runtime_config ORDER BY key").all() as Array<{
      key: string
      value: string
    }>
  }

  clearAllConfig(): void {
    this.db.run("DELETE FROM runtime_config")
  }

  // ---------------------------------------------------------------------------
  // Scheduled jobs
  // ---------------------------------------------------------------------------

  insertJob(
    chatId: number,
    prompt: string,
    scheduleType: "once" | "recurring" | "delay",
    runAt: string,
    intervalMs?: number
  ): number {
    this.db.run(
      `INSERT INTO scheduled_jobs (chat_id, prompt, schedule_type, run_at, interval_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [chatId, prompt, scheduleType, runAt, intervalMs ?? null, new Date().toISOString()]
    )
    const row = this.db.query("SELECT last_insert_rowid() as id").get() as { id: number }
    return row.id
  }

  getDueJobs(now: string): Array<{
    id: number
    chat_id: number
    prompt: string
    schedule_type: string
    run_at: string
    interval_ms: number | null
  }> {
    return this.db
      .query(
        `SELECT id, chat_id, prompt, schedule_type, run_at, interval_ms
         FROM scheduled_jobs WHERE active = 1 AND run_at <= ? ORDER BY run_at ASC`
      )
      .all(now) as Array<{
      id: number
      chat_id: number
      prompt: string
      schedule_type: string
      run_at: string
      interval_ms: number | null
    }>
  }

  updateJobAfterRun(jobId: number, nextRunAt: string | null): void {
    const now = new Date().toISOString()
    if (nextRunAt) {
      this.db.run("UPDATE scheduled_jobs SET last_run_at = ?, run_at = ? WHERE id = ?", [now, nextRunAt, jobId])
    } else {
      this.db.run("UPDATE scheduled_jobs SET last_run_at = ?, active = 0 WHERE id = ?", [now, jobId])
    }
  }

  getJobsByChat(chatId: number): Array<{
    id: number
    prompt: string
    schedule_type: string
    run_at: string
    interval_ms: number | null
    created_at: string
  }> {
    return this.db
      .query(
        `SELECT id, prompt, schedule_type, run_at, interval_ms, created_at
         FROM scheduled_jobs WHERE chat_id = ? AND active = 1 ORDER BY run_at ASC`
      )
      .all(chatId) as Array<{
      id: number
      prompt: string
      schedule_type: string
      run_at: string
      interval_ms: number | null
      created_at: string
    }>
  }

  deleteJob(jobId: number, chatId: number): boolean {
    const result = this.db.run("DELETE FROM scheduled_jobs WHERE id = ? AND chat_id = ?", [jobId, chatId])
    return result.changes > 0
  }

  countActiveJobs(chatId: number): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM scheduled_jobs WHERE chat_id = ? AND active = 1")
      .get(chatId) as { count: number }
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
