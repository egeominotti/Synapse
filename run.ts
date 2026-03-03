/**
 * Claude Agent — Telegram Bot entry point.
 *
 * Every Telegram chat gets its own Claude agent with infinite memory.
 * Sessions are persisted to SQLite and survive process restarts.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=<token> CLAUDE_CODE_OAUTH_TOKEN=<token> bun run run.ts
 */

import { Bot } from "grammy"
import { dirname } from "path"
import { loadConfig } from "./src/config"
import { Database } from "./src/db"
import { Agent } from "./src/agent"
import { HistoryManager } from "./src/history"
import { SessionStore } from "./src/session-store"
import { RuntimeConfig } from "./src/runtime-config"
import { logger } from "./src/logger"
import type { LogLevel } from "./src/types"
import { registerCommands } from "./src/telegram/commands"
import { registerHandlers, type TelegramDeps } from "./src/telegram/handlers"
import { validateWhisperDeps, type WhisperConfig } from "./src/whisper"
import { HealthMonitor } from "./src/health"
import { getMcpServerNames } from "./src/mcp-config"
import { Scheduler, type ScheduledJobData } from "./src/scheduler"
import { formatForTelegram } from "./src/formatter"

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const botToken = Bun.env.TELEGRAM_BOT_TOKEN
if (!botToken) {
  process.stderr.write("[FATAL] TELEGRAM_BOT_TOKEN not set\n")
  process.exit(1)
}

const agentConfig = loadConfig()
logger.setMinLevel((Bun.env.CLAUDE_AGENT_LOG_LEVEL ?? "INFO") as LogLevel)

// Set DATA_PATH so the embedded Worker shares the same SQLite DB as the MCP server
const dbDir = dirname(agentConfig.dbPath)
process.env.DATA_PATH = `${dbDir}/bunqueue.db`

const db = new Database(agentConfig.dbPath)
const store = new SessionStore(db)
const runtimeConfig = new RuntimeConfig(db, agentConfig)

const adminId = Bun.env.TELEGRAM_ADMIN_ID ? Number(Bun.env.TELEGRAM_ADMIN_ID) : null
function isAdmin(chatId: number): boolean {
  return adminId !== null && chatId === adminId
}

logger.info("Starting Telegram bot", {
  dbPath: agentConfig.dbPath,
  hasSystemPrompt: !!agentConfig.systemPrompt,
  adminId: adminId ?? "not set",
})

const bot = new Bot(botToken)

// ---------------------------------------------------------------------------
// Agent / History caches (LRU)
// ---------------------------------------------------------------------------

const MAX_AGENTS = 500
const agents = new Map<number, Agent>()
const histories = new Map<number, HistoryManager>()
const botStartedAt = Date.now()

function getAgent(chatId: number): Agent {
  if (agents.has(chatId)) {
    const agent = agents.get(chatId)!
    // LRU refresh
    agents.delete(chatId)
    agents.set(chatId, agent)
    return agent
  }

  // Create agent
  const savedSessionId = store.get(chatId)
  const chatAgentConfig = { ...agentConfig, chatId }
  const agent = new Agent(chatAgentConfig)

  if (savedSessionId) {
    agent.setSessionId(savedSessionId)
    logger.info("Session restored from DB", { chatId, sessionId: savedSessionId.slice(0, 16) + "..." })
  } else {
    logger.info("New agent created", { chatId })
  }

  // LRU eviction
  if (agents.size >= MAX_AGENTS) {
    const oldestKey = agents.keys().next().value!
    const evicted = agents.get(oldestKey)
    evicted?.cleanup()
    agents.delete(oldestKey)
    histories.delete(oldestKey)
    store.delete(oldestKey)
    logger.debug("Agent evicted (LRU)", {
      evictedChatId: oldestKey,
      mapSize: agents.size,
    })
  }

  agents.set(chatId, agent)
  return agent
}

function getHistory(chatId: number, agent: Agent): HistoryManager {
  if (!histories.has(chatId)) {
    histories.set(chatId, new HistoryManager(db))
  }
  const history = histories.get(chatId)!
  const sid = agent.getSessionId()
  if (sid && history.getCurrentSessionId() !== sid) {
    history.initSession(sid, chatId)
  }
  return history
}

async function persistSession(chatId: number, agent: Agent): Promise<void> {
  const sid = agent.getSessionId()
  if (sid && store.get(chatId) !== sid) {
    await store.set(chatId, sid)
    logger.debug("Session persisted", { chatId, sessionId: sid.slice(0, 16) + "..." })
  }
}

// ---------------------------------------------------------------------------
// Whisper (optional voice-to-text)
// ---------------------------------------------------------------------------

let whisperConfig: WhisperConfig | null = null
const hasGroq = !!agentConfig.groqApiKey
const hasLocalModel = !!agentConfig.whisperModelPath

