import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "../src/db"
import { Scheduler, parseSchedule, toCronExpr } from "../src/scheduler"
import type { ScheduleSpec } from "../src/scheduler"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

let db: Database
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "neo-sched-"))
  db = new Database(join(tmpDir, "test.db"))
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// parseSchedule
// ---------------------------------------------------------------------------

describe("parseSchedule", () => {
  const now = new Date("2025-06-15T10:00:00.000Z")

  it('parses "in 30m"', () => {
    const spec = parseSchedule("in 30m", now)
    expect(spec.type).toBe("delay")
    expect(spec.runAt.getTime()).toBe(now.getTime() + 30 * 60_000)
  })

  it('parses "in 2h"', () => {
    const spec = parseSchedule("in 2h", now)
    expect(spec.type).toBe("delay")
    expect(spec.runAt.getTime()).toBe(now.getTime() + 2 * 3_600_000)
  })

  it('parses "at 18:00" (future today)', () => {
    const spec = parseSchedule("at 18:00", now)
    expect(spec.type).toBe("once")
    expect(spec.runAt.getHours()).toBe(18)
    expect(spec.runAt.getMinutes()).toBe(0)
  })

  it('parses "at 08:00" (past today → tomorrow)', () => {
    const spec = parseSchedule("at 08:00", now)
    expect(spec.type).toBe("once")
    // Should be tomorrow since 08:00 < 10:00 (now)
    expect(spec.runAt.getTime()).toBeGreaterThan(now.getTime())
    expect(spec.runAt.getHours()).toBe(8)
  })

  it('parses "every 09:00"', () => {
    const spec = parseSchedule("every 09:00", now)
    expect(spec.type).toBe("recurring")
    expect(spec.intervalMs).toBe(86_400_000)
    expect(spec.runAt.getHours()).toBe(9)
  })

  it("rejects invalid format", () => {
    expect(() => parseSchedule("tomorrow 10am", now)).toThrow("Invalid format")
  })

  it("rejects invalid hours", () => {
    expect(() => parseSchedule("at 25:00", now)).toThrow("Invalid hour")
  })

  it("rejects invalid minutes", () => {
    expect(() => parseSchedule("at 10:99", now)).toThrow("Invalid minutes")
  })

  it("rejects zero delay", () => {
    expect(() => parseSchedule("in 0m", now)).toThrow("greater than 0")
  })

  it('parses "every 30s" (interval seconds)', () => {
    const spec = parseSchedule("every 30s", now)
    expect(spec.type).toBe("recurring")
    expect(spec.intervalMs).toBe(30_000)
    expect(spec.runAt.getTime()).toBe(now.getTime() + 30_000)
  })

  it('parses "every 5m" (interval minutes)', () => {
    const spec = parseSchedule("every 5m", now)
    expect(spec.type).toBe("recurring")
    expect(spec.intervalMs).toBe(5 * 60_000)
  })

  it('parses "in 10s" (delay seconds)', () => {
    const spec = parseSchedule("in 10s", now)
    expect(spec.type).toBe("delay")
    expect(spec.runAt.getTime()).toBe(now.getTime() + 10_000)
  })

  it("rejects interval below minimum (30s)", () => {
    expect(() => parseSchedule("every 10s", now)).toThrow("Minimum interval")
  })

  it('parses "every 1h" (interval hours)', () => {
    const spec = parseSchedule("every 1h", now)
    expect(spec.type).toBe("recurring")
    expect(spec.intervalMs).toBe(3_600_000)
  })

  it("rejects zero interval", () => {
    expect(() => parseSchedule("every 0s", now)).toThrow("greater than 0")
  })

  it("rejects interval of 15s (below 30s minimum)", () => {
    expect(() => parseSchedule("every 15s", now)).toThrow("Minimum interval")
  })

  it("accepts exactly 30s interval", () => {
    const spec = parseSchedule("every 30s", now)
    expect(spec.intervalMs).toBe(30_000)
  })

  // --- Raw cron expressions ---

  it('parses "cron */5 * * * *" (5-field standard)', () => {
    const spec = parseSchedule("cron */5 * * * *")
    expect(spec.type).toBe("cron")
    expect(spec.cronExpr).toBe("*/5 * * * *")
    expect(spec.runAt).toBeInstanceOf(Date)
  })

  it('parses "cron */30 * * * * *" (6-field with seconds)', () => {
    const spec = parseSchedule("cron */30 * * * * *")
    expect(spec.type).toBe("cron")
    expect(spec.cronExpr).toBe("*/30 * * * * *")
  })

  it('parses "cron 0 0 9 * * *" (daily at 9am with seconds)', () => {
    const spec = parseSchedule("cron 0 0 9 * * *")
    expect(spec.type).toBe("cron")
    expect(spec.cronExpr).toBe("0 0 9 * * *")
  })

  it("rejects invalid cron expression", () => {
    expect(() => parseSchedule("cron invalid")).toThrow()
  })
})

