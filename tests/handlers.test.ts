import { describe, it, expect } from "bun:test"
import { parseFreetextSchedule } from "../src/telegram/handlers"

// ---------------------------------------------------------------------------
// parseFreetextSchedule
// ---------------------------------------------------------------------------

describe("parseFreetextSchedule", () => {
  // --- Valid patterns ---

  it('detects "ogni 30s dimmi ciao"', () => {
    const result = parseFreetextSchedule("ogni 30s dimmi ciao")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("ogni 30s")
    expect(result!.prompt).toBe("dimmi ciao")
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

  it('normalizes "tra 10m ricordami di chiamare" → "in 10m"', () => {
    const result = parseFreetextSchedule("tra 10m ricordami di chiamare")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("in 10m")
    expect(result!.prompt).toBe("ricordami di chiamare")
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

  it('detects "alle 18:00 ricordami la riunione"', () => {
    const result = parseFreetextSchedule("alle 18:00 ricordami la riunione")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("alle 18:00")
    expect(result!.prompt).toBe("ricordami la riunione")
  })

  it('detects "at 09:30 good morning"', () => {
    const result = parseFreetextSchedule("at 09:30 good morning")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("at 09:30")
    expect(result!.prompt).toBe("good morning")
  })

  it('detects "ogni 18:00 dammi il report"', () => {
    const result = parseFreetextSchedule("ogni 18:00 dammi il report")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("ogni 18:00")
    expect(result!.prompt).toBe("dammi il report")
  })

  it("preserves full prompt after schedule expression", () => {
    const result = parseFreetextSchedule("every 1h dimmi che ore sono e il meteo attuale a Roma")
    expect(result).not.toBeNull()
    expect(result!.prompt).toBe("dimmi che ore sono e il meteo attuale a Roma")
  })

  // --- Invalid / rejected patterns ---

  it("returns null for plain text (no schedule)", () => {
    expect(parseFreetextSchedule("dimmi ciao")).toBeNull()
  })

  it("returns null for schedule expression without prompt", () => {
    expect(parseFreetextSchedule("ogni 30s")).toBeNull()
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
    expect(parseFreetextSchedule("30 minuti fa ho mangiato")).toBeNull()
  })

  it("is case insensitive for schedule keywords", () => {
    const result = parseFreetextSchedule("OGNI 30s dimmi ciao")
    expect(result).not.toBeNull()
    expect(result!.scheduleExpr).toBe("OGNI 30s")
  })
})
