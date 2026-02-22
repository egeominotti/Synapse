import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { logger } from "../src/logger"

// Capture stderr output
let stderrOutput: string
const originalWrite = process.stderr.write

beforeEach(() => {
  stderrOutput = ""
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
    return true
  }
  logger.setMinLevel("DEBUG")
  logger.setSessionId(null)
})

afterEach(() => {
  process.stderr.write = originalWrite
})

describe("Logger", () => {
  it("logs at DEBUG level", () => {
    logger.debug("test debug")
    expect(stderrOutput).toContain("[DEBUG]")
    expect(stderrOutput).toContain("test debug")
  })

  it("logs at INFO level", () => {
    logger.info("test info")
    expect(stderrOutput).toContain("[INFO]")
    expect(stderrOutput).toContain("test info")
  })

  it("logs at WARN level", () => {
    logger.warn("test warn")
    expect(stderrOutput).toContain("[WARN]")
    expect(stderrOutput).toContain("test warn")
  })

  it("logs at ERROR level", () => {
    logger.error("test error")
    expect(stderrOutput).toContain("[ERROR]")
    expect(stderrOutput).toContain("test error")
  })

  it("includes metadata as JSON", () => {
    logger.info("with meta", { key: "value", count: 42 })
    expect(stderrOutput).toContain('"key":"value"')
    expect(stderrOutput).toContain('"count":42')
  })

  it("includes ISO timestamp", () => {
    logger.info("timestamp test")
    // ISO format like 2024-01-01T00:00:00.000Z
    expect(stderrOutput).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it("respects minLevel — filters out DEBUG when minLevel=INFO", () => {
    logger.setMinLevel("INFO")
    logger.debug("should be hidden")
    expect(stderrOutput).toBe("")

    logger.info("should be visible")
    expect(stderrOutput).toContain("should be visible")
  })

  it("respects minLevel — filters out INFO and DEBUG when minLevel=WARN", () => {
    logger.setMinLevel("WARN")
    logger.debug("hidden debug")
    logger.info("hidden info")
    expect(stderrOutput).toBe("")

    logger.warn("visible warn")
    expect(stderrOutput).toContain("visible warn")
  })

  it("respects minLevel — ERROR only when minLevel=ERROR", () => {
    logger.setMinLevel("ERROR")
    logger.debug("hidden")
    logger.info("hidden")
    logger.warn("hidden")
    expect(stderrOutput).toBe("")

    logger.error("visible error")
    expect(stderrOutput).toContain("visible error")
  })

  it("includes session ID when set", () => {
    logger.setSessionId("abcdefgh-1234-5678")
    logger.info("session test")
    expect(stderrOutput).toContain("[sid:abcdefgh]")
  })

  it("omits session ID when null", () => {
    logger.setSessionId(null)
    logger.info("no session")
    expect(stderrOutput).not.toContain("[sid:")
  })
})
