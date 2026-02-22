import { describe, it, expect } from "bun:test"
import { formatDuration } from "../src/utils"

describe("formatDuration", () => {
  it("formats milliseconds below 1 second", () => {
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(1)).toBe("1ms")
    expect(formatDuration(500)).toBe("500ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  it("formats seconds (1s - 59s)", () => {
    expect(formatDuration(1000)).toBe("1.0s")
    expect(formatDuration(1500)).toBe("1.5s")
    expect(formatDuration(30000)).toBe("30.0s")
    expect(formatDuration(59999)).toBe("60.0s")
  })

  it("formats minutes", () => {
    expect(formatDuration(60000)).toBe("1m 0s")
    expect(formatDuration(90000)).toBe("1m 30s")
    expect(formatDuration(150000)).toBe("2m 30s")
    expect(formatDuration(3600000)).toBe("60m 0s")
  })
})
