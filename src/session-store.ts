/**
 * Persistent session store for Telegram bot backed by SQLite.
 * Maps chatId → Claude sessionId.
 * Survives process restarts — Claude resumes from where it left off.
 */

import type { Database } from "./db"
import { logger } from "./logger"

export class SessionStore {
  private readonly db: Database
  /** In-memory cache for fast lookups */
  private cache: Map<number, string> = new Map()

  constructor(db: Database) {
    this.db = db
  }

  /** Load all sessions into memory cache */
  async load(): Promise<void> {
    const rows = this.db.getAllTelegramSessions()
    this.cache.clear()
    for (const row of rows) {
      this.cache.set(row.chat_id, row.session_id)
    }
    logger.debug("Telegram sessions loaded into cache", { count: this.cache.size })
  }

  get size(): number {
    return this.cache.size
  }

  get(chatId: number): string | undefined {
    return this.cache.get(chatId)
  }

  async set(chatId: number, sessionId: string): Promise<void> {
    this.db.setTelegramSession(chatId, sessionId)
    this.cache.set(chatId, sessionId)
  }

  async delete(chatId: number): Promise<void> {
    this.db.deleteTelegramSession(chatId)
    this.cache.delete(chatId)
  }

  /** Clear all session mappings (cache + DB). Used on startup to discard stale CLI sessions. */
  clearAll(): void {
    this.db.clearAllTelegramSessions()
    this.cache.clear()
  }
}
