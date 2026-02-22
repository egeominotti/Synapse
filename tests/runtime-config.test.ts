import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "../src/db"
import { RuntimeConfig } from "../src/runtime-config"
import type { AgentConfig } from "../src/types"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

let db: Database
let tmpDir: string

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    token: "test-token",
    timeoutMs: 120_000,
    maxRetries: 3,
    initialRetryDelayMs: 1_000,
    dbPath: join(tmpDir, "test.db"),
    skipPermissions: true,
    useDocker: false,
    dockerImage: "claude-agent:latest",
    systemPrompt: undefined,
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "neo-rc-"))
  db = new Database(join(tmpDir, "test.db"))
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Basic get/set
// ---------------------------------------------------------------------------

describe("RuntimeConfig get/set", () => {
  it("get returns default values", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    expect(rc.get("timeout_ms")).toBe("120000")
    expect(rc.get("max_retries")).toBe("3")
    expect(rc.get("skip_permissions")).toBe("true")
    expect(rc.get("docker")).toBe("false")
  })

  it("set changes value and returns old/new", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    const result = rc.set("timeout_ms", "60000")
    expect(result.oldValue).toBe("120000")
    expect(result.newValue).toBe("60000")
    expect(rc.get("timeout_ms")).toBe("60000")
  })

  it("set updates agentConfig in memory", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    rc.set("timeout_ms", "30000")
    expect(config.timeoutMs).toBe(30000)
  })

  it("set persists to DB", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    rc.set("max_retries", "5")

    // Create a new RuntimeConfig from the same DB — should load the override
    const config2 = makeConfig()
    const rc2 = new RuntimeConfig(db, config2)
    expect(rc2.get("max_retries")).toBe("5")
    expect(config2.maxRetries).toBe(5)
  })

  it("set boolean with various formats", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)

    rc.set("skip_permissions", "false")
    expect(config.skipPermissions).toBe(false)

    rc.set("skip_permissions", "1")
    expect(config.skipPermissions).toBe(true)

    rc.set("skip_permissions", "no")
    expect(config.skipPermissions).toBe(false)

    rc.set("skip_permissions", "si")
    expect(config.skipPermissions).toBe(true)
  })

  it("set system_prompt", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    rc.set("system_prompt", "Sei un assistente conciso")
    expect(config.systemPrompt).toBe("Sei un assistente conciso")
    expect(rc.get("system_prompt")).toBe("Sei un assistente conciso")
  })

  it("set docker_image", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    rc.set("docker_image", "my-image:v2")
    expect(config.dockerImage).toBe("my-image:v2")
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("RuntimeConfig validation", () => {
  it("rejects non-numeric value for number type", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    expect(() => rc.set("timeout_ms", "abc")).toThrow("non e' un numero valido")
  })

  it("rejects value below min (non-zero)", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    expect(() => rc.set("timeout_ms", "1000")).toThrow("Usa 0 per disabilitare")
  })

  it("allows timeout_ms = 0 (disabled)", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    const { newValue } = rc.set("timeout_ms", "0")
    expect(newValue).toBe("0")
    expect(config.timeoutMs).toBe(0)
  })

  it("rejects value above max", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    expect(() => rc.set("timeout_ms", "9999999")).toThrow("Valore massimo: 600000")
  })

  it("rejects invalid boolean", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    expect(() => rc.set("skip_permissions", "maybe")).toThrow("non e' un booleano valido")
  })

  it("rejects invalid log_level", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    expect(() => rc.set("log_level", "TRACE")).toThrow("Valori ammessi")
  })

  it("accepts valid log_level (case insensitive)", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    rc.set("log_level", "debug")
    expect(rc.get("log_level")).toBe("DEBUG")
  })

  it("rejects unknown key", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    expect(() => rc.set("unknown_key" as any, "value")).toThrow("Chiave sconosciuta")
  })
})

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("RuntimeConfig reset", () => {
  it("reset restores single key to default", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    rc.set("timeout_ms", "30000")
    expect(config.timeoutMs).toBe(30000)

    const result = rc.reset("timeout_ms")
    expect(result.oldValue).toBe("30000")
    expect(result.defaultValue).toBe("120000")
    expect(config.timeoutMs).toBe(120000)
  })

  it("reset removes from DB", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    rc.set("max_retries", "7")

    rc.reset("max_retries")
    expect(db.getConfig("max_retries")).toBeNull()
  })

  it("resetAll restores all defaults", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    rc.set("timeout_ms", "30000")
    rc.set("max_retries", "7")
    rc.set("skip_permissions", "false")

    rc.resetAll()
    expect(config.timeoutMs).toBe(120000)
    expect(config.maxRetries).toBe(3)
    expect(config.skipPermissions).toBe(true)
  })

  it("resetAll clears DB", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    rc.set("timeout_ms", "30000")
    rc.set("max_retries", "7")

    rc.resetAll()
    expect(db.getAllConfig()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// getAll and definitions
// ---------------------------------------------------------------------------

describe("RuntimeConfig getAll", () => {
  it("returns all config entries", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    const all = rc.getAll()
    expect(all.length).toBe(8)
    expect(all.map((a) => a.key)).toContain("timeout_ms")
    expect(all.map((a) => a.key)).toContain("system_prompt")
    expect(all.map((a) => a.key)).toContain("log_level")
  })

  it("isValidKey works", () => {
    const config = makeConfig()
    const rc = new RuntimeConfig(db, config)
    expect(rc.isValidKey("timeout_ms")).toBe(true)
    expect(rc.isValidKey("nonexistent")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Load from DB on init
// ---------------------------------------------------------------------------

describe("RuntimeConfig persistence across restarts", () => {
  it("loads overrides from DB on construction", () => {
    const config1 = makeConfig()
    const rc1 = new RuntimeConfig(db, config1)
    rc1.set("timeout_ms", "45000")
    rc1.set("max_retries", "8")

    // Simulate restart: new config, same DB
    const config2 = makeConfig()
    new RuntimeConfig(db, config2)
    expect(config2.timeoutMs).toBe(45000)
    expect(config2.maxRetries).toBe(8)
  })
})
