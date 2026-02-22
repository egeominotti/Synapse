import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "../src/db"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

let db: Database
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "neo-test-"))
  db = new Database(join(tmpDir, "test.db"))
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("Database schema", () => {
  it("creates all tables", () => {
    const tables = db.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
      name: string
    }>
    const names = tables.map((t) => t.name)
    expect(names).toContain("sessions")
    expect(names).toContain("messages")
    expect(names).toContain("telegram_sessions")
  })

  it("creates indexes", () => {
    const indexes = db.db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>
    const names = indexes.map((i) => i.name)
    expect(names).toContain("idx_messages_session")
    expect(names).toContain("idx_messages_timestamp")
  })
})

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("Sessions", () => {
  it("upsertSession creates a new session", () => {
    db.upsertSession("sess-001")
    const session = db.getSession("sess-001")
    expect(session).not.toBeNull()
    expect(session!.session_id).toBe("sess-001")
    expect(session!.created_at).toBeTruthy()
  })

  it("upsertSession updates existing session", () => {
    db.upsertSession("sess-001")
    const before = db.getSession("sess-001")!
    // Small delay to ensure different timestamp
    db.upsertSession("sess-001")
    const after = db.getSession("sess-001")!
    expect(after.created_at).toBe(before.created_at)
  })

  it("touchSession updates updated_at", () => {
    db.upsertSession("sess-001")
    db.touchSession("sess-001")
    const after = db.getSession("sess-001")!
    expect(after.updated_at).toBeTruthy()
  })

  it("getSession returns null for nonexistent session", () => {
    expect(db.getSession("nonexistent")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

describe("Messages", () => {
  beforeEach(() => {
    db.upsertSession("sess-msg")
  })

  it("insertMessage and getMessages", () => {
    db.insertMessage("sess-msg", "2024-01-01T00:00:00Z", "hello", "world", 100, 10, 20)
    db.insertMessage("sess-msg", "2024-01-01T00:01:00Z", "foo", "bar", 200, 30, 40)

    const messages = db.getMessages("sess-msg")
    expect(messages).toHaveLength(2)
    expect(messages[0].prompt).toBe("hello")
    expect(messages[1].prompt).toBe("foo")
  })

  it("getMessages returns empty array for no messages", () => {
    expect(db.getMessages("sess-msg")).toHaveLength(0)
  })

  it("getRecentMessages returns last N in order", () => {
    for (let i = 1; i <= 10; i++) {
      db.insertMessage("sess-msg", `2024-01-01T00:${String(i).padStart(2, "0")}:00Z`, `q${i}`, `a${i}`, i * 10, i, i)
    }

    const recent = db.getRecentMessages("sess-msg", 3)
    expect(recent).toHaveLength(3)
    expect(recent[0].prompt).toBe("q8")
    expect(recent[1].prompt).toBe("q9")
    expect(recent[2].prompt).toBe("q10")
  })

  it("getRecentMessages with count larger than total", () => {
    db.insertMessage("sess-msg", "2024-01-01T00:00:00Z", "only", "one", 50, 5, 5)
    const recent = db.getRecentMessages("sess-msg", 100)
    expect(recent).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Session stats
// ---------------------------------------------------------------------------

describe("Session stats", () => {
  it("returns null for empty session", () => {
    db.upsertSession("sess-empty")
    expect(db.getSessionStats("sess-empty")).toBeNull()
  })

  it("computes correct aggregates", () => {
    db.upsertSession("sess-stats")
    db.insertMessage("sess-stats", "2024-01-01T00:00:00Z", "q1", "a1", 100, 10, 20)
    db.insertMessage("sess-stats", "2024-01-01T00:01:00Z", "q2", "a2", 200, 30, 40)

    const stats = db.getSessionStats("sess-stats")
    expect(stats).not.toBeNull()
    expect(stats!.totalMessages).toBe(2)
    expect(stats!.totalDurationMs).toBe(300)
    expect(stats!.totalInputTokens).toBe(40)
    expect(stats!.totalOutputTokens).toBe(60)
  })
})

// ---------------------------------------------------------------------------
// Session listing & search
// ---------------------------------------------------------------------------

describe("Session listing", () => {
  it("listSessions returns sessions sorted by updated_at DESC", () => {
    db.upsertSession("sess-old")
    db.upsertSession("sess-new")
    db.insertMessage("sess-new", "2024-01-01T00:00:00Z", "q", "a", 100, 5, 5)

    const sessions = db.listSessions()
    expect(sessions.length).toBeGreaterThanOrEqual(2)
    expect(sessions[0].sessionId).toBe("sess-new")
    expect(sessions[0].messageCount).toBe(1)
  })

  it("findSessionByPrefix with unique match", () => {
    db.upsertSession("abc-unique-session-123")
    const found = db.findSessionByPrefix("abc-unique")
    expect(found).toBe("abc-unique-session-123")
  })

  it("findSessionByPrefix with multiple matches returns null", () => {
    db.upsertSession("abc-one")
    db.upsertSession("abc-two")
    expect(db.findSessionByPrefix("abc")).toBeNull()
  })

  it("findSessionByPrefix with no match returns null", () => {
    expect(db.findSessionByPrefix("zzz-none")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("Delete session", () => {
  it("deleteSessionMessages removes session and messages", () => {
    db.upsertSession("sess-del")
    db.insertMessage("sess-del", "2024-01-01T00:00:00Z", "q", "a", 100, 5, 5)

    db.deleteSessionMessages("sess-del")
    expect(db.getSession("sess-del")).toBeNull()
    expect(db.getMessages("sess-del")).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Telegram sessions
// ---------------------------------------------------------------------------

describe("Telegram sessions", () => {
  it("set and get telegram session", () => {
    db.setTelegramSession(12345, "sess-tg-1")
    expect(db.getTelegramSession(12345)).toBe("sess-tg-1")
  })

  it("get returns undefined for unknown chat", () => {
    expect(db.getTelegramSession(99999)).toBeUndefined()
  })

  it("set overwrites existing session", () => {
    db.setTelegramSession(12345, "sess-tg-1")
    db.setTelegramSession(12345, "sess-tg-2")
    expect(db.getTelegramSession(12345)).toBe("sess-tg-2")
  })

  it("delete removes telegram session", () => {
    db.setTelegramSession(12345, "sess-tg-1")
    db.deleteTelegramSession(12345)
    expect(db.getTelegramSession(12345)).toBeUndefined()
  })

  it("getAllTelegramSessions returns all entries", () => {
    db.setTelegramSession(111, "s1")
    db.setTelegramSession(222, "s2")
    db.setTelegramSession(333, "s3")

    const all = db.getAllTelegramSessions()
    expect(all).toHaveLength(3)
  })

  it("countTelegramSessions returns correct count", () => {
    expect(db.countTelegramSessions()).toBe(0)
    db.setTelegramSession(111, "s1")
    db.setTelegramSession(222, "s2")
    expect(db.countTelegramSessions()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe("cleanupOldSessions", () => {
  it("deletes sessions older than N days", () => {
    // Insert a session with updated_at 100 days ago
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString()
    db.db.run("INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)", ["old-sess", old, old])
    db.db.run("INSERT INTO messages (session_id, timestamp, prompt, response, duration_ms) VALUES (?, ?, ?, ?, ?)", [
      "old-sess",
      old,
      "hello",
      "world",
      100,
    ])

    // Insert a recent session
    db.upsertSession("recent-sess")
    db.insertMessage("recent-sess", new Date().toISOString(), "hi", "ho", 50, 0, 0)

    const deleted = db.cleanupOldSessions(90)
    expect(deleted).toBe(1)

    // Old session gone
    expect(db.getSession("old-sess")).toBeNull()
    expect(db.getMessages("old-sess")).toEqual([])

    // Recent session intact
    expect(db.getSession("recent-sess")).not.toBeNull()
    expect(db.getMessages("recent-sess").length).toBe(1)
  })

  it("returns 0 when nothing to clean", () => {
    expect(db.cleanupOldSessions(90)).toBe(0)
  })
})

describe("cleanupOrphanTelegramSessions", () => {
  it("deletes telegram sessions with no matching session", () => {
    // Create a valid session + telegram mapping
    db.upsertSession("valid-sess")
    db.setTelegramSession(100, "valid-sess")

    // Insert orphan telegram session (no matching session row)
    db.db.run("INSERT INTO telegram_sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?)", [
      999,
      "ghost-sess",
      new Date().toISOString(),
    ])

    const deleted = db.cleanupOrphanTelegramSessions()
    expect(deleted).toBe(1)

    // Orphan gone
    expect(db.getTelegramSession(999)).toBeUndefined()

    // Valid mapping intact
    expect(db.getTelegramSession(100)).toBe("valid-sess")
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("Lifecycle", () => {
  it("close does not throw", () => {
    expect(() => db.close()).not.toThrow()
  })
})
