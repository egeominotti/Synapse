/**
 * Centralized configuration.
 * Reads from environment variables with sensible defaults.
 */

import type { AgentConfig } from "./types"
import { join } from "path"
import { homedir } from "os"

const DEFAULT_TIMEOUT_MS = 0 // 0 = no timeout
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1_000
const DEFAULT_DB_PATH = join(homedir(), ".claude-agent", "neo.db")

function getRequiredEnv(key: string): string {
  const value = Bun.env[key]
  if (!value) {
    process.stderr.write(`[FATAL] Environment variable ${key} is required but not set.\n`)
    process.exit(1)
  }
  return value
}

function getOptionalEnvInt(key: string, fallback: number, min?: number, max?: number): number {
  const raw = Bun.env[key]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  if (Number.isNaN(parsed)) {
    process.stderr.write(`[WARN] ${key}="${raw}" is not a valid integer, using default ${fallback}\n`)
    return fallback
  }
  if (min !== undefined && parsed < min) {
    process.stderr.write(`[WARN] ${key}=${parsed} below minimum ${min}, using ${min}\n`)
    return min
  }
  if (max !== undefined && parsed > max) {
    process.stderr.write(`[WARN] ${key}=${parsed} above maximum ${max}, using ${max}\n`)
    return max
  }
  return parsed
}

export function loadConfig(): AgentConfig {
  return {
    token: getRequiredEnv("CLAUDE_CODE_OAUTH_TOKEN"),
    timeoutMs: getOptionalEnvInt("CLAUDE_AGENT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 0, 600_000),
    maxRetries: getOptionalEnvInt("CLAUDE_AGENT_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0, 10),
    initialRetryDelayMs: getOptionalEnvInt("CLAUDE_AGENT_RETRY_DELAY_MS", DEFAULT_INITIAL_RETRY_DELAY_MS, 100, 30_000),
    dbPath: Bun.env.CLAUDE_AGENT_DB_PATH ?? DEFAULT_DB_PATH,
    skipPermissions: (Bun.env.CLAUDE_AGENT_SKIP_PERMISSIONS ?? "1") === "1",
    useDocker: Bun.env.CLAUDE_AGENT_DOCKER === "1",
    dockerImage: Bun.env.CLAUDE_AGENT_DOCKER_IMAGE ?? "claude-agent:latest",
    systemPrompt: Bun.env.CLAUDE_AGENT_SYSTEM_PROMPT || undefined,
    mcpConfigPath: Bun.env.CLAUDE_AGENT_MCP_CONFIG_PATH || undefined,
    whisperModelPath: Bun.env.WHISPER_MODEL_PATH || undefined,
    whisperLanguage: Bun.env.WHISPER_LANGUAGE || "auto",
    whisperThreads: getOptionalEnvInt("WHISPER_THREADS", 4, 1, 16),
    groqApiKey: Bun.env.GROQ_API_KEY || undefined,
  }
}
