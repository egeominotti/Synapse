/**
 * Job scheduler powered by croner.
 *
 * Each active job gets its own Cron instance — precise timing, no polling.
 * Supports: once, recurring, delay, and raw cron expressions.
 *
 * Parse helpers convert user-facing expressions into ScheduleSpec:
 *   "at 18:00"        → once, today/tomorrow at 18:00
 *   "every 09:00"     → recurring daily (cron: 0 0 9 * * *)
 *   "every 30s"       → recurring (cron: *\/30 * * * * *)
 *   "in 30m"          → delay, one-shot at now + 30 minutes
 *   "cron * * * * *"  → raw cron expression
 */

import { Cron } from "croner"
import type { Database } from "./db"
import { logger } from "./logger"

const MAX_JOBS_PER_CHAT = 20
const MAX_CONSECUTIVE_FAILURES = 3
const MS_PER_SECOND = 1_000
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000
const MIN_INTERVAL_MS = 30_000 // minimum recurring interval: 30 seconds

export interface ScheduleSpec {
  type: "once" | "recurring" | "delay" | "cron"
  runAt: Date
  cronExpr?: string
  intervalMs?: number
}

export interface JobExecution {
  jobId: number
  chatId: number
  prompt: string
}

export type JobExecutor = (job: JobExecution) => Promise<void>

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/** Convert a time unit string + amount to milliseconds */
function parseUnitToMs(unit: string, amount: number): number {
  if (unit === "s" || unit === "sec" || unit === "secondi") return amount * MS_PER_SECOND
  if (unit.startsWith("h") || unit === "ore" || unit === "ora") return amount * MS_PER_HOUR
  return amount * MS_PER_MINUTE // m, min, minuti
}

/** Convert a recurring ScheduleSpec to a cron expression. */
export function toCronExpr(spec: ScheduleSpec): string | undefined {
  if (spec.cronExpr) return spec.cronExpr
  if (spec.type !== "recurring" || !spec.intervalMs) return undefined

  const ms = spec.intervalMs
  if (ms < MS_PER_MINUTE) {
    // Seconds-based: */N * * * * *
    const secs = Math.round(ms / MS_PER_SECOND)
    return `*/${secs} * * * * *`
  }
  if (ms < MS_PER_HOUR) {
    // Minutes-based: 0 */N * * * *
    const mins = Math.round(ms / MS_PER_MINUTE)
    return `0 */${mins} * * * *`
  }
  if (ms < MS_PER_DAY) {
    // Hours-based: 0 0 */N * * *
    const hours = Math.round(ms / MS_PER_HOUR)
    return `0 0 */${hours} * * *`
  }
  // Daily at specific time — extract from runAt
  const h = spec.runAt.getHours()
  const m = spec.runAt.getMinutes()
  return `0 ${m} ${h} * * *`
}

/**
 * Parse a schedule expression into a ScheduleSpec.
 *
 * Formats:
 *   "at HH:MM"           → once at that time
 *   "every HH:MM"        → recurring daily
 *   "in Nm/Nh/Ns"        → delay (one-shot)
 *   "every Nm/Nh/Ns"     → recurring interval
 *   "cron <expr>"        → raw cron expression
 */
export function parseSchedule(expr: string, now = new Date()): ScheduleSpec {
  const trimmed = expr.trim().toLowerCase()

  // Raw cron: "cron */5 * * * *" or "cron 0 0 9 * * *"
  const cronMatch = expr.trim().match(/^cron\s+(.+)$/i)
  if (cronMatch) {
    const cronExpr = cronMatch[1].trim()
    // Validate by trying to create a Cron (throws if invalid)
    const test = new Cron(cronExpr, { timezone: "Europe/Rome" })
    const nextRun = test.nextRun()
    test.stop()
    if (!nextRun) throw new Error("Espressione cron non valida o non ha esecuzioni future")
    return { type: "cron", runAt: nextRun, cronExpr }
  }

  // "in 30s", "in 30m" or "in 2h"
  const delayMatch = trimmed.match(/^in\s+(\d+)\s*(s|m|h|sec|min|ore|ora|minuti|secondi)$/)
  if (delayMatch) {
    const amount = parseInt(delayMatch[1], 10)
    const unit = delayMatch[2]
    if (amount <= 0) throw new Error("Il valore deve essere maggiore di 0")
    const ms = parseUnitToMs(unit, amount)
    return { type: "delay", runAt: new Date(now.getTime() + ms) }
  }

  // "every 30s", "every 5m" or "every 2h" — interval-based recurring
  const intervalMatch = trimmed.match(/^(every|ogni)\s+(\d+)\s*(s|m|h|sec|min|ore|ora|minuti|secondi)$/)
  if (intervalMatch) {
    const amount = parseInt(intervalMatch[2], 10)
    const unit = intervalMatch[3]
    if (amount <= 0) throw new Error("Il valore deve essere maggiore di 0")
    const ms = parseUnitToMs(unit, amount)
    if (ms < MIN_INTERVAL_MS) throw new Error(`Intervallo minimo: ${MIN_INTERVAL_MS / 1000} secondi`)
    const spec: ScheduleSpec = { type: "recurring", runAt: new Date(now.getTime() + ms), intervalMs: ms }
    spec.cronExpr = toCronExpr(spec)
    return spec
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

    if (target.getTime() <= now.getTime()) {
      target.setTime(target.getTime() + MS_PER_DAY)
    }

    if (mode === "every" || mode === "ogni") {
      const cronExpr = `0 ${minutes} ${hours} * * *`
      return { type: "recurring", runAt: target, intervalMs: MS_PER_DAY, cronExpr }
    }
    return { type: "once", runAt: target }
  }

  throw new Error(
    'Formato non valido. Usa: "at HH:MM", "every HH:MM", "every Ns/Nm/Nh", "in Ns/Nm/Nh", "cron <expr>"\n' +
      "Esempi: at 18:00, every 09:00, every 30s, in 30m, cron */5 * * * *"
  )
}

