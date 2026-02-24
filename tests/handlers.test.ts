import { describe, it, expect } from "bun:test"
import { buildMeta, formatTokenCount, friendlyError } from "../src/telegram/handlers"
import type { AgentCallResult } from "../src/types"

function mockResult(overrides: Partial<AgentCallResult> & { durationMs: number }): AgentCallResult {
  return { text: "", sessionId: null, tokenUsage: null, ...overrides }
}

// ---------------------------------------------------------------------------
// formatTokenCount
// ---------------------------------------------------------------------------

describe("formatTokenCount", () => {
  it("returns raw number for values under 1000", () => {
    expect(formatTokenCount(0)).toBe("0")
    expect(formatTokenCount(1)).toBe("1")
    expect(formatTokenCount(999)).toBe("999")
  })

  it("formats thousands with k suffix", () => {
    expect(formatTokenCount(1000)).toBe("1.0k")
    expect(formatTokenCount(1234)).toBe("1.2k")
    expect(formatTokenCount(15600)).toBe("15.6k")
    expect(formatTokenCount(999999)).toBe("1000.0k")
  })

  it("formats millions with M suffix", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M")
    expect(formatTokenCount(2_500_000)).toBe("2.5M")
  })
})

// ---------------------------------------------------------------------------
// buildMeta
// ---------------------------------------------------------------------------

describe("buildMeta", () => {
  it("shows only duration when no token usage", () => {
    const result = buildMeta(mockResult({ durationMs: 2100 }))
    expect(result).toBe("⏱ 2.1s")
  })

  it("shows duration and combined token count", () => {
    const result = buildMeta(mockResult({ durationMs: 3200, tokenUsage: { inputTokens: 500, outputTokens: 700 } }))
    expect(result).toBe("⏱ 3.2s  ·  ~1.2k tokens")
  })

  it("shows raw token count for small values", () => {
    const result = buildMeta(mockResult({ durationMs: 1000, tokenUsage: { inputTokens: 100, outputTokens: 50 } }))
    expect(result).toBe("⏱ 1.0s  ·  ~150 tokens")
  })

  it("omits tokens when total is 0", () => {
    const result = buildMeta(mockResult({ durationMs: 500, tokenUsage: { inputTokens: 0, outputTokens: 0 } }))
    expect(result).toBe("⏱ 0.5s")
  })
})

// ---------------------------------------------------------------------------
// friendlyError
// ---------------------------------------------------------------------------

describe("friendlyError", () => {
  it("maps 429 to rate limit message", () => {
    expect(friendlyError("Error: 429 Too Many Requests")).toBe("Too many requests. Please wait a moment and try again.")
  })

  it("maps rate limit text", () => {
    expect(friendlyError("rate limit exceeded")).toBe("Too many requests. Please wait a moment and try again.")
  })

  it("maps ECONNRESET to connection message", () => {
    expect(friendlyError("ECONNRESET: Connection reset by peer")).toBe("Connection interrupted. Please try again.")
  })

  it("maps ECONNREFUSED", () => {
    expect(friendlyError("connect ECONNREFUSED 127.0.0.1:443")).toBe("Connection interrupted. Please try again.")
  })

  it("maps socket hang up", () => {
    expect(friendlyError("socket hang up")).toBe("Connection interrupted. Please try again.")
  })

  it("maps ETIMEDOUT to network message", () => {
    expect(friendlyError("connect ETIMEDOUT")).toBe("Network issue. Please try again shortly.")
  })

  it("maps timeout to timeout message", () => {
    expect(friendlyError("Timeout: Claude did not respond within 30000ms")).toBe(
      "Response took too long. Try a shorter request."
    )
  })

  it("maps invalid session to session expired", () => {
    expect(friendlyError("invalid session id: abc123")).toBe("Session expired. Starting a fresh conversation...")
  })

  it("maps could not resume", () => {
    expect(friendlyError("Could not resume session")).toBe("Session expired. Starting a fresh conversation...")
  })

  it("maps 503 to unavailable", () => {
    expect(friendlyError("503 Service Unavailable")).toBe("Claude is temporarily unavailable. Retrying...")
  })

  it("maps 502 to unavailable", () => {
    expect(friendlyError("502 Bad Gateway")).toBe("Claude is temporarily unavailable. Retrying...")
  })

  it("passes through short unknown errors", () => {
    expect(friendlyError("Something weird happened")).toBe("Something weird happened")
  })

  it("truncates long unknown errors to 120 chars", () => {
    const longMsg = "A".repeat(200)
    const result = friendlyError(longMsg)
    expect(result.length).toBe(120)
    expect(result.endsWith("...")).toBe(true)
  })
})
