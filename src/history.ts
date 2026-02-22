/**
 * Conversation history persistence.
 * Stores sessions as individual JSON files under ~/.claude-agent/history/.
 * Filename format: {sessionId}.json
 */

import { join } from "path"
import { mkdirSync, existsSync } from "fs"
import { readdir } from "fs/promises"
import type { SessionFile, ConversationMessage, SessionStats } from "./types"
import { logger } from "./logger"

export class HistoryManager {
  private readonly historyDir: string
  private currentSession: SessionFile | null = null

  constructor(historyDir: string) {
    this.historyDir = historyDir
    this.ensureDir()
  }

  private ensureDir(): void {
    if (!existsSync(this.historyDir)) {
      try {
        mkdirSync(this.historyDir, { recursive: true })
        logger.info("Created history directory", { path: this.historyDir })
      } catch (err) {
        logger.error("Failed to create history directory", {
          path: this.historyDir,
          error: String(err),
        })
      }
    }
  }

  /** Initialize or reset the current in-memory session */
  initSession(sessionId: string): void {
    const now = new Date().toISOString()
    this.currentSession = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      messages: [],
      stats: {
        totalMessages: 0,
        totalDurationMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
    }
    logger.info("Session initialized", { sessionId: sessionId.slice(0, 8) })
  }

  /** Add a message exchange to the current session and persist */
  async addMessage(message: ConversationMessage): Promise<void> {
    if (!this.currentSession) return

    this.currentSession.messages.push(message)
    this.currentSession.updatedAt = new Date().toISOString()

    // Update stats
    const stats = this.currentSession.stats
    stats.totalMessages++
    stats.totalDurationMs += message.durationMs
    if (message.tokenUsage) {
      stats.totalInputTokens += message.tokenUsage.inputTokens
      stats.totalOutputTokens += message.tokenUsage.outputTokens
    }

    await this.persist()
  }

  /** Get session statistics */
  getStats(): SessionStats | null {
    return this.currentSession?.stats ?? null
  }

  /** Get the last N messages from the current session */
  getRecentMessages(count: number): ConversationMessage[] {
    if (!this.currentSession) return []
    const messages = this.currentSession.messages
    return messages.slice(Math.max(0, messages.length - count))
  }

  /** Get the current session ID */
  getCurrentSessionId(): string | null {
    return this.currentSession?.sessionId ?? null
  }

  /** List all saved session files with metadata */
  async listSessions(): Promise<Array<{ sessionId: string; createdAt: string; messageCount: number }>> {
    try {
      const files = (await readdir(this.historyDir)).filter((f) => f.endsWith(".json"))

      // Read all files concurrently instead of sequentially
      const results = await Promise.all(
        files.map(async (file) => {
          try {
            const content = await Bun.file(join(this.historyDir, file)).text()
            const session: SessionFile = JSON.parse(content)
            return {
              sessionId: session.sessionId,
              createdAt: session.createdAt,
              messageCount: session.messages.length,
            }
          } catch {
            logger.warn("Skipping corrupted session file", { file })
            return null
          }
        })
      )

      return results
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    } catch (err) {
      logger.error("Failed to list sessions", { error: String(err) })
      return []
    }
  }

  /** Load a session from disk by session ID */
  async loadSession(sessionId: string): Promise<SessionFile | null> {
    const filePath = join(this.historyDir, `${sessionId}.json`)
    try {
      const bunFile = Bun.file(filePath)
      if (!(await bunFile.exists())) {
        // Try partial match — use async readdir to avoid blocking the event loop
        const allFiles = await readdir(this.historyDir)
        const files = allFiles.filter((f) => f.startsWith(sessionId))
        if (files.length === 1) {
          const matchFile = Bun.file(join(this.historyDir, files[0]))
          const content = await matchFile.text()
          const session: SessionFile = JSON.parse(content)
          this.currentSession = session
          logger.info("Session loaded via partial match", { sessionId: session.sessionId.slice(0, 8) })
          return session
        }
        if (files.length > 1) {
          logger.warn("Multiple sessions match prefix", { prefix: sessionId, count: files.length })
          return null
        }
        logger.warn("Session file not found", { sessionId: sessionId.slice(0, 8) })
        return null
      }

      const content = await bunFile.text()
      const session: SessionFile = JSON.parse(content)
      this.currentSession = session
      logger.info("Session loaded", { sessionId: session.sessionId.slice(0, 8) })
      return session
    } catch (err) {
      logger.error("Failed to load session", { sessionId: sessionId.slice(0, 8), error: String(err) })
      return null
    }
  }

  /** Write current session to disk */
  async persist(): Promise<void> {
    if (!this.currentSession) return

    const filePath = join(this.historyDir, `${this.currentSession.sessionId}.json`)
    try {
      const content = JSON.stringify(this.currentSession, null, 2)
      await Bun.write(filePath, content)
      logger.debug("Session persisted", { sessionId: this.currentSession.sessionId.slice(0, 8) })
    } catch (err) {
      logger.error("Failed to persist session", { error: String(err) })
    }
  }

  /** Force-save on shutdown */
  async shutdown(): Promise<void> {
    if (this.currentSession && this.currentSession.messages.length > 0) {
      logger.info("Persisting session before shutdown")
      await this.persist()
    }
  }

  /** Reset the current in-memory session (does not delete file) */
  reset(): void {
    this.currentSession = null
  }
}
