import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "../src/db"
import { SessionStore } from "../src/session-store"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

let db: Database
let store: SessionStore
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "synapse-store-"))
  db = new Database(join(tmpDir, "test.db"))
  store = new SessionStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("SessionStore", () => {
  it("starts empty", () => {
    expect(store.size).toBe(0)
  })

  it("set and get", async () => {
    await store.set(111, "sess-aaa")
    expect(store.get(111)).toBe("sess-aaa")
    expect(store.size).toBe(1)
  })

  it("get returns undefined for unknown chatId", () => {
    expect(store.get(99999)).toBeUndefined()
  })

  it("set overwrites existing value", async () => {
    await store.set(111, "sess-aaa")
    await store.set(111, "sess-bbb")
    expect(store.get(111)).toBe("sess-bbb")
    expect(store.size).toBe(1)
  })

  it("delete removes entry", async () => {
    await store.set(111, "sess-aaa")
    await store.delete(111)
    expect(store.get(111)).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it("delete on nonexistent chatId does not throw", async () => {
    await expect(store.delete(99999)).resolves.toBeUndefined()
  })

  it("load populates cache from DB", async () => {
    // Insert directly into DB
    db.setTelegramSession(111, "sess-aaa")
    db.setTelegramSession(222, "sess-bbb")

    // Cache is empty until load
    expect(store.get(111)).toBeUndefined()

    await store.load()
    expect(store.size).toBe(2)
    expect(store.get(111)).toBe("sess-aaa")
    expect(store.get(222)).toBe("sess-bbb")
  })

  it("set persists to DB", async () => {
    await store.set(333, "sess-ccc")

    // Verify directly in DB
    expect(db.getTelegramSession(333)).toBe("sess-ccc")
  })

  it("delete removes from DB", async () => {
    await store.set(333, "sess-ccc")
    await store.delete(333)

    expect(db.getTelegramSession(333)).toBeUndefined()
  })

  it("multiple entries", async () => {
    await store.set(1, "s1")
    await store.set(2, "s2")
    await store.set(3, "s3")

    expect(store.size).toBe(3)
    expect(store.get(1)).toBe("s1")
    expect(store.get(2)).toBe("s2")
    expect(store.get(3)).toBe("s3")
  })
})
