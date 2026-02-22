/**
 * Job scheduler backed by SQLite.
 *
 * Ticks every 60s, checks for due jobs, executes them via a callback.
 * Supports three schedule types:
 *   - once:      run at a specific datetime, then deactivate
 *   - recurring: run at a specific time daily, reschedule +24h
 *   - delay:     run after N ms from creation, then deactivate
 *
 * Parse helpers convert user-facing expressions into { type, runAt, intervalMs }:
 *   "at 18:00"   → once, today/tomorrow at 18:00
 *   "every 09:00" → recurring, next 09:00, interval 24h
 *   "in 30m"     → delay, now + 30 minutes
 *   "in 2h"      → delay, now + 2 hours
 */

import type { Database } from "./db"
import { logger } from "./logger"

const TICK_INTERVAL_MS = 60_000
const MAX_JOBS_PER_CHAT = 20
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

export interface ScheduleSpec {
  type: "once" | "recurring" | "delay"
  runAt: Date
  intervalMs?: number
}

export interface JobExecution {
  jobId: number
  chatId: number
  prompt: string
}

export type JobExecutor = (job: JobExecution) => Promise<void>

/**
 * Parse a schedule expression into a ScheduleSpec.
 *
 * Formats:
 *   "at HH:MM"    → once at that time (today if in future, tomorrow if past)
 *   "every HH:MM" → recurring daily at that time
 *   "in Nm"       → delay of N minutes
 *   "in Nh"       → delay of N hours
 */
export function parseSchedule(expr: string, now = new Date()): ScheduleSpec {
  const trimmed = expr.trim().toLowerCase()

  // "in 30m" or "in 2h"
  const delayMatch = trimmed.match(/^in\s+(\d+)\s*(m|h|min|ore|ora|minuti)$/)
  if (delayMatch) {
    const amount = parseInt(delayMatch[1], 10)
    const unit = delayMatch[2]
    if (amount <= 0) throw new Error("Il valore deve essere maggiore di 0")
    const ms = unit.startsWith("h") || unit === "ore" || unit === "ora" ? amount * MS_PER_HOUR : amount * MS_PER_MINUTE
    return { type: "delay", runAt: new Date(now.getTime() + ms) }
  }

  // "at HH:MM" or "every HH:MM"
  const timeMatch = trimmed.match(/^(at|every|alle|ogni)\s+(\d{1,2}):(\d{2})$/)
  if (timeMatch) {
    const mode = timeMatch[1]
    const hours = parseInt(timeMatch[2], 10)
    const minutes = parseInt(timeMatch[3], 10)

    if (hours < 0 || hours > 23) throw new Error("Ora non valida (0-23)")
    if (minutes < 0 || minutes > 59) throw new Error("Minuti non validi (0-59)")

    const target = new Date(now)
    target.setHours(hours, minutes, 0, 0)

    // If time is in the past today, schedule for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setTime(target.getTime() + MS_PER_DAY)
    }

    if (mode === "every" || mode === "ogni") {
      return { type: "recurring", runAt: target, intervalMs: MS_PER_DAY }
    }
    return { type: "once", runAt: target }
  }

  throw new Error(
    'Formato non valido. Usa: "at HH:MM", "every HH:MM", "in Nm", "in Nh"\n' +
      "Esempi: at 18:00, every 09:00, in 30m, in 2h"
  )
}

export class Scheduler {
  private readonly db: Database
  private readonly executor: JobExecutor
  private tickHandle: ReturnType<typeof setInterval> | null = null

  constructor(db: Database, executor: JobExecutor) {
    this.db = db
    this.executor = executor
  }

  /** Start the ticker. Runs every 60s. */
  start(): void {
    if (this.tickHandle) return
    logger.info("Scheduler started")

    // Run immediately on start, then every 60s
    this.tick()
    this.tickHandle = setInterval(() => this.tick(), TICK_INTERVAL_MS)
  }

  /** Stop the ticker. */
  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle)
      this.tickHandle = null
      logger.info("Scheduler stopped")
    }
  }

  /** Create a new scheduled job. Returns the job ID. */
  createJob(chatId: number, prompt: string, spec: ScheduleSpec): number {
    const activeCount = this.db.countActiveJobs(chatId)
    if (activeCount >= MAX_JOBS_PER_CHAT) {
      throw new Error(`Limite raggiunto: massimo ${MAX_JOBS_PER_CHAT} job attivi per chat`)
    }

    return this.db.insertJob(chatId, prompt, spec.type, spec.runAt.toISOString(), spec.intervalMs)
  }

  /** Check for due jobs and execute them. */
  private async tick(): Promise<void> {
    const now = new Date().toISOString()
    const dueJobs = this.db.getDueJobs(now)

    if (dueJobs.length === 0) return

    logger.debug("Scheduler tick", { dueJobs: dueJobs.length })

    for (const job of dueJobs) {
      try {
        await this.executor({ jobId: job.id, chatId: job.chat_id, prompt: job.prompt })

        // Compute next run (recurring → +interval, others → deactivate)
        let nextRunAt: string | null = null
        if (job.schedule_type === "recurring" && job.interval_ms) {
          const next = new Date(new Date(job.run_at).getTime() + job.interval_ms)
          nextRunAt = next.toISOString()
        }

        this.db.updateJobAfterRun(job.id, nextRunAt)
        logger.info("Job executed", { jobId: job.id, chatId: job.chat_id, type: job.schedule_type })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error("Job execution failed", { jobId: job.id, chatId: job.chat_id, error: msg })
        // Don't deactivate on failure — retry next tick
      }
    }
  }
}
