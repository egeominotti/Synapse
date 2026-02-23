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
    collaboration: true,
    maxTeamAgents: 20,
    ...overrides,
  }
}

function createTestDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "pool-test-"))
  return new Database(join(dir, "test.db"))
}

describe("AgentPool", () => {
  it("starts with zero workers (lazy init)", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 4 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    expect(pool.workerCount).toBe(0)
    expect(pool.maxWorkerCapacity).toBe(3)
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

  it("acquire creates worker lazily when master is busy", () => {
    const config = createTestConfig()
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    expect(pool.workerCount).toBe(0)

    // First acquire gets master
    const first = pool.acquire()
    expect(first.isOverflow).toBe(false)
    expect(first.identity.name).toBe("Neo")

    // Second acquire creates a worker lazily
    const second = pool.acquire()
    expect(second.isOverflow).toBe(false) // lazy-created, not overflow
    expect(second.agent).not.toBe(primary)
    expect(second.identity.name).not.toBe("Neo")
    expect(second.identity.emoji).toBeTruthy()
    expect(pool.workerCount).toBe(1) // one worker created

    pool.release(second.agent, false)
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
    const w3 = pool.acquire() // all 3 workers created lazily

    expect(pool.workerCount).toBe(3)
    expect(w1.identity.name).not.toBe("Neo")
    expect(w2.identity.name).not.toBe("Neo")
    expect(w3.identity.name).not.toBe("Neo")
    expect(w1.identity.name).not.toBe(w2.identity.name)
    expect(w1.identity.name).not.toBe(w3.identity.name)
    expect(w2.identity.name).not.toBe(w3.identity.name)

    pool.release(w3.agent, false)
    pool.release(w2.agent, false)
    pool.release(w1.agent, false)
  })

  it("creates overflow when all slots are full", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 2 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    const master = pool.acquire() // master
    const worker = pool.acquire() // lazy worker (1 max)
    expect(worker.isOverflow).toBe(false)

    const overflow = pool.acquire() // overflow
    expect(overflow.isOverflow).toBe(true)

    pool.release(overflow.agent, true)
    pool.release(worker.agent, false)
    pool.release(master.agent, false)
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
    const worker1 = pool.acquire() // lazy worker created
    const workerAgent = worker1.agent
    pool.release(worker1.agent, false)

    // Same worker should be reusable
    const worker2 = pool.acquire()
    expect(worker2.agent).toBe(workerAgent)
    expect(pool.workerCount).toBe(1) // still just 1 worker

    pool.release(worker2.agent, false)
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

  it("cleanup cleans up all agents including lazy-created workers", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 4 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    // Create some workers by acquiring
    pool.acquire() // master
    pool.acquire() // worker 1
    pool.acquire() // worker 2
    expect(pool.workerCount).toBe(2)

    pool.cleanup()
    expect(pool.workerCount).toBe(0)
  })

  it("getIdentities returns all potential identities (not just created)", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 3 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    expect(pool.workerCount).toBe(0) // no workers yet
    const identities = pool.getIdentities()
    expect(identities.length).toBe(3) // but shows all potential
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
    expect(pool.maxWorkerCapacity).toBe(0)

    const { agent, isOverflow } = pool.acquire()
    expect(agent).toBe(primary)
    expect(isOverflow).toBe(false)

    pool.release(agent, false)
  })

  it("overflow agents get unique identities via counter", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 2 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    pool.acquire() // master
    pool.acquire() // worker (1 max)
    const ov1 = pool.acquire() // overflow 1
    const ov2 = pool.acquire() // overflow 2

    expect(ov1.isOverflow).toBe(true)
    expect(ov2.isOverflow).toBe(true)
    expect(ov1.identity.name).not.toBe(ov2.identity.name)

    pool.release(ov2.agent, true)
    pool.release(ov1.agent, true)
  })
})

// ---------------------------------------------------------------------------
// acquireMultiple / releaseMultiple — team parallel acquisition
// ---------------------------------------------------------------------------

