/**
 * Structured logger with timestamp, level, and optional session context.
 * Writes to stderr so stdout remains clean for the REPL UI.
 */

import type { LogLevel } from "./types"

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: "\x1b[90m",
  INFO: "\x1b[36m",
  WARN: "\x1b[33m",
  ERROR: "\x1b[31m",
}

const RESET = "\x1b[0m"

class Logger {
  private sessionId: string | null = null
  private minLevel: LogLevel = "INFO"

  setSessionId(id: string | null): void {
    this.sessionId = id
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel]
  }

  private formatTimestamp(): string {
    const now = new Date()
    return now.toISOString()
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return

    const color = LEVEL_COLORS[level]
    const ts = this.formatTimestamp()
    const sessionTag = this.sessionId ? ` [sid:${this.sessionId.slice(0, 8)}]` : ""
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : ""

    process.stderr.write(
      `${color}[${ts}] [${level}]${sessionTag} ${message}${metaStr}${RESET}\n`
    )
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write("DEBUG", message, meta)
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write("INFO", message, meta)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write("WARN", message, meta)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write("ERROR", message, meta)
  }
}

/** Singleton logger instance */
export const logger = new Logger()
