import { describe, it, expect } from "bun:test"
import { existsSync } from "fs"
import { Agent, TimeoutError, isTransientError } from "../src/agent"
import { buildSpawnEnv } from "../src/sandbox"
import type { AgentConfig } from "../src/types"

const baseConfig: AgentConfig = {
  token: "test-token",
  timeoutMs: 5000,
  maxRetries: 3,
  initialRetryDelayMs: 100,
  dbPath: ":memory:",
  skipPermissions: true,
  useDocker: false,
  dockerImage: "test:latest",
  systemPrompt: undefined,
  maxConcurrentPerChat: 1,
  collaboration: true,
  maxTeamAgents: 20,
}

// ---------------------------------------------------------------------------
// TimeoutError
// ---------------------------------------------------------------------------

describe("TimeoutError", () => {
  it("has correct properties", () => {
    const err = new TimeoutError(5000)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(TimeoutError)
    expect(err.isTimeout).toBe(true)
    expect(err.name).toBe("TimeoutError")
    expect(err.message).toContain("5000ms")
  })
})

// ---------------------------------------------------------------------------
// isTransientError
// ---------------------------------------------------------------------------

describe("isTransientError", () => {
  it("returns true for ETIMEDOUT", () => {
    expect(isTransientError(new Error("ETIMEDOUT"))).toBe(true)
  })

  it("returns true for ECONNRESET", () => {
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true)
  })

  it("returns true for ECONNREFUSED", () => {
    expect(isTransientError(new Error("ECONNREFUSED"))).toBe(true)
  })

  it("returns true for socket hang up", () => {
    expect(isTransientError(new Error("socket hang up"))).toBe(true)
  })

  it("returns true for rate limit", () => {
    expect(isTransientError(new Error("rate limit exceeded"))).toBe(true)
  })

  it("returns true for 429", () => {
    expect(isTransientError(new Error("HTTP 429 Too Many Requests"))).toBe(true)
  })

  it("returns true for 503", () => {
    expect(isTransientError(new Error("HTTP 503 Service Unavailable"))).toBe(true)
  })

  it("returns true for 502", () => {
    expect(isTransientError(new Error("502 Bad Gateway"))).toBe(true)
  })

  it("returns false for TimeoutError", () => {
    expect(isTransientError(new TimeoutError(5000))).toBe(false)
  })

  it("returns false for generic error", () => {
    expect(isTransientError(new Error("something went wrong"))).toBe(false)
  })

  it("returns false for permission error", () => {
    expect(isTransientError(new Error("Permission denied"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildSpawnEnv
// ---------------------------------------------------------------------------

describe("buildSpawnEnv", () => {
  it("injects CLAUDE_CODE_OAUTH_TOKEN", () => {
    const env = buildSpawnEnv("my-token")
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("my-token")
  })

  it("returns only string values", () => {
    const env = buildSpawnEnv("tok")
    for (const [, value] of Object.entries(env)) {
      expect(typeof value).toBe("string")
    }
  })
})

// ---------------------------------------------------------------------------
// Agent.parseResponse
// ---------------------------------------------------------------------------

describe("Agent.parseResponse", () => {
  const agent = new Agent(baseConfig)

  it("parses standard JSON response", () => {
    const json = JSON.stringify({
      session_id: "sess-123",
      result: "Hello world",
      usage: { input_tokens: 10, output_tokens: 20 },
    })

    const result = agent.parseResponse(json)
    expect(result.text).toBe("Hello world")
    expect(result.sessionId).toBe("sess-123")
    expect(result.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  it("parses JSON without usage", () => {
    const json = JSON.stringify({
      session_id: "sess-456",
      result: "No usage info",
    })

    const result = agent.parseResponse(json)
    expect(result.text).toBe("No usage info")
    expect(result.sessionId).toBe("sess-456")
    expect(result.tokenUsage).toBeNull()
  })

  it("returns raw text on invalid JSON", () => {
    const result = agent.parseResponse("not valid json at all")
    expect(result.text).toBe("not valid json at all")
    expect(result.tokenUsage).toBeNull()
  })

  it("parses stream-json with result event", () => {
    const lines = [
      JSON.stringify({ type: "system", message: "Starting..." }),
      JSON.stringify({ type: "assistant", message: "thinking..." }),
      JSON.stringify({
        type: "result",
        session_id: "sess-stream",
        result: "Stream result",
        usage: { input_tokens: 50, output_tokens: 100 },
      }),
    ].join("\n")

    const result = agent.parseResponse(lines)
    expect(result.text).toBe("Stream result")
    expect(result.sessionId).toBe("sess-stream")
    expect(result.tokenUsage).toEqual({ inputTokens: 50, outputTokens: 100 })
  })

  it("stream-json without result event returns raw text", () => {
    const lines = [
      JSON.stringify({ type: "system", message: "Starting..." }),
      JSON.stringify({ type: "assistant", message: "thinking..." }),
    ].join("\n")

    const result = agent.parseResponse(lines)
    expect(result.text).toBe(lines.trim())
    expect(result.tokenUsage).toBeNull()
  })

  it("parses JSON with result but no session_id", () => {
    const json = JSON.stringify({ result: "No session" })
    const result = agent.parseResponse(json)
    expect(result.text).toBe("No session")
  })

  it("falls back to raw text when result field is missing", () => {
    const json = JSON.stringify({ session_id: "sess-no-result" })
    const result = agent.parseResponse(json)
    expect(result.text).toBe(json)
  })
})

// ---------------------------------------------------------------------------
// Agent.buildArgs
// ---------------------------------------------------------------------------

describe("Agent.buildArgs", () => {
  it("builds basic args with prompt", () => {
    const agent = new Agent(baseConfig)
    const args = agent.buildArgs("hello")
    expect(args).toContain("claude")
    expect(args).toContain("--print")
    expect(args).toContain("--output-format")
    expect(args).toContain("json")
    expect(args).toContain("--dangerously-skip-permissions")
    expect(args).toContain("-p")
    expect(args).toContain("hello")
  })

  it("includes --resume when sessionId is set", () => {
    const agent = new Agent(baseConfig)
    agent.setSessionId("sess-build")
    const args = agent.buildArgs("hello")
    expect(args).toContain("--resume")
    expect(args).toContain("sess-build")
  })

  it("includes --system-prompt on new session", () => {
    const agent = new Agent({ ...baseConfig, systemPrompt: "Be helpful" })
    const args = agent.buildArgs("hello")
    expect(args).toContain("--system-prompt")
    expect(args).toContain("Be helpful")
  })

  it("does not include --system-prompt when resuming", () => {
    const agent = new Agent({ ...baseConfig, systemPrompt: "Be helpful" })
    agent.setSessionId("sess-existing")
    const args = agent.buildArgs("hello")
    expect(args).not.toContain("--system-prompt")
    expect(args).toContain("--resume")
  })

  it("omits --dangerously-skip-permissions when disabled", () => {
    const agent = new Agent({ ...baseConfig, skipPermissions: false })
    const args = agent.buildArgs("hello")
    expect(args).not.toContain("--dangerously-skip-permissions")
  })

  it("uses stream-json format with --verbose", () => {
    const agent = new Agent(baseConfig)
    const args = agent.buildArgs(null, "stream-json")
    expect(args).toContain("stream-json")
    expect(args).toContain("--verbose")
    expect(args).not.toContain("hello")
  })

  it("does not include prompt when null", () => {
    const agent = new Agent(baseConfig)
    const args = agent.buildArgs(null)
    const lastArg = args[args.length - 1]
    expect(lastArg).not.toBe(null)
    // Last arg should be a flag, not a prompt
    expect(["json", "--dangerously-skip-permissions"]).toContain(lastArg)
  })

  it("includes --mcp-config when set", () => {
    const agent = new Agent({ ...baseConfig, mcpConfigPath: "/tmp/mcp.json" })
    const args = agent.buildArgs("hello")
    expect(args).toContain("--mcp-config")
    expect(args).toContain("/tmp/mcp.json")
  })

  it("includes --tools '' when disableTools is true", () => {
    const agent = new Agent(baseConfig)
    agent.disableTools = true
    const args = agent.buildArgs("hello")
    expect(args).toContain("--tools")
    expect(args).toContain("")
    // Prompt must use -p flag to avoid being consumed by --tools
    const pIndex = args.indexOf("-p")
    expect(pIndex).toBeGreaterThan(-1)
    expect(args[pIndex + 1]).toBe("hello")
  })

  it("does not include --tools when disableTools is false (default)", () => {
    const agent = new Agent(baseConfig)
    const args = agent.buildArgs("hello")
    expect(args).not.toContain("--tools")
  })

  it("uses -p flag for prompt", () => {
    const agent = new Agent(baseConfig)
    const args = agent.buildArgs("my prompt")
    const pIndex = args.indexOf("-p")
    expect(pIndex).toBeGreaterThan(-1)
    expect(args[pIndex + 1]).toBe("my prompt")
  })

  it("includes --allowed-tools when allowedTools is set", () => {
    const agent = new Agent(baseConfig)
    agent.allowedTools = "Bash Read Write Edit"
    const args = agent.buildArgs("hello")
    expect(args).toContain("--allowed-tools")
    expect(args).toContain("Bash Read Write Edit")
    expect(args).not.toContain("--tools")
  })

  it("disableTools takes priority over allowedTools", () => {
    const agent = new Agent(baseConfig)
    agent.disableTools = true
    agent.allowedTools = "Bash Read"
    const args = agent.buildArgs("hello")
    expect(args).toContain("--tools")
    expect(args).not.toContain("--allowed-tools")
  })

  it("includes worker mode flags when workerMode is true", () => {
    const agent = new Agent(baseConfig)
    agent.workerMode = true
    const args = agent.buildArgs("hello")
    expect(args).toContain("--no-session-persistence")
    expect(args).toContain("--disable-slash-commands")
  })

  it("does not include worker mode flags by default", () => {
    const agent = new Agent(baseConfig)
    const args = agent.buildArgs("hello")
    expect(args).not.toContain("--no-session-persistence")
    expect(args).not.toContain("--disable-slash-commands")
  })

  it("includes --effort when effort is set", () => {
    const agent = new Agent(baseConfig)
    agent.effort = "high"
    const args = agent.buildArgs("hello")
    expect(args).toContain("--effort")
    expect(args).toContain("high")
  })

  it("does not include --effort by default", () => {
    const agent = new Agent(baseConfig)
    const args = agent.buildArgs("hello")
    expect(args).not.toContain("--effort")
  })

  it("combines all flags correctly for master agent", () => {
    const agent = new Agent(baseConfig)
    agent.disableTools = true
    agent.effort = "high"
    const args = agent.buildArgs("test")
    expect(args).toContain("--tools")
    expect(args).toContain("--effort")
    expect(args).toContain("high")
    expect(args).not.toContain("--no-session-persistence")
  })

  it("combines all flags correctly for worker agent", () => {
    const agent = new Agent(baseConfig)
    agent.allowedTools = "Bash Read Write"
    agent.workerMode = true
    const args = agent.buildArgs("test")
    expect(args).toContain("--allowed-tools")
    expect(args).toContain("--no-session-persistence")
    expect(args).toContain("--disable-slash-commands")
    expect(args).not.toContain("--tools")
    expect(args).not.toContain("--effort")
  })
})

// ---------------------------------------------------------------------------
// Agent.abort()
// ---------------------------------------------------------------------------

describe("Agent.abort", () => {
  it("does not throw when no process is running", () => {
    const agent = new Agent(baseConfig)
    expect(() => agent.abort()).not.toThrow()
  })

  it("can be called multiple times safely", () => {
    const agent = new Agent(baseConfig)
    agent.abort()
    agent.abort()
    agent.abort()
    // Should not throw
  })
})

// ---------------------------------------------------------------------------
// Agent.cleanup()
// ---------------------------------------------------------------------------

describe("Agent.cleanup", () => {
  it("removes sandbox directory", () => {
    const agent = new Agent(baseConfig)
    expect(existsSync(agent.sandboxDir)).toBe(true)
    agent.cleanup()
    expect(existsSync(agent.sandboxDir)).toBe(false)
  })

  it("can be called multiple times safely", () => {
    const agent = new Agent(baseConfig)
    agent.cleanup()
    // Second cleanup should not throw even though dir is gone
    expect(() => agent.cleanup()).not.toThrow()
  })

  it("calls abort before cleaning up", () => {
    const agent = new Agent(baseConfig)
    // Just verify cleanup doesn't throw — abort is called internally
    agent.cleanup()
  })
})
