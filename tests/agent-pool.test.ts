import { describe, it, expect } from "bun:test"
import { AgentPool } from "../src/agent-pool"
import { Agent } from "../src/agent"
import { Database } from "../src/db"
import { ORCHESTRATOR_IDENTITY } from "../src/agent-identity"
import type { AgentConfig } from "../src/types"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function createTestConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    token: "test-token",
    timeoutMs: 0,
    maxRetries: 0,
    initialRetryDelayMs: 1000,
    dbPath: "",
    skipPermissions: true,
    useDocker: false,
    dockerImage: "claude-agent:latest",
    maxConcurrentPerChat: 3,
    ...overrides,
  }
}

function createTestDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "pool-test-"))
  return new Database(join(dir, "test.db"))
}

describe("AgentPool", () => {
  it("pre-creates all worker agents at construction", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 4 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    // 4 total = 1 master + 3 workers
    expect(pool.workerCount).toBe(3)
  })

  it("acquire returns master with ORCHESTRATOR identity when not busy", () => {
    const config = createTestConfig()
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    const { agent, isOverflow, identity } = pool.acquire()

    expect(agent).toBe(primary)
    expect(isOverflow).toBe(false)
    expect(identity).toEqual(ORCHESTRATOR_IDENTITY)
  })

  it("acquire returns pre-created worker when master is busy", () => {
    const config = createTestConfig()
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    // First acquire gets master
    const first = pool.acquire()
    expect(first.isOverflow).toBe(false)
    expect(first.identity.name).toBe("Neo")

    // Second acquire gets a pre-created worker
    const second = pool.acquire()
    expect(second.isOverflow).toBe(true)
    expect(second.agent).not.toBe(primary)
    expect(second.identity.name).not.toBe("Neo")
    expect(second.identity.emoji).toBeTruthy()

    pool.release(second.agent, true)
    pool.release(first.agent, false)
  })

  it("each worker has a different identity", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 4 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    pool.acquire() // master = Neo
    const w1 = pool.acquire()
    const w2 = pool.acquire()
    const w3 = pool.acquire() // all 3 workers used

    expect(w1.identity.name).not.toBe("Neo")
    expect(w2.identity.name).not.toBe("Neo")
    expect(w3.identity.name).not.toBe("Neo")
    expect(w1.identity.name).not.toBe(w2.identity.name)
    expect(w1.identity.name).not.toBe(w3.identity.name)
    expect(w2.identity.name).not.toBe(w3.identity.name)

    pool.release(w3.agent, true)
    pool.release(w2.agent, true)
    pool.release(w1.agent, true)
  })

  it("release makes master available again", () => {
    const config = createTestConfig()
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    const first = pool.acquire()
    pool.release(first.agent, false)

    const second = pool.acquire()
    expect(second.agent).toBe(primary)
    expect(second.isOverflow).toBe(false)

    pool.release(second.agent, false)
  })

  it("release makes worker reusable", () => {
    const config = createTestConfig()
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    pool.acquire() // master
    const worker1 = pool.acquire() // worker
    const workerAgent = worker1.agent
    pool.release(worker1.agent, true)

    // Same worker should be reusable
    const worker2 = pool.acquire()
    expect(worker2.agent).toBe(workerAgent)

    pool.release(worker2.agent, true)
  })

  it("getPrimary returns the master agent", () => {
    const config = createTestConfig()
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    expect(pool.getPrimary()).toBe(primary)
  })

  it("setPrimary replaces the master agent", () => {
    const config = createTestConfig()
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    const newPrimary = new Agent(config)
    pool.setPrimary(newPrimary)
    expect(pool.getPrimary()).toBe(newPrimary)

    const { agent, isOverflow } = pool.acquire()
    expect(agent).toBe(newPrimary)
    expect(isOverflow).toBe(false)

    pool.release(agent, false)
  })

  it("cleanup cleans up all agents", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 4 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    expect(pool.workerCount).toBe(3)

    pool.cleanup()
    expect(pool.workerCount).toBe(0)
  })

  it("getIdentities returns all identities in order", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 3 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    const identities = pool.getIdentities()
    expect(identities.length).toBe(3)
    expect(identities[0]).toEqual(ORCHESTRATOR_IDENTITY)
    expect(identities[1].name).not.toBe("Neo")
    expect(identities[2].name).not.toBe("Neo")
  })

  it("maxConcurrentPerChat=1 creates no workers", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 1 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    expect(pool.workerCount).toBe(0)

    const { agent, isOverflow } = pool.acquire()
    expect(agent).toBe(primary)
    expect(isOverflow).toBe(false)

    pool.release(agent, false)
  })
})
