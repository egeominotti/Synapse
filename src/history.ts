/**
 * Conversation history persistence backed by SQLite.
 * Stores sessions and messages in the shared database.
 */

import type { SessionFile, ConversationMessage, SessionStats } from "./types"
import type { Database } from "./db"
import { logger } from "./logger"

export class HistoryManager {
  private readonly db: Database
  private currentSessionId: string | null = null

  constructor(db: Database) {
    this.db = db
  }

  /** Initialize or switch to a session */
  initSession(sessionId: string): void {
    this.db.upsertSession(sessionId)
    this.currentSessionId = sessionId
    logger.info("Session initialized", { sessionId: sessionId.slice(0, 8) })
  }

  /** Add a message exchange to the current session */
  async addMessage(message: ConversationMessage): Promise<void> {
    if (!this.currentSessionId) return

    this.db.insertMessage(
      this.currentSessionId,
      message.timestamp,
      message.prompt,
      message.response,
      message.durationMs,
      message.tokenUsage?.inputTokens ?? 0,
      message.tokenUsage?.outputTokens ?? 0
    )
  }

  /** Get session statistics (computed from DB aggregates) */
  getStats(): SessionStats | null {
    if (!this.currentSessionId) return null
    return this.db.getSessionStats(this.currentSessionId)
  }

  /** Get the last N messages from the current session */
  getRecentMessages(count: number): ConversationMessage[] {
    if (!this.currentSessionId) return []

    return this.db.getRecentMessages(this.currentSessionId, count).map((row) => ({
      timestamp: row.timestamp,
      prompt: row.prompt,
      response: row.response,
      durationMs: row.duration_ms,
      tokenUsage:
        row.input_tokens || row.output_tokens
          ? { inputTokens: row.input_tokens, outputTokens: row.output_tokens }
          : null,
    }))
  }

  /** Get the current session ID */
  getCurrentSessionId(): string | null {
    return this.currentSessionId
  }

  /** List all saved sessions with metadata */
  async listSessions(): Promise<Array<{ sessionId: string; createdAt: string; messageCount: number }>> {
    return this.db.listSessions()
  }

  /** Load a session by ID (supports partial match) */
  async loadSession(sessionId: string): Promise<SessionFile | null> {
    // Try exact match first
    let session = this.db.getSession(sessionId)

    // Try partial match
    if (!session) {
      const fullId = this.db.findSessionByPrefix(sessionId)
      if (fullId) {
        session = this.db.getSession(fullId)
      }
    }

    if (!session) {
      logger.warn("Session not found", { sessionId: sessionId.slice(0, 8) })
      return null
    }

    const messages = this.db.getMessages(session.session_id).map((row) => ({
      timestamp: row.timestamp,
      prompt: row.prompt,
      response: row.response,
      durationMs: row.duration_ms,
      tokenUsage:
        row.input_tokens || row.output_tokens
          ? { inputTokens: row.input_tokens, outputTokens: row.output_tokens }
          : null,
    }))

    const stats = this.db.getSessionStats(session.session_id) ?? {
      totalMessages: 0,
      totalDurationMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    }

    this.currentSessionId = session.session_id
    logger.info("Session loaded", { sessionId: session.session_id.slice(0, 8) })

    return {
      sessionId: session.session_id,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      messages,
      stats,
    }
  }

  /** No-op — SQLite writes are immediate, kept for interface compatibility */
  async persist(): Promise<void> {}

  /** No-op — DB lifecycle managed externally, kept for interface compatibility */
  async shutdown(): Promise<void> {}

  /** Reset the current session tracking (does not delete data) */
  reset(): void {
    this.currentSessionId = null
  }
}