if (hasGroq || hasLocalModel) {
  const localDeps = hasLocalModel ? await validateWhisperDeps() : { ok: false, missing: [] as string[] }

  if (hasGroq || localDeps.ok) {
    whisperConfig = {
      modelPath: agentConfig.whisperModelPath ?? "",
      language: agentConfig.whisperLanguage ?? "auto",
      threads: agentConfig.whisperThreads ?? 4,
      groqApiKey: agentConfig.groqApiKey,
    }
    const mode = hasGroq ? (localDeps.ok ? "groq + local fallback" : "groq only") : "local only"
    logger.info("Whisper enabled", { mode, model: whisperConfig.modelPath || "n/a", language: whisperConfig.language })
  } else {
    logger.warn("Whisper disabled: missing binaries and no Groq API key", { missing: localDeps.missing })
  }
}

// ---------------------------------------------------------------------------
// Health monitor
// ---------------------------------------------------------------------------

const healthMonitor = new HealthMonitor(
  {
    db,
    groqApiKey: agentConfig.groqApiKey,
    whisperModelPath: agentConfig.whisperModelPath,
    botStartedAt,
    agents,
  },
  (msg) => {
    if (adminId) {
      bot.api.sendMessage(adminId, msg, { parse_mode: "HTML" }).catch(() => {})
    }
  }
)

// ---------------------------------------------------------------------------
// Scheduler (bunqueue embedded Worker)
// ---------------------------------------------------------------------------

const scheduler = new Scheduler(
  async (data: ScheduledJobData) => {
    const agent = getAgent(data.chatId)
    const result = await agent.call(data.prompt)
    return result.text
  },
  async (chatId: number, text: string) => {
    const { html, plain } = formatForTelegram(text)
    try {
      await bot.api.sendMessage(chatId, `🔔 <b>Scheduled task:</b>\n\n${html}`, { parse_mode: "HTML" })
    } catch {
      await bot.api.sendMessage(chatId, `🔔 Scheduled task:\n\n${plain}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Register commands + handlers
// ---------------------------------------------------------------------------

const deps: TelegramDeps = {
  botToken,
  agentConfig,
  db,
  store,
  agents,
  histories,
  runtimeConfig,
  whisperConfig,
  botStartedAt,
  isAdmin,
  getAgent,
  getHistory,
  persistSession,
}

registerCommands(bot, deps)
registerHandlers(bot, deps)

// ---------------------------------------------------------------------------
// Error handling & startup
// ---------------------------------------------------------------------------

bot.catch((err) => {
  logger.error("Bot error", { error: String(err) })
})

const shutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal}, stopping bot...`)
  healthMonitor.stop()
  await scheduler.stop()
  await bot.stop()

  // Clean up all agent sandboxes (temp directories)
  for (const [chatId, agent] of agents) {
    agent.cleanup()
    logger.debug("Agent cleaned up on shutdown", { chatId })
  }
  agents.clear()

  db.close()
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

await store.load()
logger.info("Sessions loaded", { count: store.size })

// Save known chat IDs before clearing stale sessions (for startup message)
const knownChatIds = db.getAllKnownChatIds()

// Clear stale Claude CLI sessions — they don't survive process restarts
store.clearAll()
logger.info("Stale sessions cleared on startup")

// Cleanup old sessions on startup (90 days)
const deletedSessions = db.cleanupOldSessions(90)
const deletedOrphans = db.cleanupOrphanTelegramSessions()
if (deletedSessions > 0 || deletedOrphans > 0) {
  logger.info("Startup cleanup", { deletedSessions, deletedOrphans })
}

logger.info("Bot polling started")
bot.start({
  onStart: async (info) => {
    logger.info(`Bot online: @${info.username}`)

    // Start health monitoring (every 30 seconds)
    healthMonitor.start(30_000)

    // Start scheduler (bunqueue embedded Worker)
    scheduler.start()

    // Send startup message to all known chats
    if (knownChatIds.length > 0) {
      const uptime = new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" })

      const globalStats = db.getAllStats()
      for (const chatId of knownChatIds) {
        const msg =
          `<code>🧠 Synapse online</code>\n` +
          `<code>Neural pathways connected.</code>\n` +
          `<code>Axons firing. Dendrites listening.</code>\n\n` +
          `<code>` +
          `> system.boot()\n` +
          `> agent:    @${info.username}\n` +
          `> time:     ${uptime}\n` +
          `> session:  new\n` +
          `> db:       ${agentConfig.dbPath}\n` +
          `> memory:   ${globalStats ? `${globalStats.totalMessages} msg / ${globalStats.totalSessions} sessions` : "empty"}\n` +
          `> health:   every 30s\n` +
          `> chats:    ${knownChatIds.length}\n` +
          `> mcp:      ${getMcpServerNames().join(", ")}\n` +
          `> timeout:  ${agentConfig.timeoutMs > 0 ? `${agentConfig.timeoutMs / 1000}s` : "none"}\n` +
          `> retry:    ${agentConfig.maxRetries}x\n` +
          `> status:   ONLINE` +
          `</code>\n\n` +
          `<i>⚡ Synapse is ready.</i>`
        bot.api.sendMessage(chatId, msg, { parse_mode: "HTML" }).catch(() => {})
      }
    }
  },
})
