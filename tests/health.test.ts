import { describe, it, expect } from "bun:test"
import { HealthMonitor, type HealthMonitorDeps } from "../src/health"
import { Database } from "../src/db"
import type { AgentPool } from "../src/agent-pool"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function createTestDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "health-test-"))
  return new Database(join(dir, "test.db"))
}

function createDeps(overrides: Partial<HealthMonitorDeps> = {}): HealthMonitorDeps {
  return {
    db: createTestDb(),
    botStartedAt: Date.now() - 60_000,
    agentPools: new Map<number, AgentPool>(),
    ...overrides,
  }
}

describe("HealthMonitor", () => {
  it("check returns valid status with working DB", async () => {
    const deps = createDeps()
    const alerts: string[] = []
    const monitor = new HealthMonitor(deps, (msg) => alerts.push(msg))

    const status = await monitor.check()

    expect(status.db).toBe(true)
    expect(status.groq).toBeNull()
    expect(status.whisper).toBeNull()
    expect(status.memoryMb).toBeGreaterThan(0)
    expect(status.uptimeMs).toBeGreaterThan(0)
    expect(alerts).toHaveLength(0) // first run = no alerts
  })

  it("no alert when status is unchanged between checks", async () => {
    const deps = createDeps()
    const alerts: string[] = []
    const monitor = new HealthMonitor(deps, (msg) => alerts.push(msg))

    await monitor.check() // first run
    await monitor.check() // second run — same status
    await monitor.check() // third run — same status

    expect(alerts).toHaveLength(0)
  })

  it("alerts when DB goes down", async () => {
    const deps = createDeps()
    const alerts: string[] = []
    const monitor = new HealthMonitor(deps, (msg) => alerts.push(msg))

    // First check — DB is ok
    await monitor.check()
    expect(alerts).toHaveLength(0)

    // Close DB to simulate failure
    deps.db.close()

    // Second check — DB is down
    await monitor.check()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain("DB SQLite non raggiungibile")
    expect(alerts[0]).toContain("Health Alert")
  })

  it("alerts recovery when DB comes back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "health-test-"))
    const dbPath = join(dir, "test.db")
    const db = new Database(dbPath)
    const deps: HealthMonitorDeps = { db, botStartedAt: Date.now() - 60_000, agentPools: new Map() }
    const alerts: string[] = []
    const monitor = new HealthMonitor(deps, (msg) => alerts.push(msg))

    // First check — DB ok
    await monitor.check()

    // Close DB
    db.close()
    await monitor.check()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain("non raggiungibile")

    // Reopen DB — recovery
    deps.db = new Database(dbPath)
    await monitor.check()
    expect(alerts).toHaveLength(2)
    expect(alerts[1]).toContain("ripristinato")
  })

  it("start and stop control the loop", async () => {
    const deps = createDeps()
    let checkCount = 0
    const monitor = new HealthMonitor(deps, () => {})

    // Monkey-patch check to count calls
    const originalCheck = monitor.check.bind(monitor)
    monitor.check = async () => {
      checkCount++
      return originalCheck()
    }

    monitor.start(50)
    await Bun.sleep(180)
    monitor.stop()

    const countAtStop = checkCount
    expect(countAtStop).toBeGreaterThanOrEqual(2)

    // After stop, no more checks
    await Bun.sleep(100)
    expect(checkCount).toBe(countAtStop)
  })

  it("start is idempotent", () => {
    const deps = createDeps()
    const monitor = new HealthMonitor(deps, () => {})

    monitor.start(30_000)
    monitor.start(30_000) // should not start a second loop

    monitor.stop()
  })

  it("groq check is null when not configured", async () => {
    const deps = createDeps() // no groqApiKey
    const monitor = new HealthMonitor(deps, () => {})

    const status = await monitor.check()
    expect(status.groq).toBeNull()
  })

  it("whisper check is null when not configured", async () => {
    const deps = createDeps() // no whisperModelPath
    const monitor = new HealthMonitor(deps, () => {})

    const status = await monitor.check()
    expect(status.whisper).toBeNull()
  })

  it("memory is reported in MB", async () => {
    const deps = createDeps()
    const monitor = new HealthMonitor(deps, () => {})

    const status = await monitor.check()
    // Memory should be reasonable (1-2048 MB range for a test process)
    expect(status.memoryMb).toBeGreaterThan(0)
    expect(status.memoryMb).toBeLessThan(2048)
  })

  it("uptime reflects botStartedAt", async () => {
    const deps = createDeps({ botStartedAt: Date.now() - 5000 })
    const monitor = new HealthMonitor(deps, () => {})

    const status = await monitor.check()
    expect(status.uptimeMs).toBeGreaterThanOrEqual(5000)
    expect(status.uptimeMs).toBeLessThan(10_000)
  })
})
