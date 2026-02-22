import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "../src/db"
import { Scheduler, parseSchedule } from "../src/scheduler"
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

  it('parses "ogni 09:00" (Italian)', () => {
    const spec = parseSchedule("ogni 09:00", now)
    expect(spec.type).toBe("recurring")
  })

  it("rejects invalid format", () => {
    expect(() => parseSchedule("tomorrow 10am", now)).toThrow("Formato non valido")
  })

  it("rejects invalid hours", () => {
    expect(() => parseSchedule("at 25:00", now)).toThrow("Ora non valida")
  })

  it("rejects invalid minutes", () => {
    expect(() => parseSchedule("at 10:99", now)).toThrow("Minuti non validi")
  })

  it("rejects zero delay", () => {
    expect(() => parseSchedule("in 0m", now)).toThrow("maggiore di 0")
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
    expect(() => parseSchedule("every 10s", now)).toThrow("Intervallo minimo")
  })

  // --- Italian aliases ---

  it('parses "in 5 minuti"', () => {
    const spec = parseSchedule("in 5 minuti", now)
    expect(spec.type).toBe("delay")
    expect(spec.runAt.getTime()).toBe(now.getTime() + 5 * 60_000)
  })

  it('parses "in 10 secondi"', () => {
    const spec = parseSchedule("in 10 secondi", now)
    expect(spec.type).toBe("delay")
    expect(spec.runAt.getTime()).toBe(now.getTime() + 10_000)
  })

  it('parses "in 2 ore"', () => {
    const spec = parseSchedule("in 2 ore", now)
    expect(spec.type).toBe("delay")
    expect(spec.runAt.getTime()).toBe(now.getTime() + 2 * 3_600_000)
  })

  it('parses "in 1 ora"', () => {
    const spec = parseSchedule("in 1 ora", now)
    expect(spec.type).toBe("delay")
    expect(spec.runAt.getTime()).toBe(now.getTime() + 3_600_000)
  })

  it('parses "ogni 1m" (interval minutes)', () => {
    const spec = parseSchedule("ogni 1m", now)
    expect(spec.type).toBe("recurring")
    expect(spec.intervalMs).toBe(60_000)
    expect(spec.runAt.getTime()).toBe(now.getTime() + 60_000)
  })

  it('parses "every 1h" (interval hours)', () => {
    const spec = parseSchedule("every 1h", now)
    expect(spec.type).toBe("recurring")
    expect(spec.intervalMs).toBe(3_600_000)
  })

  it('parses "alle 14:30"', () => {
    const spec = parseSchedule("alle 14:30", now)
    expect(spec.type).toBe("once")
    expect(spec.runAt.getHours()).toBe(14)
    expect(spec.runAt.getMinutes()).toBe(30)
  })

  it("rejects zero interval", () => {
    expect(() => parseSchedule("every 0s", now)).toThrow("maggiore di 0")
  })

  it("rejects interval of 15s (below 30s minimum)", () => {
    expect(() => parseSchedule("every 15s", now)).toThrow("Intervallo minimo")
  })

  it("accepts exactly 30s interval", () => {
    const spec = parseSchedule("every 30s", now)
    expect(spec.intervalMs).toBe(30_000)
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

  it("getDueJobs returns only due jobs", () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 3_600_000).toISOString()

    db.insertJob(1, "due", "once", past)
    db.insertJob(1, "not due", "once", future)

    const due = db.getDueJobs(new Date().toISOString())
    expect(due).toHaveLength(1)
    expect(due[0].prompt).toBe("due")
  })

  it("updateJobAfterRun deactivates one-shot jobs", () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const id = db.insertJob(1, "once", "once", past)

    db.updateJobAfterRun(id, null)

    const jobs = db.getJobsByChat(1)
    expect(jobs).toHaveLength(0) // deactivated
  })

  it("updateJobAfterRun reschedules recurring jobs", () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const nextRun = new Date(Date.now() + 86_400_000).toISOString()
    const id = db.insertJob(1, "recurring", "recurring", past, 86_400_000)

    db.updateJobAfterRun(id, nextRun)

    const jobs = db.getJobsByChat(1)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].run_at).toBe(nextRun)
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
    const executed: number[] = []
    const sched = new Scheduler(db, async (job) => {
      executed.push(job.jobId)
    })

    const spec: ScheduleSpec = {
      type: "once",
      runAt: new Date(Date.now() + 60_000),
    }
    const id = sched.createJob(123, "hello", spec)
    expect(id).toBeGreaterThan(0)
  })

  it("enforces max jobs per chat", () => {
    const sched = new Scheduler(db, async () => {})
    const spec: ScheduleSpec = { type: "once", runAt: new Date(Date.now() + 60_000) }

    for (let i = 0; i < 20; i++) {
      sched.createJob(1, `job ${i}`, spec)
    }

    expect(() => sched.createJob(1, "one too many", spec)).toThrow("Limite raggiunto")
  })

  it("max jobs limit is per chat", () => {
    const sched = new Scheduler(db, async () => {})
    const spec: ScheduleSpec = { type: "once", runAt: new Date(Date.now() + 60_000) }

    for (let i = 0; i < 20; i++) {
      sched.createJob(1, `job ${i}`, spec)
    }

    // Different chat should still work
    expect(() => sched.createJob(2, "other chat", spec)).not.toThrow()
  })

  it("createJob stores correct interval_ms for recurring", () => {
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
  })
})
