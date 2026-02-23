/**
 * Claude Agent — Telegram Bot entry point.
 *
 * Every Telegram chat gets its own Claude session with infinite memory.
 * Sessions are persisted to SQLite and survive process restarts.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=<token> CLAUDE_CODE_OAUTH_TOKEN=<token> bun run telegram.ts
 */

import { Bot } from "grammy"
import { loadConfig } from "./src/config"
import { Database } from "./src/db"
import { Agent } from "./src/agent"
import { AgentPool } from "./src/agent-pool"
import { HistoryManager } from "./src/history"
import { SessionStore } from "./src/session-store"
import { RuntimeConfig } from "./src/runtime-config"
import { ChatQueue } from "./src/chat-queue"
import { Scheduler } from "./src/scheduler"
import { logger } from "./src/logger"
import type { LogLevel } from "./src/types"
import { registerCommands } from "./src/telegram/commands"
import { registerHandlers, type TelegramDeps } from "./src/telegram/handlers"
import { validateWhisperDeps, type WhisperConfig } from "./src/whisper"
import { buildMemoryContext } from "./src/memory"
import { getMcpServerNames } from "./src/mcp-config"
import { HealthMonitor } from "./src/health"
import { generateTeamIdentities } from "./src/agent-identity"

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

// MCP disabled — startup overhead too high for sandbox agents
// if (!agentConfig.mcpConfigPath) {
//   agentConfig.mcpConfigPath = join(dirname(agentConfig.dbPath), "mcp.json")
// }
// ensureMcpConfig(agentConfig.mcpConfigPath)

const db = new Database(agentConfig.dbPath)
const store = new SessionStore(db)
const runtimeConfig = new RuntimeConfig(db, agentConfig)

const adminId = Bun.env.TELEGRAM_ADMIN_ID ? Number(Bun.env.TELEGRAM_ADMIN_ID) : null
function isAdmin(chatId: number): boolean {
  return adminId !== null && chatId === adminId
}

const team = generateTeamIdentities(agentConfig.maxConcurrentPerChat)
const teamRoster = team.map((t) => `${t.emoji} ${t.name}`).join(", ")

logger.info("Starting Telegram bot", {
  dbPath: agentConfig.dbPath,
  hasSystemPrompt: !!agentConfig.systemPrompt,
  adminId: adminId ?? "not set",
  maxConcurrent: agentConfig.maxConcurrentPerChat,
  team: teamRoster,
})

const bot = new Bot(botToken)

// ---------------------------------------------------------------------------
// Agent / History caches (LRU)
// ---------------------------------------------------------------------------

const MAX_AGENTS = 500
const agentPools = new Map<number, AgentPool>()
const histories = new Map<number, HistoryManager>()
const chatQueue = new ChatQueue(agentConfig.maxConcurrentPerChat)
runtimeConfig.setOnMaxConcurrentChange((n) => chatQueue.setMaxConcurrency(n))
const botStartedAt = Date.now()

function getAgentPool(chatId: number): AgentPool {
  if (agentPools.has(chatId)) {
    const pool = agentPools.get(chatId)!
    // LRU refresh
    agentPools.delete(chatId)
    agentPools.set(chatId, pool)
    return pool
  }

  // Create primary agent
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

  // LRU eviction
  if (agentPools.size >= MAX_AGENTS) {
    const oldestKey = agentPools.keys().next().value!
    const evicted = agentPools.get(oldestKey)
    evicted?.cleanup()
    agentPools.delete(oldestKey)
    histories.delete(oldestKey)
    logger.debug("Agent pool evicted (LRU)", { evictedChatId: oldestKey, mapSize: agentPools.size })
  }

  const pool = new AgentPool(chatId, agent, agentConfig, db)
  agentPools.set(chatId, pool)
  return pool
}

/** Backward-compatible wrapper — returns the primary agent */
function getAgent(chatId: number): Agent {
  return getAgentPool(chatId).getPrimary()
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
// Scheduler (DISABLED — uncomment to re-enable)
// ---------------------------------------------------------------------------

// const scheduler = new Scheduler(db, async (job) => {
//   const jobAgent = new Agent(agentConfig)
//   try {
//     const result = await jobAgent.call(job.prompt)
//     const identity = generateIdentity(job.jobId)
//     const header = formatIdentityHeader(identity, `⏰ Job #${job.jobId}`)
//     const meta = buildMeta(result)
//     const { chunks, parseMode } = formatForTelegram(result.text, `${header}\n${meta}`)
//     for (const chunk of chunks) {
//       try {
//         await bot.api.sendMessage(job.chatId, chunk, parseMode ? { parse_mode: parseMode } : {})
//       } catch {
//         await bot.api.sendMessage(job.chatId, chunk)
//       }
//     }
//     const files = jobAgent.listSandboxFiles()
//     for (const file of files) {
//       if (!file.path.startsWith("output/")) continue
//       try {
//         const data = readFileSync(join(jobAgent.sandboxDir, file.path))
//         if (data.length === 0 || data.length > MAX_FILE_SIZE) continue
//         const displayName = file.path.replace(/^output\//, "")
//         await bot.api.sendDocument(job.chatId, new InputFile(data, displayName), { caption: `📎 ${displayName}` })
//       } catch (err) {
//         logger.warn("Failed to send scheduled job file", { path: file.path, error: String(err) })
//       }
//     }
//     logger.info("Scheduled job completed", {
//       jobId: job.jobId,
//       chatId: job.chatId,
//       durationMs: result.durationMs,
//     })
//   } finally {
//     jobAgent.cleanup()
//   }
// })

// No-op stub — scheduler infrastructure stays intact but doesn't execute jobs
const scheduler = new Scheduler(db, async () => {})

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
    agentPools,
  },
  (msg) => {
    if (adminId) {
      bot.api.sendMessage(adminId, msg, { parse_mode: "HTML" }).catch(() => {})
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
  agentPools,
  histories,
  runtimeConfig,
  chatQueue,
  scheduler,
  whisperConfig,
  botStartedAt,
  isAdmin,
  getAgent,
  getAgentPool,
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
  // scheduler.stop()
  await bot.stop()

  // Clean up all agent pool sandboxes (temp directories)
  for (const [chatId, pool] of agentPools) {
    pool.cleanup()
    logger.debug("Agent pool cleaned up on shutdown", { chatId })
  }
  agentPools.clear()

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

// scheduler.start()
logger.info("Bot polling started")
bot.start({
  onStart: async (info) => {
    logger.info(`Bot online: @${info.username}`)

    // Start health monitoring (every 30 seconds)
    healthMonitor.start(30_000)

    // Send startup message to all known chats
    if (knownChatIds.length > 0) {
      const uptime = new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" })

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
          `> mcp:      ${getMcpServerNames().length} servers (${getMcpServerNames().join(", ")})\n` +
          `> team:     ${teamRoster}\n` +
          `> workers:  ${agentConfig.maxConcurrentPerChat}x per chat\n` +
          `> health:   every 30s\n` +
          `> chats:    ${knownChatIds.length}\n` +
          `> collab:   ${agentConfig.collaboration ? `enabled (max ${agentConfig.maxTeamAgents} agents)` : "disabled"}\n` +
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
