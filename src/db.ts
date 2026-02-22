/**
 * Full database — extends DatabaseCore with Telegram sessions,
 * runtime config, and scheduled jobs.
 */

import { DatabaseCore } from "./db-core"
import { logger } from "./logger"

export class Database extends DatabaseCore {
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

  /** Get all known chat IDs from both telegram_sessions and sessions tables. */
  getAllKnownChatIds(): number[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT chat_id FROM (
          SELECT chat_id FROM telegram_sessions
          UNION
          SELECT chat_id FROM sessions WHERE chat_id IS NOT NULL
        )`
      )
      .all() as Array<{ chat_id: number }>
    return rows.map((r) => r.chat_id)
  }

  countTelegramSessions(): number {
    const row = this.db.query("SELECT COUNT(*) as count FROM telegram_sessions").get() as { count: number }
    return row.count
  }

  /**
   * Remove telegram_sessions whose session no longer exists in the sessions table.
   * Returns number of orphans deleted.
   */
  cleanupOrphanTelegramSessions(): number {
    const result = this.db.run(
      "DELETE FROM telegram_sessions WHERE session_id NOT IN (SELECT session_id FROM sessions)"
    )
    if (result.changes > 0) {
      logger.info("Orphan telegram sessions cleaned up", { deleted: result.changes })
    }
    return result.changes
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

  deleteAllJobs(chatId: number): number {
    const result = this.db.run("DELETE FROM scheduled_jobs WHERE chat_id = ?", [chatId])
    return result.changes
  }

  countActiveJobs(chatId: number): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM scheduled_jobs WHERE chat_id = ? AND active = 1")
      .get(chatId) as { count: number }
    return row.count
  }
}
