/**
 * Persistent session store for Telegram bot.
 * Maps chatId → Claude sessionId on disk as JSON.
 * Survives process restarts — Claude resumes from where it left off.
 */

import { existsSync, mkdirSync } from "fs"
import { dirname } from "path"
import { join } from "path"
import { homedir } from "os"

export const DEFAULT_SESSION_FILE = join(homedir(), ".claude-agent", "telegram-sessions.json")

export class SessionStore {
  private readonly path: string
  private sessions: Record<number, string> = {}

  constructor(path: string = DEFAULT_SESSION_FILE) {
    this.path = path
  }

  async load(): Promise<void> {
    if (!existsSync(this.path)) return
    try {
      const raw = await Bun.file(this.path).text()
      this.sessions = JSON.parse(raw)
    } catch {
      this.sessions = {}
    }
  }

  get size(): number {
    return Object.keys(this.sessions).length
  }

  get(chatId: number): string | undefined {
    return this.sessions[chatId]
  }

  async set(chatId: number, sessionId: string): Promise<void> {
    this.sessions[chatId] = sessionId
    await this.flush()
  }

  async delete(chatId: number): Promise<void> {
    delete this.sessions[chatId]
    await this.flush()
  }

  private async flush(): Promise<void> {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    await Bun.write(this.path, JSON.stringify(this.sessions, null, 2))
  }
}
