/**
 * Runtime configuration manager.
 * Allows changing agent config at runtime via Telegram commands.
 * Persists overrides in SQLite — survives restarts.
 * Validates all values before applying.
 */

import type { AgentConfig, ConfigDefinition, RuntimeConfigKey, LogLevel } from "./types"
import type { Database } from "./db"
import { logger } from "./logger"

/** Registry of all configurable keys with validation rules */
function buildDefinitions(defaults: AgentConfig): ConfigDefinition[] {
  return [
    {
      key: "system_prompt",
      type: "string",
      description: "System prompt (persona dell'agente)",
      defaultValue: defaults.systemPrompt ?? "",
    },
    {
      key: "timeout_ms",
      type: "number",
      description: "Timeout per chiamata (ms, 0 = disabilitato)",
      defaultValue: String(defaults.timeoutMs),
      min: 0,
      max: 600_000,
    },
    {
      key: "max_retries",
      type: "number",
      description: "Tentativi massimi su errori transitori",
      defaultValue: String(defaults.maxRetries),
      min: 0,
      max: 10,
    },
    {
      key: "retry_delay_ms",
      type: "number",
      description: "Delay iniziale retry (ms)",
      defaultValue: String(defaults.initialRetryDelayMs),
      min: 100,
      max: 30_000,
    },
    {
      key: "skip_permissions",
      type: "boolean",
      description: "Skip permission prompts nel CLI",
      defaultValue: String(defaults.skipPermissions),
    },
    {
      key: "log_level",
      type: "string",
      description: "Livello di log",
      defaultValue: "INFO",
      enum: ["DEBUG", "INFO", "WARN", "ERROR"],
    },
    {
      key: "docker",
      type: "boolean",
      description: "Esegui in container Docker",
      defaultValue: String(defaults.useDocker),
    },
    {
      key: "docker_image",
      type: "string",
      description: "Immagine Docker",
      defaultValue: defaults.dockerImage,
    },
    {
      key: "max_concurrent",
      type: "number",
      description: "Max agenti concorrenti per chat (1 = seriale)",
      defaultValue: String(defaults.maxConcurrentPerChat),
      min: 1,
      max: 10,
    },
  ]
}

export class RuntimeConfig {
  private readonly db: Database
  private readonly config: AgentConfig
  private readonly definitions: Map<RuntimeConfigKey, ConfigDefinition>

  constructor(db: Database, config: AgentConfig) {
    this.db = db
    this.config = config

    const defs = buildDefinitions(config)
    this.definitions = new Map(defs.map((d) => [d.key, d]))

    this.loadFromDb()
  }

  /** Load persisted overrides from DB and apply to in-memory config */
  private loadFromDb(): void {
    const rows = this.db.getAllConfig()
    let applied = 0
    for (const { key, value } of rows) {
      if (this.definitions.has(key as RuntimeConfigKey)) {
        this.applyToConfig(key as RuntimeConfigKey, value)
        applied++
      }
    }
    if (applied > 0) {
      logger.info("Runtime config loaded from DB", { overrides: applied })
    }
  }

  /** Get the definition for a key */
  getDefinition(key: RuntimeConfigKey): ConfigDefinition | undefined {
    return this.definitions.get(key)
  }

  /** Get all definitions */
  getAllDefinitions(): ConfigDefinition[] {
    return [...this.definitions.values()]
  }

  /** Get the current value for a key (from agentConfig) */
  get(key: RuntimeConfigKey): string {
    switch (key) {
      case "system_prompt":
        return this.config.systemPrompt ?? ""
      case "timeout_ms":
        return String(this.config.timeoutMs)
      case "max_retries":
        return String(this.config.maxRetries)
      case "retry_delay_ms":
        return String(this.config.initialRetryDelayMs)
      case "skip_permissions":
        return String(this.config.skipPermissions)
      case "log_level":
        return Bun.env.CLAUDE_AGENT_LOG_LEVEL ?? "INFO"
      case "docker":
        return String(this.config.useDocker)
      case "docker_image":
        return this.config.dockerImage
      case "max_concurrent":
        return String(this.config.maxConcurrentPerChat)
    }
  }

