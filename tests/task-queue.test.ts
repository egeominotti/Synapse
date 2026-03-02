/**
 * Tests for TaskQueue — bunqueue-backed subtask distribution for auto-team.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { TaskQueue } from "../src/task-queue"
import type { AcquireResult } from "../src/agent-pool"
import type { SubTask, AgentCallResult } from "../src/types"
import type { TeamProgress } from "../src/orchestrator"
import type { AgentIdentity } from "../src/agent-identity"

// Shared temp dir for bunqueue SQLite — avoids cleanup races
let tempDir: string
beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "synapse-tq-"))
  process.env.DATA_PATH = join(tempDir, "bunqueue.db")
})
afterAll(async () => {
  await Bun.sleep(200)
  rmSync(tempDir, { recursive: true, force: true })
})

/** Create a mock AcquireResult with a fake agent that returns the given text */
function mockAgent(text: string, delayMs = 0): AcquireResult {
  const identity: AgentIdentity = { name: `Agent-${text}`, code: "TST-01", emoji: "◎" }
  return {
    agent: {
      call: async () => {
        if (delayMs > 0) await Bun.sleep(delayMs)
        return { text, sessionId: null, tokenUsage: null, durationMs: delayMs } as AgentCallResult
      },
    } as any,
    isOverflow: false,
    identity,
  }
}

/** Create a mock agent that throws an error */
function mockFailAgent(errorMsg: string): AcquireResult {
  const identity: AgentIdentity = { name: `Agent-fail`, code: "ERR-01", emoji: "✗" }
  return {
    agent: {
      call: async () => {
        throw new Error(errorMsg)
      },
    } as any,
    isOverflow: false,
    identity,
  }
}

describe("TaskQueue", () => {
  test("throws if not started", async () => {
    const tq = new TaskQueue()
    const subtasks: SubTask[] = [{ task: "test" }]
    const agents = [mockAgent("result")]
    expect(() => tq.executeBatch(subtasks, agents, 1, () => {})).toThrow("not started")
  })

  test("executes batch of subtasks and collects results", async () => {
    const tq = new TaskQueue()
    tq.start()

    try {
      const subtasks: SubTask[] = [{ task: "task-a" }, { task: "task-b" }, { task: "task-c" }]
      const agents = [mockAgent("result-a"), mockAgent("result-b"), mockAgent("result-c")]

      const results = await tq.executeBatch(subtasks, agents, 100, () => {})

      expect(results).toHaveLength(3)
      expect(results[0].result?.text).toBe("result-a")
      expect(results[1].result?.text).toBe("result-b")
      expect(results[2].result?.text).toBe("result-c")
      expect(results[0].error).toBeNull()
      expect(results[1].error).toBeNull()
      expect(results[2].error).toBeNull()
      // Results ordered by index
      expect(results[0].subtask).toBe("task-a")
      expect(results[1].subtask).toBe("task-b")
      expect(results[2].subtask).toBe("task-c")
    } finally {
      await tq.stop()
    }
  })

  test("fires onProgress per subtask completion", async () => {
    const tq = new TaskQueue()
    tq.start()

    try {
      const subtasks: SubTask[] = [{ task: "fast" }, { task: "slow" }]
      const agents = [mockAgent("fast-result", 10), mockAgent("slow-result", 50)]

      const progress: TeamProgress[] = []
      await tq.executeBatch(subtasks, agents, 200, (p) => progress.push(p))

      expect(progress).toHaveLength(2)
      // Both should have results (order may vary due to timing)
      const names = progress.map((p) => p.identity.name).sort()
      expect(names).toEqual(["Agent-fast-result", "Agent-slow-result"])
    } finally {
      await tq.stop()
    }
  })

  test("captures errors without crashing batch", async () => {
    const tq = new TaskQueue()
    tq.start()

    try {
      const subtasks: SubTask[] = [{ task: "ok-task" }, { task: "bad-task" }]
      const agents = [mockAgent("success"), mockFailAgent("boom")]

      const results = await tq.executeBatch(subtasks, agents, 300, () => {})

      expect(results).toHaveLength(2)
      // First should succeed
      expect(results[0].result?.text).toBe("success")
      expect(results[0].error).toBeNull()
      // Second should fail
      expect(results[1].result).toBeNull()
      expect(results[1].error).toBe("boom")
    } finally {
      await tq.stop()
    }
  })

  test("resolves only when all subtasks complete", async () => {
    const tq = new TaskQueue()
    tq.start()

    try {
      const subtasks: SubTask[] = [{ task: "instant" }, { task: "delayed" }]
      const agents = [mockAgent("fast", 0), mockAgent("slow", 200)]

      const start = performance.now()
      const results = await tq.executeBatch(subtasks, agents, 400, () => {})
      const elapsed = performance.now() - start

      // Should have waited for the slow agent
      expect(elapsed).toBeGreaterThan(150)
      expect(results).toHaveLength(2)
      expect(results[0].result?.text).toBe("fast")
      expect(results[1].result?.text).toBe("slow")
    } finally {
      await tq.stop()
    }
  })
})
