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

  it("returns true for rate_limit (SDK error)", () => {
    expect(isTransientError(new Error("rate_limit"))).toBe(true)
  })

  it("returns true for server_error (SDK error)", () => {
    expect(isTransientError(new Error("server_error"))).toBe(true)
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
// Agent.buildSdkOptions
// ---------------------------------------------------------------------------

describe("Agent.buildSdkOptions", () => {
  it("sets cwd to sandboxDir", () => {
    const agent = new Agent(baseConfig)
    const opts = agent.buildSdkOptions()
    expect(opts.cwd).toBe(agent.sandboxDir)
    agent.cleanup()
  })

  it("sets bypassPermissions when skipPermissions is true", () => {
    const agent = new Agent(baseConfig)
    const opts = agent.buildSdkOptions()
    expect(opts.permissionMode).toBe("bypassPermissions")
    expect(opts.allowDangerouslySkipPermissions).toBe(true)
    agent.cleanup()
  })

  it("does not set bypassPermissions when skipPermissions is false", () => {
    const agent = new Agent({ ...baseConfig, skipPermissions: false })
    const opts = agent.buildSdkOptions()
    expect(opts.permissionMode).toBeUndefined()
    expect(opts.allowDangerouslySkipPermissions).toBeUndefined()
    agent.cleanup()
  })

  it("sets empty allowedTools when disableTools is true", () => {
    const agent = new Agent(baseConfig)
    agent.disableTools = true
    const opts = agent.buildSdkOptions()
    expect(opts.allowedTools).toEqual([])
    agent.cleanup()
  })

  it("splits allowedTools string into array", () => {
    const agent = new Agent(baseConfig)
    agent.allowedTools = "Bash Read Write Edit"
    const opts = agent.buildSdkOptions()
    expect(opts.allowedTools).toEqual(["Bash", "Read", "Write", "Edit"])
    agent.cleanup()
  })

  it("disableTools takes priority over allowedTools", () => {
    const agent = new Agent(baseConfig)
    agent.disableTools = true
    agent.allowedTools = "Bash Read"
    const opts = agent.buildSdkOptions()
    expect(opts.allowedTools).toEqual([])
    agent.cleanup()
  })

  it("does not set allowedTools by default", () => {
    const agent = new Agent(baseConfig)
    const opts = agent.buildSdkOptions()
    expect(opts.allowedTools).toBeUndefined()
    agent.cleanup()
  })

  it("sets resume when sessionId is set", () => {
    const agent = new Agent(baseConfig)
    agent.setSessionId("sess-build")
    const opts = agent.buildSdkOptions()
    expect(opts.resume).toBe("sess-build")
    expect(opts.systemPrompt).toBeUndefined()
    agent.cleanup()
  })

  it("sets systemPrompt on new session", () => {
    const agent = new Agent({ ...baseConfig, systemPrompt: "Be helpful" })
    const opts = agent.buildSdkOptions()
    expect(opts.systemPrompt).toBe("Be helpful")
    expect(opts.resume).toBeUndefined()
    agent.cleanup()
  })

  it("does not set systemPrompt when resuming", () => {
    const agent = new Agent({ ...baseConfig, systemPrompt: "Be helpful" })
    agent.setSessionId("sess-existing")
    const opts = agent.buildSdkOptions()
    expect(opts.systemPrompt).toBeUndefined()
    expect(opts.resume).toBe("sess-existing")
    agent.cleanup()
  })

  it("sets effort when configured", () => {
    const agent = new Agent(baseConfig)
    agent.effort = "high"
    const opts = agent.buildSdkOptions()
    expect(opts.effort).toBe("high")
    agent.cleanup()
  })

  it("does not set effort by default", () => {
    const agent = new Agent(baseConfig)
    const opts = agent.buildSdkOptions()
    expect(opts.effort).toBeUndefined()
    agent.cleanup()
  })

  it("includes mcpServers with bunqueue", () => {
    const agent = new Agent(baseConfig)
    const opts = agent.buildSdkOptions()
    expect(opts.mcpServers).toBeDefined()
    const bunqueue = opts.mcpServers!.bunqueue
    expect(bunqueue).toBeDefined()
    // bunqueue is a stdio MCP server
    expect("command" in bunqueue).toBe(true)
    expect((bunqueue as { command: string }).command).toBe("bunx")
    agent.cleanup()
  })

  it("includes env with token", () => {
    const agent = new Agent(baseConfig)
    const opts = agent.buildSdkOptions()
    expect(opts.env).toBeDefined()
    expect(opts.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-token")
    agent.cleanup()
  })

  it("uses overrideSystemPrompt when set", () => {
    const agent = new Agent({ ...baseConfig, systemPrompt: "Default" })
    agent.setSystemPrompt("Override prompt")
    const opts = agent.buildSdkOptions()
    expect(opts.systemPrompt).toBe("Override prompt")
    agent.cleanup()
  })

  it("combines all options correctly for master agent", () => {
    const agent = new Agent(baseConfig)
    agent.disableTools = true
    agent.effort = "high"
    const opts = agent.buildSdkOptions()
    expect(opts.allowedTools).toEqual([])
    expect(opts.effort).toBe("high")
    expect(opts.permissionMode).toBe("bypassPermissions")
    agent.cleanup()
  })

  it("combines all options correctly for worker agent", () => {
    const agent = new Agent(baseConfig)
    agent.allowedTools = "Bash Read Write"
    agent.workerMode = true
    const opts = agent.buildSdkOptions()
    expect(opts.allowedTools).toEqual(["Bash", "Read", "Write"])
    // workerMode doesn't affect SDK options (no slash commands in SDK)
    expect(opts.effort).toBeUndefined()
    agent.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Agent.abort()
// ---------------------------------------------------------------------------

describe("Agent.abort", () => {
  it("does not throw when no query is running", () => {
    const agent = new Agent(baseConfig)
    expect(() => agent.abort()).not.toThrow()
    agent.cleanup()
  })

  it("can be called multiple times safely", () => {
    const agent = new Agent(baseConfig)
    agent.abort()
    agent.abort()
    agent.abort()
    // Should not throw
    agent.cleanup()
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
