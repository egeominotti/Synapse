/**
 * Claude Agent — Telegram Bot entry point.
 *
 * Every Telegram chat gets its own Claude session with infinite memory.
 * Sessions are persisted to SQLite and survive process restarts.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=<token> CLAUDE_CODE_OAUTH_TOKEN=<token> bun run telegram.ts
 */

import { Bot, InputFile } from "grammy"
import { readFileSync } from "fs"
import { join } from "path"
import { loadConfig } from "./src/config"
import { Database } from "./src/db"
import { Agent } from "./src/agent"
import { HistoryManager } from "./src/history"
import { SessionStore } from "./src/session-store"
import { RuntimeConfig } from "./src/runtime-config"
import { ChatQueue } from "./src/chat-queue"
import { Scheduler } from "./src/scheduler"
import { logger } from "./src/logger"
import { formatForTelegram } from "./src/formatter"
import type { LogLevel } from "./src/types"
import { registerCommands } from "./src/telegram/commands"
import { registerHandlers, buildMeta, snapshotSandbox, MAX_FILE_SIZE, type TelegramDeps } from "./src/telegram/handlers"
import { buildMemoryContext } from "./src/memory"

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const botToken = Bun.env.TELEGRAM_BOT_TOKEN
if (!botToken) {
  process.stderr.write("[FATAL] TELEGRAM_BOT_TOKEN non settato\n")
  process.exit(1)
}

const agentConfig = loadConfig()
logger.setMinLevel((Bun.env.CLAUDE_AGENT_LOG_LEVEL ?? "INFO") as LogLevel)

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
const chatQueue = new ChatQueue()
const botStartedAt = Date.now()

function getAgent(chatId: number): Agent {
  if (agents.has(chatId)) {
    const agent = agents.get(chatId)!
    agents.delete(chatId)
    agents.set(chatId, agent)
    return agent
  }

  const savedSessionId = store.get(chatId)
  let agent: Agent

  if (savedSessionId) {
    agent = new Agent(agentConfig)
    agent.setSessionId(savedSessionId)
    logger.info("Session restored from DB", { chatId, sessionId: savedSessionId.slice(0, 16) + "..." })
  } else {
    // New session — inject conversation memory into system prompt
    const recentMessages = db.getRecentMessagesByChatId(chatId, 30)
    const memory = buildMemoryContext(recentMessages)
    if (memory) {
      const basePrompt = agentConfig.systemPrompt ?? ""
      agent = new Agent({ ...agentConfig, systemPrompt: basePrompt + "\n\n" + memory })
      logger.info("New agent with memory", { chatId, memoryMessages: recentMessages.length })
    } else {
      agent = new Agent(agentConfig)
      logger.info("New agent created", { chatId })
    }
  }

  if (agents.size >= MAX_AGENTS) {
    const oldestKey = agents.keys().next().value!
    const evicted = agents.get(oldestKey)
    evicted?.cleanup()
    agents.delete(oldestKey)
    histories.delete(oldestKey)
    logger.debug("Agent evicted (LRU)", { evictedChatId: oldestKey, mapSize: agents.size })
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
// Scheduler
// ---------------------------------------------------------------------------

const scheduler = new Scheduler(db, async (job) => {
  const agent = getAgent(job.chatId)
  const before = snapshotSandbox(agent)
  const result = await agent.call(job.prompt)

  const history = getHistory(job.chatId, agent)
  await history.addMessage({
    timestamp: new Date().toISOString(),
    prompt: `[scheduled] ${job.prompt}`,
    response: result.text,
    durationMs: result.durationMs,
    tokenUsage: result.tokenUsage,
  })
  await persistSession(job.chatId, agent)

  const meta = buildMeta(result)
  const { chunks, parseMode } = formatForTelegram(result.text, `⏰ ${meta}`)
  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(job.chatId, chunk, parseMode ? { parse_mode: parseMode } : {})
    } catch {
      await bot.api.sendMessage(job.chatId, chunk)
    }
  }

  const after = agent.listSandboxFiles()
  const newFiles = after.filter((f) => {
    const prevMtime = before.get(f.path)
    return prevMtime === undefined || f.mtimeMs > prevMtime
  })
  for (const file of newFiles) {
    try {
      const data = readFileSync(join(agent.sandboxDir, file.path))
      if (data.length === 0 || data.length > MAX_FILE_SIZE) continue
      await bot.api.sendDocument(job.chatId, new InputFile(data, file.path), { caption: `📎 ${file.path}` })
    } catch (err) {
      logger.warn("Failed to send scheduled job file", { path: file.path, error: String(err) })
    }
  }
})

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
  chatQueue,
  scheduler,
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
  scheduler.stop()
  await bot.stop()
  db.close()
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

await store.load()
logger.info("Sessions loaded", { count: store.size })

// Save known chat IDs before clearing stale sessions (for startup message)
const knownChatIds = db.getAllTelegramSessions().map((s) => s.chat_id)

// Clear stale Claude CLI sessions — they don't survive process restarts
store.clearAll()
logger.info("Stale sessions cleared on startup")

// Cleanup old sessions on startup (90 days)
const deletedSessions = db.cleanupOldSessions(90)
const deletedOrphans = db.cleanupOrphanTelegramSessions()
if (deletedSessions > 0 || deletedOrphans > 0) {
  logger.info("Startup cleanup", { deletedSessions, deletedOrphans })
}

scheduler.start()
logger.info("Bot polling started")
bot.start({
  onStart: async (info) => {
    logger.info(`Bot online: @${info.username}`)

    // Send startup message to all known chats
    if (knownChatIds.length > 0) {
      const uptime = new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" })

      const globalStats = db.getAllStats()
      for (const chatId of knownChatIds) {
        const msg =
          `<code>Wake up, Neo...</code>\n` +
          `<code>The Matrix has you...</code>\n` +
          `<code>Follow the white rabbit.</code>\n\n` +
          `<code>` +
          `> system.boot()\n` +
          `> agent:    @${info.username}\n` +
          `> time:     ${uptime}\n` +
          `> session:  new\n` +
          `> db:       ${agentConfig.dbPath}\n` +
          `> memory:   ${globalStats ? `${globalStats.totalMessages} msg / ${globalStats.totalSessions} sessions` : "empty"}\n` +
          `> sandbox:  pending\n` +
          `> chats:    ${knownChatIds.length}\n` +
          `> timeout:  ${agentConfig.timeoutMs > 0 ? `${agentConfig.timeoutMs / 1000}s` : "none"}\n` +
          `> retry:    ${agentConfig.maxRetries}x\n` +
          `> status:   ONLINE` +
          `</code>\n\n` +
          `<i>Knock, knock, Neo.</i>`
        bot.api.sendMessage(chatId, msg, { parse_mode: "HTML" }).catch(() => {})
      }
    }
  },
})