// ---------------------------------------------------------------------------
// toCronExpr
// ---------------------------------------------------------------------------

describe("toCronExpr", () => {
  it("returns cronExpr if already set", () => {
    const spec: ScheduleSpec = { type: "cron", runAt: new Date(), cronExpr: "0 0 9 * * *" }
    expect(toCronExpr(spec)).toBe("0 0 9 * * *")
  })

  it("returns seconds-based cron for <60s interval", () => {
    const spec: ScheduleSpec = { type: "recurring", runAt: new Date(), intervalMs: 30_000 }
    expect(toCronExpr(spec)).toBe("*/30 * * * * *")
  })

  it("returns minutes-based cron for <1h interval", () => {
    const spec: ScheduleSpec = { type: "recurring", runAt: new Date(), intervalMs: 5 * 60_000 }
    expect(toCronExpr(spec)).toBe("0 */5 * * * *")
  })

  it("returns hours-based cron for <24h interval", () => {
    const spec: ScheduleSpec = { type: "recurring", runAt: new Date(), intervalMs: 2 * 3_600_000 }
    expect(toCronExpr(spec)).toBe("0 0 */2 * * *")
  })

  it("returns daily cron at specific time for 24h interval", () => {
    const runAt = new Date("2025-06-15T09:30:00")
    const spec: ScheduleSpec = { type: "recurring", runAt, intervalMs: 86_400_000 }
    expect(toCronExpr(spec)).toBe(`0 30 9 * * *`)
  })

  it("returns undefined for non-recurring type", () => {
    const spec: ScheduleSpec = { type: "once", runAt: new Date() }
    expect(toCronExpr(spec)).toBeUndefined()
  })

  it("returns undefined for delay type", () => {
    const spec: ScheduleSpec = { type: "delay", runAt: new Date() }
    expect(toCronExpr(spec)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// DB: scheduled_jobs CRUD
// ---------------------------------------------------------------------------

describe("Database scheduled_jobs", () => {
  it("inserts and retrieves a job", () => {
    const runAt = new Date(Date.now() + 60_000).toISOString()
    const id = db.insertJob(123, "test prompt", "once", runAt)
    expect(id).toBeGreaterThan(0)

    const jobs = db.getJobsByChat(123)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].prompt).toBe("test prompt")
    expect(jobs[0].schedule_type).toBe("once")
  })

  it("inserts job with cron_expr", () => {
    const runAt = new Date(Date.now() + 60_000).toISOString()
    db.insertJob(1, "cron job", "cron", runAt, undefined, "*/5 * * * *")

    const jobs = db.getJobsByChat(1)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].cron_expr).toBe("*/5 * * * *")
    expect(jobs[0].schedule_type).toBe("cron")
  })

  it("getActiveJobs returns all active jobs", () => {
    const runAt = new Date(Date.now() + 60_000).toISOString()
    db.insertJob(1, "a", "once", runAt)
    db.insertJob(2, "b", "recurring", runAt, 60_000, "0 */1 * * * *")

    const active = db.getActiveJobs()
    expect(active).toHaveLength(2)
    expect(active[0].prompt).toBe("a")
    expect(active[1].prompt).toBe("b")
    expect(active[1].cron_expr).toBe("0 */1 * * * *")
  })

  it("markJobDone deactivates a job", () => {
    const runAt = new Date(Date.now() + 60_000).toISOString()
    const id = db.insertJob(1, "test", "once", runAt)
    db.markJobDone(id)

    const jobs = db.getJobsByChat(1)
    expect(jobs).toHaveLength(0) // inactive
    expect(db.getActiveJobs()).toHaveLength(0)
  })

  it("updateJobLastRun sets last_run_at without deactivating", () => {
    const runAt = new Date(Date.now() + 60_000).toISOString()
    const id = db.insertJob(1, "recurring", "recurring", runAt, 60_000)
    db.updateJobLastRun(id)

    const jobs = db.getJobsByChat(1)
    expect(jobs).toHaveLength(1) // still active
  })

  it("deleteJob only deletes own chat's jobs", () => {
    const runAt = new Date(Date.now() + 60_000).toISOString()
    const id = db.insertJob(123, "test", "once", runAt)

    // Wrong chat
    expect(db.deleteJob(id, 999)).toBe(false)
    expect(db.getJobsByChat(123)).toHaveLength(1)

    // Right chat
    expect(db.deleteJob(id, 123)).toBe(true)
    expect(db.getJobsByChat(123)).toHaveLength(0)
  })

  it("deleteAllJobs deletes all jobs for a chat", () => {
    const runAt = new Date(Date.now() + 60_000).toISOString()
    db.insertJob(1, "a", "once", runAt)
    db.insertJob(1, "b", "once", runAt)
    db.insertJob(2, "c", "once", runAt)

    expect(db.deleteAllJobs(1)).toBe(2)
    expect(db.getJobsByChat(1)).toHaveLength(0)
    expect(db.getJobsByChat(2)).toHaveLength(1)
  })

  it("countActiveJobs counts correctly", () => {
    const runAt = new Date(Date.now() + 60_000).toISOString()
    db.insertJob(1, "a", "once", runAt)
    db.insertJob(1, "b", "once", runAt)
    db.insertJob(2, "c", "once", runAt)

    expect(db.countActiveJobs(1)).toBe(2)
    expect(db.countActiveJobs(2)).toBe(1)
    expect(db.countActiveJobs(999)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Scheduler class
// ---------------------------------------------------------------------------

describe("Scheduler", () => {
  it("createJob returns a job ID", () => {
    const sched = new Scheduler(db, async () => {})

    const spec: ScheduleSpec = {
      type: "once",
      runAt: new Date(Date.now() + 60_000),
    }
    const id = sched.createJob(123, "hello", spec)
    expect(id).toBeGreaterThan(0)
    sched.stop()
  })

  it("enforces max jobs per chat", () => {
    const sched = new Scheduler(db, async () => {})
    const spec: ScheduleSpec = { type: "once", runAt: new Date(Date.now() + 60_000) }

    for (let i = 0; i < 20; i++) {
      sched.createJob(1, `job ${i}`, spec)
    }

    expect(() => sched.createJob(1, "one too many", spec)).toThrow("Limit reached")
    sched.stop()
  })

  it("max jobs limit is per chat", () => {
    const sched = new Scheduler(db, async () => {})
    const spec: ScheduleSpec = { type: "once", runAt: new Date(Date.now() + 60_000) }

    for (let i = 0; i < 20; i++) {
      sched.createJob(1, `job ${i}`, spec)
    }

    // Different chat should still work
    expect(() => sched.createJob(2, "other chat", spec)).not.toThrow()
    sched.stop()
  })

  it("createJob stores correct interval_ms and cron_expr for recurring", () => {
    const sched = new Scheduler(db, async () => {})
    const spec: ScheduleSpec = {
      type: "recurring",
      runAt: new Date(Date.now() + 30_000),
      intervalMs: 30_000,
    }
    sched.createJob(1, "every 30s test", spec)
    const jobs = db.getJobsByChat(1)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].interval_ms).toBe(30_000)
    expect(jobs[0].schedule_type).toBe("recurring")
    expect(jobs[0].cron_expr).toBe("*/30 * * * * *")
    sched.stop()
  })

  it("cancelJob stops cron and removes from DB", () => {
    const sched = new Scheduler(db, async () => {})
    const spec: ScheduleSpec = {
      type: "recurring",
      runAt: new Date(Date.now() + 60_000),
      intervalMs: 60_000,
    }
    const id = sched.createJob(1, "test", spec)
    expect(db.getJobsByChat(1)).toHaveLength(1)

    expect(sched.cancelJob(id, 1)).toBe(true)
    expect(db.getJobsByChat(1)).toHaveLength(0)
    sched.stop()
  })

  it("cancelAllJobs stops all crons for a chat", () => {
    const sched = new Scheduler(db, async () => {})
    const spec: ScheduleSpec = {
      type: "recurring",
      runAt: new Date(Date.now() + 60_000),
      intervalMs: 60_000,
    }
    sched.createJob(1, "a", spec)
    sched.createJob(1, "b", spec)
    sched.createJob(2, "c", spec)

    expect(sched.cancelAllJobs(1)).toBe(2)
    expect(db.getJobsByChat(1)).toHaveLength(0)
    expect(db.getJobsByChat(2)).toHaveLength(1)
    sched.stop()
  })

  it("start() loads active jobs from DB and creates Cron instances", () => {
    // Insert jobs directly into DB
    const runAt = new Date(Date.now() + 60_000).toISOString()
    db.insertJob(1, "job a", "recurring", runAt, 60_000, "0 */1 * * * *")
    db.insertJob(1, "job b", "once", runAt)

    const sched = new Scheduler(db, async () => {})
    sched.start()

    // Both should be loaded — cancelAllJobs should stop them
    const count = sched.cancelAllJobs(1)
    expect(count).toBe(2)
    sched.stop()
  })
})
