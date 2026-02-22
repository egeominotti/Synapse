/**
 * Centralized configuration.
 * Reads from environment variables with sensible defaults.
 */

import type { AgentConfig } from "./types"
import { join } from "path"
import { homedir } from "os"

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1_000
const DEFAULT_HISTORY_DIR = join(homedir(), ".claude-agent", "history")

function getRequiredEnv(key: string): string {
  const value = Bun.env[key]
  if (!value) {
    process.stderr.write(`[FATAL] Environment variable ${key} is required but not set.\n`)
    process.exit(1)
  }
  return value
}

function getOptionalEnvInt(key: string, fallback: number): number {
  const raw = Bun.env[key]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  if (Number.isNaN(parsed)) {
    process.stderr.write(`[WARN] ${key}="${raw}" is not a valid integer, using default ${fallback}\n`)
    return fallback
  }
  return parsed
}

export function loadConfig(): AgentConfig {
  return {
    token: getRequiredEnv("CLAUDE_CODE_OAUTH_TOKEN"),
    timeoutMs: getOptionalEnvInt("CLAUDE_AGENT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    maxRetries: getOptionalEnvInt("CLAUDE_AGENT_MAX_RETRIES", DEFAULT_MAX_RETRIES),
    initialRetryDelayMs: getOptionalEnvInt("CLAUDE_AGENT_RETRY_DELAY_MS", DEFAULT_INITIAL_RETRY_DELAY_MS),
    historyDir: Bun.env.CLAUDE_AGENT_HISTORY_DIR ?? DEFAULT_HISTORY_DIR,
    skipPermissions: Bun.env.CLAUDE_AGENT_SKIP_PERMISSIONS !== "0",
    useDocker: Bun.env.CLAUDE_AGENT_DOCKER === "1",
    dockerImage: Bun.env.CLAUDE_AGENT_DOCKER_IMAGE ?? "claude-agent:latest",
    systemPrompt: Bun.env.CLAUDE_AGENT_SYSTEM_PROMPT || undefined,
  }
}
