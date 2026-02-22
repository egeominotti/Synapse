/**
 * Structured logger powered by Pino.
 * Pretty-printed via pino-pretty to stderr (production).
 * Sync JSON to stderr in test mode for interceptability.
 */

import pino from "pino"
import type { LogLevel } from "./types"

const PINO_LEVELS: Record<LogLevel, string> = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
}

function createPino(): pino.Logger {
  return pino(
    {
      level: "info",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.transport({
      target: "pino-pretty",
      options: {
        destination: 2,
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    })
  )
}

const pinoInstance = createPino()

class Logger {
  private log: pino.Logger = pinoInstance

  setSessionId(id: string | null): void {
    if (id) {
      this.log = pinoInstance.child({ sid: id.slice(0, 8) })
    } else {
      this.log = pinoInstance
    }
  }

  setMinLevel(level: LogLevel): void {
    const pinoLevel = PINO_LEVELS[level] ?? "info"
    pinoInstance.level = pinoLevel
    this.log.level = pinoLevel
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log.debug(meta ?? {}, message)
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log.info(meta ?? {}, message)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log.warn(meta ?? {}, message)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log.error(meta ?? {}, message)
  }
}

/** Singleton logger instance */
export const logger = new Logger()