describe("AgentPool acquireMultiple", () => {
  it("acquires N workers lazily (never master)", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 5 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    const workers = pool.acquireMultiple(3)

    expect(workers).toHaveLength(3)
    // Never acquires master
    for (const w of workers) {
      expect(w.agent).not.toBe(primary)
      expect(w.isOverflow).toBe(false)
      expect(w.identity.name).not.toBe("Neo")
    }
    expect(pool.workerCount).toBe(3)

    pool.releaseMultiple(workers)
  })

  it("reuses free workers before creating new ones", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 5 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    // Create and release 2 workers
    const first = pool.acquireMultiple(2)
    const existingAgents = first.map((w) => w.agent)
    pool.releaseMultiple(first)

    // Acquire 2 again — should reuse the same agents
    const second = pool.acquireMultiple(2)
    expect(second[0].agent).toBe(existingAgents[0])
    expect(second[1].agent).toBe(existingAgents[1])
    expect(pool.workerCount).toBe(2) // no new workers created

    pool.releaseMultiple(second)
  })

  it("creates overflow when pool is at max capacity", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 3 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    // Max workers = 2, acquire 3 → 2 lazy + 1 overflow
    const workers = pool.acquireMultiple(3)

    expect(workers).toHaveLength(3)
    expect(workers[0].isOverflow).toBe(false)
    expect(workers[1].isOverflow).toBe(false)
    expect(workers[2].isOverflow).toBe(true)
    expect(pool.workerCount).toBe(2) // only 2 permanent workers

    pool.releaseMultiple(workers)
  })

  it("each acquired worker has unique identity", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 5 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    const workers = pool.acquireMultiple(4)
    const names = workers.map((w) => w.identity.name)
    const uniqueNames = new Set(names)
    expect(uniqueNames.size).toBe(4)

    pool.releaseMultiple(workers)
  })

  it("releaseMultiple returns workers to pool and destroys overflow", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 3 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    const workers = pool.acquireMultiple(3) // 2 workers + 1 overflow
    pool.releaseMultiple(workers)

    // Workers should be reusable
    const again = pool.acquireMultiple(2)
    expect(again[0].isOverflow).toBe(false)
    expect(again[1].isOverflow).toBe(false)
    expect(pool.workerCount).toBe(2) // same 2 workers, no growth

    pool.releaseMultiple(again)
  })

  it("overflow identities don't collide with workers in acquireMultiple", () => {
    const config = createTestConfig({ maxConcurrentPerChat: 2 })
    const db = createTestDb()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    // Max workers = 1, acquire 3 → 1 worker + 2 overflow
    const workers = pool.acquireMultiple(3)
    const names = workers.map((w) => w.identity.name)
    const uniqueNames = new Set(names)
    expect(uniqueNames.size).toBe(3) // all unique

    pool.releaseMultiple(workers)
  })
})

// ---------------------------------------------------------------------------
// Master / Worker configuration
// ---------------------------------------------------------------------------

describe("AgentPool agent configuration", () => {
  it("master agent has disableTools=true and effort=high", () => {
    const db = createTestDb()
    const config = createTestConfig()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    const { agent } = pool.acquire()
    expect(agent.disableTools).toBe(true)
    expect(agent.effort).toBe("high")
    expect(agent.allowedTools).toBeNull()
    expect(agent.workerMode).toBe(false)

    pool.release(agent, false)
    pool.cleanup()
  })

  it("worker agents have disableTools and workerMode set", () => {
    const db = createTestDb()
    const config = createTestConfig()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    // Acquire master first to make it busy
    const master = pool.acquire()

    // Next acquire creates a worker
    const worker = pool.acquire()
    expect(worker.agent.disableTools).toBe(true)
    expect(worker.agent.workerMode).toBe(true)
    expect(worker.agent.effort).toBeNull()

    pool.release(worker.agent, worker.isOverflow)
    pool.release(master.agent, master.isOverflow)
    pool.cleanup()
  })

  it("setPrimary preserves master configuration", () => {
    const db = createTestDb()
    const config = createTestConfig()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    const newMaster = new Agent(config)
    pool.setPrimary(newMaster)

    const { agent } = pool.acquire()
    expect(agent.disableTools).toBe(true)
    expect(agent.effort).toBe("high")

    pool.release(agent, false)
    pool.cleanup()
  })

  it("acquireMultiple creates workers with correct configuration", () => {
    const db = createTestDb()
    const config = createTestConfig()
    const primary = new Agent(config)
    const pool = new AgentPool(1, primary, config, db)

    const workers = pool.acquireMultiple(2)
    for (const w of workers) {
      expect(w.agent.disableTools).toBe(true)
      expect(w.agent.workerMode).toBe(true)
    }

    pool.releaseMultiple(workers)
    pool.cleanup()
  })
})
