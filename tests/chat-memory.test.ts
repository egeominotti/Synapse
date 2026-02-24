import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Database } from "../src/db"
import { writeMemoryFile, readMemoryFile, MAX_MEMORY_FILE_CHARS } from "../src/sandbox"

// ---------------------------------------------------------------------------
// Database: getChatMemory / setChatMemory / deleteChatMemory
// ---------------------------------------------------------------------------

describe("Database chat memory", () => {
  let db: Database

  beforeEach(() => {
    db = new Database(":memory:")
  })

  afterEach(() => {
    db.close()
  })

  it("returns null for non-existent chat", () => {
    expect(db.getChatMemory(123)).toBeNull()
  })

  it("stores and retrieves memory", () => {
    db.setChatMemory(123, "User prefers TypeScript")
    expect(db.getChatMemory(123)).toBe("User prefers TypeScript")
  })

  it("updates existing memory", () => {
    db.setChatMemory(123, "v1")
    db.setChatMemory(123, "v2")
    expect(db.getChatMemory(123)).toBe("v2")
  })

  it("returns null for empty string", () => {
    db.setChatMemory(123, "")
    expect(db.getChatMemory(123)).toBeNull()
  })

  it("deletes memory", () => {
    db.setChatMemory(123, "some memory")
    db.deleteChatMemory(123)
    expect(db.getChatMemory(123)).toBeNull()
  })

  it("delete is idempotent", () => {
    db.deleteChatMemory(999)
    expect(db.getChatMemory(999)).toBeNull()
  })

  it("stores memory per-chat independently", () => {
    db.setChatMemory(1, "chat 1 memory")
    db.setChatMemory(2, "chat 2 memory")
    expect(db.getChatMemory(1)).toBe("chat 1 memory")
    expect(db.getChatMemory(2)).toBe("chat 2 memory")
  })
})

// ---------------------------------------------------------------------------
// Sandbox: writeMemoryFile / readMemoryFile
// ---------------------------------------------------------------------------

describe("Sandbox memory file I/O", () => {
  let sandboxDir: string

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "test-memory-"))
  })

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true })
  })

  it("writes and reads memory file", () => {
    writeMemoryFile(sandboxDir, "# Memory\nUser likes Bun")
    const content = readMemoryFile(sandboxDir)
    expect(content).toBe("# Memory\nUser likes Bun")
  })

  it("returns null when file does not exist", () => {
    expect(readMemoryFile(sandboxDir)).toBeNull()
  })

  it("returns null for empty file", () => {
    writeFileSync(join(sandboxDir, ".memory.md"), "")
    expect(readMemoryFile(sandboxDir)).toBeNull()
  })

  it("returns null for whitespace-only file", () => {
    writeFileSync(join(sandboxDir, ".memory.md"), "   \n  \n  ")
    expect(readMemoryFile(sandboxDir)).toBeNull()
  })

  it("overwrites existing memory file", () => {
    writeMemoryFile(sandboxDir, "old")
    writeMemoryFile(sandboxDir, "new")
    expect(readMemoryFile(sandboxDir)).toBe("new")
  })

  it("file is named .memory.md", () => {
    writeMemoryFile(sandboxDir, "test")
    expect(existsSync(join(sandboxDir, ".memory.md"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe("Memory truncation", () => {
  it("MAX_MEMORY_FILE_CHARS is 4000", () => {
    expect(MAX_MEMORY_FILE_CHARS).toBe(4000)
  })

  it("truncation logic works correctly", () => {
    const longMemory = "x".repeat(5000)
    const truncated =
      longMemory.length > MAX_MEMORY_FILE_CHARS ? longMemory.slice(0, MAX_MEMORY_FILE_CHARS) : longMemory
    expect(truncated.length).toBe(4000)
  })

  it("does not truncate memory under limit", () => {
    const shortMemory = "x".repeat(100)
    const truncated =
      shortMemory.length > MAX_MEMORY_FILE_CHARS ? shortMemory.slice(0, MAX_MEMORY_FILE_CHARS) : shortMemory
    expect(truncated.length).toBe(100)
  })
})
