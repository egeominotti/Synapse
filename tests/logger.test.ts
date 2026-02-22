import { describe, it, expect } from "bun:test"
import pino from "pino"

/**
 * Logger tests validate the Pino configuration and API contract.
 * Pino transport writes asynchronously to stderr via worker thread,
 * so we test the logger interface directly rather than capturing output.
 */

describe("Logger", () => {
  it("exports a singleton logger", async () => {
    const { logger } = await import("../src/logger")
    expect(logger).toBeDefined()
    expect(typeof logger.info).toBe("function")
    expect(typeof logger.debug).toBe("function")
    expect(typeof logger.warn).toBe("function")
    expect(typeof logger.error).toBe("function")
  })

  it("setMinLevel does not throw", async () => {
    const { logger } = await import("../src/logger")
    expect(() => logger.setMinLevel("DEBUG")).not.toThrow()
    expect(() => logger.setMinLevel("INFO")).not.toThrow()
    expect(() => logger.setMinLevel("WARN")).not.toThrow()
    expect(() => logger.setMinLevel("ERROR")).not.toThrow()
  })

  it("setSessionId does not throw", async () => {
    const { logger } = await import("../src/logger")
    expect(() => logger.setSessionId("abcdefgh-1234-5678")).not.toThrow()
    expect(() => logger.setSessionId(null)).not.toThrow()
  })

  it("log methods do not throw with meta", async () => {
    const { logger } = await import("../src/logger")
    logger.setMinLevel("DEBUG")
    expect(() => logger.debug("test", { key: "val" })).not.toThrow()
    expect(() => logger.info("test", { num: 42 })).not.toThrow()
    expect(() => logger.warn("test", { arr: [1, 2] })).not.toThrow()
    expect(() => logger.error("test", { nested: { a: 1 } })).not.toThrow()
  })

  it("log methods do not throw without meta", async () => {
    const { logger } = await import("../src/logger")
    expect(() => logger.debug("bare debug")).not.toThrow()
    expect(() => logger.info("bare info")).not.toThrow()
    expect(() => logger.warn("bare warn")).not.toThrow()
    expect(() => logger.error("bare error")).not.toThrow()
  })

  it("pino-pretty is installed", () => {
    // Verify the transport dependency exists
    expect(() => require.resolve("pino-pretty")).not.toThrow()
  })

  it("pino creates valid logger with expected levels", () => {
    const log = pino({ level: "debug" })
    expect(log.level).toBe("debug")
    expect(typeof log.info).toBe("function")
    expect(typeof log.child).toBe("function")
  })

  it("pino child logger inherits level", () => {
    const parent = pino({ level: "warn" })
    const child = parent.child({ sid: "test1234" })
    expect(child.level).toBe("warn")
  })

  it("pino respects level filtering", () => {
    const log = pino({ level: "warn" })
    // isLevelEnabled is the canonical way to test filtering
    expect(log.isLevelEnabled("debug")).toBe(false)
    expect(log.isLevelEnabled("info")).toBe(false)
    expect(log.isLevelEnabled("warn")).toBe(true)
    expect(log.isLevelEnabled("error")).toBe(true)
  })
})
