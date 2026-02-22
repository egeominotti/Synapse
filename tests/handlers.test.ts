import { describe, it, expect } from "bun:test"
import { parseFreetextSchedule } from "../src/telegram/handlers"

// ---------------------------------------------------------------------------
// parseFreetextSchedule
// ---------------------------------------------------------------------------

describe("parseFreetextSchedule", () => {
  // --- Valid patterns ---

  it('detects "every 30s say hello"', () => {
    const result = parseFreetextSchedule("every 30s say hello")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("every 30s")
    expect(result!.prompt).toBe("say hello")
  })

  it('detects "every 5m check status"', () => {
    const result = parseFreetextSchedule("every 5m check status")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("every 5m")
    expect(result!.prompt).toBe("check status")
  })

  it('detects "every 2h send report"', () => {
    const result = parseFreetextSchedule("every 2h send report")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("every 2h")
    expect(result!.prompt).toBe("send report")
  })

  it('detects "in 10m remind me to call"', () => {
    const result = parseFreetextSchedule("in 10m remind me to call")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("in 10m")
    expect(result!.prompt).toBe("remind me to call")
  })

  it('detects "in 30m check the server"', () => {
    const result = parseFreetextSchedule("in 30m check the server")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("in 30m")
    expect(result!.prompt).toBe("check the server")
  })

  it('detects "in 10s ping"', () => {
    const result = parseFreetextSchedule("in 10s ping")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("in 10s")
    expect(result!.prompt).toBe("ping")
  })

  it('detects "at 18:00 remind me about the meeting"', () => {
    const result = parseFreetextSchedule("at 18:00 remind me about the meeting")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("at 18:00")
    expect(result!.prompt).toBe("remind me about the meeting")
  })

  it('detects "at 09:30 good morning"', () => {
    const result = parseFreetextSchedule("at 09:30 good morning")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("at 09:30")
    expect(result!.prompt).toBe("good morning")
  })

  it('detects "every 18:00 give me the report"', () => {
    const result = parseFreetextSchedule("every 18:00 give me the report")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("every 18:00")
    expect(result!.prompt).toBe("give me the report")
  })

  it("preserves full prompt after schedule expression", () => {
    const result = parseFreetextSchedule("every 1h tell me the time and the current weather in Rome")
    expect(result).not.toBeNull()
    expect(result!.prompt).toBe("tell me the time and the current weather in Rome")
  })

  // --- Invalid / rejected patterns ---

  it("returns null for plain text (no schedule)", () => {
    expect(parseFreetextSchedule("say hello")).toBeNull()
  })

  it("returns null for schedule expression without prompt", () => {
    expect(parseFreetextSchedule("every 30s")).toBeNull()
    expect(parseFreetextSchedule("in 5m")).toBeNull()
    expect(parseFreetextSchedule("at 18:00")).toBeNull()
  })

  it("returns null for invalid schedule (below minimum interval)", () => {
    // "every 10s" is below the 30s minimum — parseSchedule will throw
    expect(parseFreetextSchedule("every 10s do something")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(parseFreetextSchedule("")).toBeNull()
  })

  it("returns null for unrelated text starting with numbers", () => {
    expect(parseFreetextSchedule("30 minutes ago I had lunch")).toBeNull()
  })

  it("is case insensitive for schedule keywords", () => {
    const result = parseFreetextSchedule("EVERY 30s say hello")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("EVERY 30s")
  })
})
