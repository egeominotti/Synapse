import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { homedir } from "os"

// We need to manipulate Bun.env before importing loadConfig,
// so we use dynamic import in each test.

let originalEnv: Record<string, string | undefined>

beforeEach(() => {
  originalEnv = { ...Bun.env }
})

afterEach(() => {
  // Restore env
  for (const key of Object.keys(Bun.env)) {
    if (!(key in originalEnv)) {
      delete Bun.env[key]
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value !== undefined) {
      Bun.env[key] = value
    }
  }
})

describe("loadConfig", () => {
  it("loads valid config with required env var", async () => {
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-123"
    // Clear optional vars to test defaults
    delete Bun.env.CLAUDE_AGENT_TIMEOUT_MS
    delete Bun.env.CLAUDE_AGENT_MAX_RETRIES
    delete Bun.env.CLAUDE_AGENT_RETRY_DELAY_MS
    delete Bun.env.CLAUDE_AGENT_DB_PATH
    delete Bun.env.CLAUDE_AGENT_SKIP_PERMISSIONS
    delete Bun.env.CLAUDE_AGENT_DOCKER
    delete Bun.env.CLAUDE_AGENT_SYSTEM_PROMPT

    const { loadConfig } = await import("../src/config")
    const config = loadConfig()

    expect(config.token).toBe("test-token-123")
    expect(config.timeoutMs).toBe(0) // 0 = no timeout
    expect(config.maxRetries).toBe(3)
    expect(config.initialRetryDelayMs).toBe(1_000)
    expect(config.dbPath).toBe(join(homedir(), ".claude-agent", "neo.db"))
    expect(config.skipPermissions).toBe(true)
    expect(config.useDocker).toBe(false)
    expect(config.dockerImage).toBe("claude-agent:latest")
    expect(config.systemPrompt).toBeUndefined()
  })

  it("reads custom env values", async () => {
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN = "custom-tok"
    Bun.env.CLAUDE_AGENT_TIMEOUT_MS = "30000"
    Bun.env.CLAUDE_AGENT_MAX_RETRIES = "5"
    Bun.env.CLAUDE_AGENT_RETRY_DELAY_MS = "2000"
    Bun.env.CLAUDE_AGENT_DB_PATH = "/tmp/custom.db"
    Bun.env.CLAUDE_AGENT_SKIP_PERMISSIONS = "0"
    Bun.env.CLAUDE_AGENT_DOCKER = "1"
    Bun.env.CLAUDE_AGENT_DOCKER_IMAGE = "my-image:v2"
    Bun.env.CLAUDE_AGENT_SYSTEM_PROMPT = "Be concise"

    const { loadConfig } = await import("../src/config")
    const config = loadConfig()

    expect(config.token).toBe("custom-tok")
    expect(config.timeoutMs).toBe(30_000)
    expect(config.maxRetries).toBe(5)
    expect(config.initialRetryDelayMs).toBe(2_000)
    expect(config.dbPath).toBe("/tmp/custom.db")
    expect(config.skipPermissions).toBe(false)
    expect(config.useDocker).toBe(true)
    expect(config.dockerImage).toBe("my-image:v2")
    expect(config.systemPrompt).toBe("Be concise")
  })

  it("clamps values below minimum", async () => {
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN = "tok"
    Bun.env.CLAUDE_AGENT_TIMEOUT_MS = "-1"
    Bun.env.CLAUDE_AGENT_MAX_RETRIES = "-1"
    Bun.env.CLAUDE_AGENT_RETRY_DELAY_MS = "10"

    const { loadConfig } = await import("../src/config")
    const config = loadConfig()

    expect(config.timeoutMs).toBe(0) // min is 0 (no timeout)
    expect(config.maxRetries).toBe(0)
    expect(config.initialRetryDelayMs).toBe(100)
  })

  it("clamps values above maximum", async () => {
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN = "tok"
    Bun.env.CLAUDE_AGENT_TIMEOUT_MS = "9999999"
    Bun.env.CLAUDE_AGENT_MAX_RETRIES = "50"
    Bun.env.CLAUDE_AGENT_RETRY_DELAY_MS = "100000"

    const { loadConfig } = await import("../src/config")
    const config = loadConfig()

    expect(config.timeoutMs).toBe(600_000)
    expect(config.maxRetries).toBe(10)
    expect(config.initialRetryDelayMs).toBe(30_000)
  })

  it("skipPermissions defaults to true, disabled only with '0'", async () => {
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN = "tok"

    const { loadConfig } = await import("../src/config")

    // Default (unset) → true
    delete Bun.env.CLAUDE_AGENT_SKIP_PERMISSIONS
    expect(loadConfig().skipPermissions).toBe(true)

    // Explicit "1" → true
    Bun.env.CLAUDE_AGENT_SKIP_PERMISSIONS = "1"
    expect(loadConfig().skipPermissions).toBe(true)

    // "0" → false
    Bun.env.CLAUDE_AGENT_SKIP_PERMISSIONS = "0"
    expect(loadConfig().skipPermissions).toBe(false)

    // Random string → false (only "1" is true)
    Bun.env.CLAUDE_AGENT_SKIP_PERMISSIONS = "true"
    expect(loadConfig().skipPermissions).toBe(false)
  })
})