// ---------------------------------------------------------------------------
// Scheduler — powered by croner
// ---------------------------------------------------------------------------

export class Scheduler {
  private readonly db: Database
  private readonly executor: JobExecutor
  private readonly cronJobs = new Map<number, Cron>()
  private readonly failureCounts = new Map<number, number>()

  constructor(db: Database, executor: JobExecutor) {
    this.db = db
    this.executor = executor
  }

  /** Load all active jobs from DB and create Cron instances. */
  start(): void {
    const jobs = this.db.getActiveJobs()
    for (const job of jobs) {
      this.scheduleJob(job)
    }
    logger.info("Scheduler started", { jobs: jobs.length })
  }

  /** Stop all Cron instances. */
  stop(): void {
    for (const cron of this.cronJobs.values()) {
      cron.stop()
    }
    this.cronJobs.clear()
    this.failureCounts.clear()
    logger.info("Scheduler stopped")
  }

  /** Create a new scheduled job. Returns the job ID. */
  createJob(chatId: number, prompt: string, spec: ScheduleSpec): number {
    const activeCount = this.db.countActiveJobs(chatId)
    if (activeCount >= MAX_JOBS_PER_CHAT) {
      throw new Error(`Limite raggiunto: massimo ${MAX_JOBS_PER_CHAT} job attivi per chat`)
    }

    const cronExpr = spec.cronExpr ?? toCronExpr(spec)
    const id = this.db.insertJob(chatId, prompt, spec.type, spec.runAt.toISOString(), spec.intervalMs, cronExpr)

    this.scheduleJob({
      id,
      chat_id: chatId,
      prompt,
      schedule_type: spec.type,
      run_at: spec.runAt.toISOString(),
      interval_ms: spec.intervalMs ?? null,
      cron_expr: cronExpr ?? null,
    })

    return id
  }

  /** Cancel a specific job. Stops the Cron and removes from DB. */
  cancelJob(jobId: number, chatId: number): boolean {
    const cron = this.cronJobs.get(jobId)
    if (cron) {
      cron.stop()
      this.cronJobs.delete(jobId)
      this.failureCounts.delete(jobId)
    }
    return this.db.deleteJob(jobId, chatId)
  }

  /** Cancel all jobs for a chat. */
  cancelAllJobs(chatId: number): number {
    // Stop all Cron instances for this chat
    const jobs = this.db.getJobsByChat(chatId)
    for (const job of jobs) {
      const cron = this.cronJobs.get(job.id)
      if (cron) {
        cron.stop()
        this.cronJobs.delete(job.id)
        this.failureCounts.delete(job.id)
      }
    }
    return this.db.deleteAllJobs(chatId)
  }

  /** Schedule a single job by creating a Cron instance. */
  private scheduleJob(job: {
    id: number
    chat_id: number
    prompt: string
    schedule_type: string
    run_at: string
    interval_ms: number | null
    cron_expr: string | null
  }): void {
    const isOneShot = job.schedule_type === "once" || job.schedule_type === "delay"

    if (job.cron_expr) {
      // Recurring or cron — use cron expression
      const cron = new Cron(
        job.cron_expr,
        { timezone: "Europe/Rome", protect: true, catch: true },
        () => void this.executeJob(job)
      )
      this.cronJobs.set(job.id, cron)
      logger.debug("Cron job scheduled", { jobId: job.id, cron: job.cron_expr })
    } else {
      // One-shot — use Date
      const runAt = new Date(job.run_at)

      if (runAt.getTime() <= Date.now()) {
        // Past due — fire immediately, then deactivate
        logger.debug("Job past due, firing immediately", { jobId: job.id })
        void this.executeJob(job).finally(() => {
          if (isOneShot) this.db.markJobDone(job.id)
        })
        return
      }

      const cron = new Cron(runAt, { maxRuns: 1, catch: true }, () => {
        void this.executeJob(job).finally(() => {
          this.db.markJobDone(job.id)
          this.cronJobs.delete(job.id)
        })
      })
      this.cronJobs.set(job.id, cron)
      logger.debug("One-shot job scheduled", { jobId: job.id, runAt: job.run_at })
    }
  }

  /** Execute a single job with failure tracking. */
  private async executeJob(job: { id: number; chat_id: number; prompt: string; schedule_type: string }): Promise<void> {
    try {
      await this.executor({ jobId: job.id, chatId: job.chat_id, prompt: job.prompt })
      this.failureCounts.delete(job.id)
      this.db.updateJobLastRun(job.id)
      logger.info("Job executed", { jobId: job.id, chatId: job.chat_id, type: job.schedule_type })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const failures = (this.failureCounts.get(job.id) ?? 0) + 1
      this.failureCounts.set(job.id, failures)

      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error("Job deactivated after repeated failures", {
          jobId: job.id,
          chatId: job.chat_id,
          failures,
          error: msg,
        })
        // Stop cron and deactivate in DB
        const cron = this.cronJobs.get(job.id)
        if (cron) cron.stop()
        this.cronJobs.delete(job.id)
        this.db.markJobDone(job.id)
        this.failureCounts.delete(job.id)
      } else {
        logger.warn("Job execution failed, will retry", {
          jobId: job.id,
          chatId: job.chat_id,
          failures,
          maxFailures: MAX_CONSECUTIVE_FAILURES,
          error: msg,
        })
      }
    }
  }
}
