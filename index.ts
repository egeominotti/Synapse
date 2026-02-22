/**
 * Claude Agent REPL - Enterprise Edition
 *
 * Interactive conversational agent wrapping the `claude` CLI.
 * Features: retry with backoff, timeout, structured logging,
 * conversation persistence, slash commands, graceful shutdown.
 *
 * Usage:
 *   CLAUDE_CODE_OAUTH_TOKEN=<token> bun run index.ts
 *
 * Environment variables:
 *   CLAUDE_CODE_OAUTH_TOKEN     (required) OAuth token for Claude CLI
 *   CLAUDE_AGENT_TIMEOUT_MS     (optional) Call timeout in ms, default 120000
 *   CLAUDE_AGENT_MAX_RETRIES    (optional) Max retry attempts, default 3
 *   CLAUDE_AGENT_RETRY_DELAY_MS (optional) Initial retry delay in ms, default 1000
 *   CLAUDE_AGENT_HISTORY_DIR    (optional) History directory path
 *   CLAUDE_AGENT_LOG_LEVEL      (optional) Log level: DEBUG|INFO|WARN|ERROR
 *   CLAUDE_AGENT_DOCKER         (optional) Set to "1" to sandbox each spawn in Docker
 *   CLAUDE_AGENT_DOCKER_IMAGE   (optional) Docker image name (default: claude-agent:latest)
 *   CLAUDE_AGENT_SKIP_PERMISSIONS (optional) Set to "0" to disable --dangerously-skip-permissions (enabled by default)
 */

import { loadConfig } from "./src/config"
import { Agent } from "./src/agent"
import { HistoryManager } from "./src/history"
import { Repl } from "./src/repl"
import { logger } from "./src/logger"
import { formatDuration } from "./src/utils"
import type { LogLevel } from "./src/types"

async function main(): Promise<void> {
  // Load configuration (exits on missing required env vars)
  const config = loadConfig()

  // Configure log level
  const logLevel = (Bun.env.CLAUDE_AGENT_LOG_LEVEL ?? "INFO") as LogLevel
  logger.setMinLevel(logLevel)

  logger.info("Starting Claude Agent", {
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    historyDir: config.historyDir,
  })

  // Initialize components
  const agent = new Agent(config)
  const history = new HistoryManager(config.historyDir)
  const repl = new Repl(agent, history)

  // Graceful shutdown handler
  let isShuttingDown = false

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return
    isShuttingDown = true

    repl.stopSpinner()   // clear any in-flight spinner before writing output
    process.stdout.write("\n")
    logger.info(`Received ${signal}, shutting down gracefully`)

    // Restore cursor visibility
    process.stdout.write("\x1b[?25h")

    // Persist history
    await history.shutdown()

    // Print final stats
    const stats = history.getStats()
    if (stats && stats.totalMessages > 0) {
      process.stdout.write(
        `\n\x1b[90m[Sessione terminata: ${stats.totalMessages} messaggi, ` +
        `durata totale ${formatDuration(stats.totalDurationMs)}]\x1b[0m\n`
      )
    }

    process.stdout.write("\x1b[1;36mArrivederci.\x1b[0m\n\n")
    process.exit(0)
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  // Restore cursor and persist on any unexpected crash.
  // These handlers MUST be synchronous — Node/Bun exits when the handler returns,
  // so async work after the first await is not guaranteed to run.
  // We kick off async flush best-effort and chain process.exit(1) on completion.
  const crashHandler = (err: unknown, origin: string): void => {
    process.stdout.write("\x1b[?25h") // restore cursor synchronously
    process.stderr.write(`\n[FATAL] ${origin}: ${String(err)}\n`)
    // Best-effort async history flush; exit(1) regardless of outcome
    history.shutdown()
      .catch(() => {})
      .finally(() => process.exit(1))
  }
  process.on("uncaughtException", (err) => crashHandler(err, "uncaughtException"))
  process.on("unhandledRejection", (err) => crashHandler(err, "unhandledRejection"))

  // Run the REPL
  try {
    await repl.run()
  } catch (err) {
    logger.error("REPL crashed unexpectedly", { error: String(err) })
  }

  // Normal exit (user typed /exit or EOF).
  // Guard against race with SIGINT/SIGTERM which also calls history.shutdown().
  if (isShuttingDown) return
  isShuttingDown = true

  await history.shutdown()

  const stats = history.getStats()
  if (stats && stats.totalMessages > 0) {
    process.stdout.write(
      `\n\x1b[90m[Sessione terminata: ${stats.totalMessages} messaggi, ` +
      `durata totale ${formatDuration(stats.totalDurationMs)}]\x1b[0m\n`
    )
  }

  process.stdout.write("\x1b[1;36mArrivederci.\x1b[0m\n\n")
}

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) })
  process.exit(1)
})
