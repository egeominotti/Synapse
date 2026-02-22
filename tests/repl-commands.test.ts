import { describe, it, expect } from "bun:test"
import { join } from "path"
import { writeFileSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { parseImageArgs, writeMeta, printBanner, printHelp, printHistory, printStats } from "../src/repl-commands"
import type { SlashCommand } from "../src/types"

// ---------------------------------------------------------------------------
// parseImageArgs
// ---------------------------------------------------------------------------

describe("parseImageArgs", () => {
  it("returns null for empty string", () => {
    expect(parseImageArgs("")).toBeNull()
  })

  it("returns null for non-existent file", () => {
    expect(parseImageArgs("/tmp/does-not-exist-abc123.png")).toBeNull()
  })

  it("parses path-only argument", () => {
    const dir = mkdtempSync(join(tmpdir(), "repl-test-"))
    const file = join(dir, "test.png")
    writeFileSync(file, "fake image")

    const result = parseImageArgs(file)
    expect(result).not.toBeNull()
    expect(result!.imagePath).toBe(file)
    expect(result!.prompt).toBe("")

    rmSync(dir, { recursive: true })
  })

  it("parses path + prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "repl-test-"))
    const file = join(dir, "photo.jpg")
    writeFileSync(file, "fake image")

    const result = parseImageArgs(`${file} describe this image`)
    expect(result).not.toBeNull()
    expect(result!.imagePath).toBe(file)
    expect(result!.prompt).toBe("describe this image")

    rmSync(dir, { recursive: true })
  })
})

// ---------------------------------------------------------------------------
// writeMeta
// ---------------------------------------------------------------------------

describe("writeMeta", () => {
  it("outputs duration", () => {
    let output = ""
    writeMeta(null, 1234, null, (t) => {
      output += t
    })
    expect(output).toContain("1234ms")
  })

  it("outputs session ID prefix", () => {
    let output = ""
    writeMeta("abcdefghijklmnop", 100, null, (t) => {
      output += t
    })
    expect(output).toContain("abcdefgh...")
  })

  it("outputs token usage", () => {
    let output = ""
    writeMeta(null, 100, { inputTokens: 50, outputTokens: 200 }, (t) => {
      output += t
    })
    expect(output).toContain("50in")
    expect(output).toContain("200out")
  })
})

// ---------------------------------------------------------------------------
// printBanner
// ---------------------------------------------------------------------------

describe("printBanner", () => {
  it("outputs banner text", () => {
    let output = ""
    printBanner((t) => {
      output += t
    })
    expect(output).toContain("Claude Agent")
    expect(output).toContain("/help")
  })
})

// ---------------------------------------------------------------------------
// printHelp
// ---------------------------------------------------------------------------

describe("printHelp", () => {
  it("lists all commands sorted", () => {
    const commands = new Map<string, SlashCommand>()
    commands.set("help", { name: "help", description: "Show help", handler: async () => true })
    commands.set("exit", { name: "exit", description: "Quit", handler: async () => true })

    let output = ""
    printHelp(commands, (t) => {
      output += t
    })

    expect(output).toContain("/exit")
    expect(output).toContain("/help")
    // exit should come before help (sorted)
    expect(output.indexOf("/exit")).toBeLessThan(output.indexOf("/help"))
  })
})

// ---------------------------------------------------------------------------
// printHistory (with mock HistoryManager)
// ---------------------------------------------------------------------------

describe("printHistory", () => {
  it("shows empty message when no history", () => {
    const mockHistory = {
      getRecentMessages: () => [],
    }
    let output = ""
    printHistory(mockHistory as any, (t) => {
      output += t
    })
    expect(output).toContain("No messages")
  })

  it("shows messages when present", () => {
    const mockHistory = {
      getRecentMessages: () => [
        {
          timestamp: "2025-01-01T12:00:00Z",
          prompt: "Hello",
          response: "Hi there",
          durationMs: 500,
        },
      ],
    }
    let output = ""
    printHistory(mockHistory as any, (t) => {
      output += t
    })
    expect(output).toContain("Hello")
    expect(output).toContain("Hi there")
    expect(output).toContain("500ms")
  })
})

// ---------------------------------------------------------------------------
// printStats (with mock HistoryManager)
// ---------------------------------------------------------------------------

describe("printStats", () => {
  it("shows empty message when no stats", () => {
    const mockHistory = { getStats: () => null }
    let output = ""
    printStats(mockHistory as any, (t) => {
      output += t
    })
    expect(output).toContain("No statistics")
  })

  it("shows stats when present", () => {
    const mockHistory = {
      getStats: () => ({
        totalMessages: 10,
        totalDurationMs: 5000,
        totalInputTokens: 100,
        totalOutputTokens: 200,
      }),
    }
    let output = ""
    printStats(mockHistory as any, (t) => {
      output += t
    })
    expect(output).toContain("10")
    expect(output).toContain("token")
  })
})
