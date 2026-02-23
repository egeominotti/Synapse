import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "../src/db"
import { HistoryManager } from "../src/history"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

let db: Database
let history: HistoryManager
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "synapse-hist-"))
  db = new Database(join(tmpDir, "test.db"))
  history = new HistoryManager(db)
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("HistoryManager", () => {
  it("initSession creates session in DB", () => {
    history.initSession("hist-001")
    expect(history.getCurrentSessionId()).toBe("hist-001")
    expect(db.getSession("hist-001")).not.toBeNull()
  })

  it("addMessage stores message and updates stats", async () => {
    history.initSession("hist-002")
    await history.addMessage({
      timestamp: "2024-01-01T00:00:00Z",
      prompt: "hello",
      response: "world",
      durationMs: 150,
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
    })

    const messages = history.getRecentMessages(10)
    expect(messages).toHaveLength(1)
    expect(messages[0].prompt).toBe("hello")
    expect(messages[0].response).toBe("world")
    expect(messages[0].durationMs).toBe(150)
    expect(messages[0].tokenUsage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  it("addMessage without session is a no-op", async () => {
    // No initSession called
    await history.addMessage({
      timestamp: "2024-01-01T00:00:00Z",
      prompt: "hello",
      response: "world",
      durationMs: 100,
      tokenUsage: null,
    })
    // Should not throw, should not crash
    expect(history.getCurrentSessionId()).toBeNull()
  })

  it("addMessage with null tokenUsage stores zeros", async () => {
    history.initSession("hist-003")
    await history.addMessage({
      timestamp: "2024-01-01T00:00:00Z",
      prompt: "q",
      response: "a",
      durationMs: 50,
      tokenUsage: null,
    })

    const messages = history.getRecentMessages(10)
    expect(messages).toHaveLength(1)
    expect(messages[0].tokenUsage).toBeNull()
  })

  it("getStats returns correct aggregates", async () => {
    history.initSession("hist-stats")
    await history.addMessage({
      timestamp: "2024-01-01T00:00:00Z",
      prompt: "q1",
      response: "a1",
      durationMs: 100,
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
    })
    await history.addMessage({
      timestamp: "2024-01-01T00:01:00Z",
      prompt: "q2",
      response: "a2",
      durationMs: 200,
      tokenUsage: { inputTokens: 30, outputTokens: 40 },
    })

    const stats = history.getStats()
    expect(stats).not.toBeNull()
    expect(stats!.totalMessages).toBe(2)
    expect(stats!.totalDurationMs).toBe(300)
    expect(stats!.totalInputTokens).toBe(40)
    expect(stats!.totalOutputTokens).toBe(60)
  })

  it("getStats without session returns null", () => {
    expect(history.getStats()).toBeNull()
  })

  it("getRecentMessages returns last N messages in order", async () => {
    history.initSession("hist-recent")
    for (let i = 1; i <= 10; i++) {
      await history.addMessage({
        timestamp: `2024-01-01T00:${String(i).padStart(2, "0")}:00Z`,
        prompt: `q${i}`,
        response: `a${i}`,
        durationMs: i * 10,
        tokenUsage: { inputTokens: i, outputTokens: i },
      })
    }

    const recent = history.getRecentMessages(3)
    expect(recent).toHaveLength(3)
    expect(recent[0].prompt).toBe("q8")
    expect(recent[1].prompt).toBe("q9")
    expect(recent[2].prompt).toBe("q10")
  })

  it("getRecentMessages without session returns empty", () => {
    expect(history.getRecentMessages(5)).toEqual([])
  })

  it("listSessions returns all sessions", async () => {
    history.initSession("hist-list-1")
    await history.addMessage({
      timestamp: "2024-01-01T00:00:00Z",
      prompt: "q",
      response: "a",
      durationMs: 50,
      tokenUsage: null,
    })
    history.initSession("hist-list-2")

    const sessions = await history.listSessions()
    expect(sessions.length).toBeGreaterThanOrEqual(2)
  })

  it("loadSession exact match", async () => {
    history.initSession("hist-load-exact")
    await history.addMessage({
      timestamp: "2024-01-01T00:00:00Z",
      prompt: "hello",
      response: "world",
      durationMs: 100,
      tokenUsage: { inputTokens: 5, outputTokens: 10 },
    })

    // Reset so we can reload
    history.reset()
    expect(history.getCurrentSessionId()).toBeNull()

    const session = await history.loadSession("hist-load-exact")
    expect(session).not.toBeNull()
    expect(session!.sessionId).toBe("hist-load-exact")
    expect(session!.messages).toHaveLength(1)
    expect(session!.messages[0].prompt).toBe("hello")
    expect(session!.stats.totalMessages).toBe(1)
    expect(history.getCurrentSessionId()).toBe("hist-load-exact")
  })

  it("loadSession partial match", async () => {
    history.initSession("hist-partial-unique-xyz")
    await history.addMessage({
      timestamp: "2024-01-01T00:00:00Z",
      prompt: "q",
      response: "a",
      durationMs: 50,
      tokenUsage: null,
    })

    history.reset()
    const session = await history.loadSession("hist-partial-unique")
    expect(session).not.toBeNull()
    expect(session!.sessionId).toBe("hist-partial-unique-xyz")
  })

  it("loadSession not found returns null", async () => {
    const session = await history.loadSession("nonexistent-session-id")
    expect(session).toBeNull()
  })

  it("reset clears currentSessionId", () => {
    history.initSession("hist-reset")
    expect(history.getCurrentSessionId()).toBe("hist-reset")
    history.reset()
    expect(history.getCurrentSessionId()).toBeNull()
  })

  it("persist is a no-op and does not throw", async () => {
    await expect(history.persist()).resolves.toBeUndefined()
  })

  it("shutdown is a no-op and does not throw", async () => {
    await expect(history.shutdown()).resolves.toBeUndefined()
  })
})