  /** Get all current values as key-value pairs */
  getAll(): Array<{ key: RuntimeConfigKey; value: string; defaultValue: string; description: string }> {
    return this.getAllDefinitions().map((def) => ({
      key: def.key,
      value: this.get(def.key),
      defaultValue: def.defaultValue,
      description: def.description,
    }))
  }

  /**
   * Set a config value. Validates, persists to DB, and applies to in-memory config.
   * Returns the old value on success.
   * Throws on validation failure.
   */
  set(key: RuntimeConfigKey, rawValue: string): { oldValue: string; newValue: string } {
    const def = this.definitions.get(key)
    if (!def) throw new Error(`Chiave sconosciuta: ${key}`)

    const validated = this.validate(def, rawValue)
    const oldValue = this.get(key)

    this.db.setConfig(key, validated)
    this.applyToConfig(key, validated)

    logger.info("Runtime config changed", { key, oldValue, newValue: validated })
    return { oldValue, newValue: validated }
  }

  /** Reset a single key to its default value */
  reset(key: RuntimeConfigKey): { oldValue: string; defaultValue: string } {
    const def = this.definitions.get(key)
    if (!def) throw new Error(`Chiave sconosciuta: ${key}`)

    const oldValue = this.get(key)
    this.db.deleteConfig(key)
    this.applyToConfig(key, def.defaultValue)

    logger.info("Runtime config reset", { key, oldValue, defaultValue: def.defaultValue })
    return { oldValue, defaultValue: def.defaultValue }
  }

  /** Reset ALL keys to defaults */
  resetAll(): void {
    this.db.clearAllConfig()
    for (const def of this.definitions.values()) {
      this.applyToConfig(def.key, def.defaultValue)
    }
    logger.info("All runtime config reset to defaults")
  }

  /** Check if a key is valid */
  isValidKey(key: string): key is RuntimeConfigKey {
    return this.definitions.has(key as RuntimeConfigKey)
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  private validate(def: ConfigDefinition, rawValue: string): string {
    switch (def.type) {
      case "number": {
        const n = Number(rawValue)
        if (!Number.isFinite(n)) throw new Error(`"${rawValue}" non e' un numero valido`)
        // timeout_ms: allow 0 (disabled) or >= 5000
        if (def.key === "timeout_ms" && n !== 0 && n < 5_000) {
          throw new Error("Usa 0 per disabilitare, oppure un valore >= 5000 ms")
        }
        if (def.min !== undefined && n < def.min) throw new Error(`Valore minimo: ${def.min}`)
        if (def.max !== undefined && n > def.max) throw new Error(`Valore massimo: ${def.max}`)
        return String(n)
      }
      case "boolean": {
        const lower = rawValue.toLowerCase()
        if (["true", "1", "yes", "si"].includes(lower)) return "true"
        if (["false", "0", "no"].includes(lower)) return "false"
        throw new Error(`"${rawValue}" non e' un booleano valido (usa: true/false, 1/0, si/no)`)
      }
      case "string": {
        if (def.enum && !def.enum.includes(rawValue.toUpperCase())) {
          throw new Error(`Valori ammessi: ${def.enum.join(", ")}`)
        }
        if (def.enum) return rawValue.toUpperCase()
        return rawValue
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Apply to in-memory config
  // ---------------------------------------------------------------------------

  private applyToConfig(key: RuntimeConfigKey, value: string): void {
    switch (key) {
      case "system_prompt":
        this.config.systemPrompt = value || undefined
        break
      case "timeout_ms":
        this.config.timeoutMs = Number(value)
        break
      case "max_retries":
        this.config.maxRetries = Number(value)
        break
      case "retry_delay_ms":
        this.config.initialRetryDelayMs = Number(value)
        break
      case "skip_permissions":
        this.config.skipPermissions = value === "true"
        break
      case "log_level":
        logger.setMinLevel(value as LogLevel)
        Bun.env.CLAUDE_AGENT_LOG_LEVEL = value
        break
      case "docker":
        this.config.useDocker = value === "true"
        break
      case "docker_image":
        this.config.dockerImage = value
        break
      case "max_concurrent":
        this.config.maxConcurrentPerChat = Number(value)
        break
    }
  }
}
