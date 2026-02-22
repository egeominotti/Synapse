/**
 * Claude Agent — Telegram Bot
 *
 * Every Telegram chat gets its own Claude session with infinite memory.
 * Sessions are persisted to SQLite and survive process restarts.
 * Supports text messages and photos (jpg/png/webp/gif).
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=<token> CLAUDE_CODE_OAUTH_TOKEN=<token> bun run telegram.ts
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN          (required) Telegram bot token from @BotFather
 *   CLAUDE_CODE_OAUTH_TOKEN     (required) OAuth token for Claude CLI
 *   CLAUDE_AGENT_SYSTEM_PROMPT  (optional) System prompt defining the agent's persona
 *   CLAUDE_AGENT_DB_PATH        (optional) SQLite database path, default ~/.claude-agent/neo.db
 *   CLAUDE_AGENT_LOG_LEVEL      (optional) DEBUG|INFO|WARN|ERROR (default: INFO)
 *   CLAUDE_AGENT_SKIP_PERMISSIONS (optional) Set "0" to disable skip-permissions
 *   TELEGRAM_ADMIN_ID             (optional) Telegram chat ID of the admin (only admin can /config)
 */

import { Bot, InputFile, type Context } from "grammy"
import { readFileSync } from "fs"
import { join, extname } from "path"
import { loadConfig } from "./src/config"
import { Database } from "./src/db"
import { Agent } from "./src/agent"
import { HistoryManager } from "./src/history"
import { SessionStore } from "./src/session-store"
import { RuntimeConfig } from "./src/runtime-config"
import { ChatQueue } from "./src/chat-queue"
import { Scheduler, parseSchedule } from "./src/scheduler"
import { logger } from "./src/logger"
import { formatForTelegram } from "./src/formatter"
import type { AgentCallResult, LogLevel, RuntimeConfigKey } from "./src/types"

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

// Admin ID — only this user can use /config
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

// One Agent per chat — each has its own sessionId and conversation memory.
// LRU eviction: when the map exceeds MAX_AGENTS, the oldest entry is removed
// to prevent unbounded memory growth from thousands of distinct chats.
const MAX_AGENTS = 500
const agents = new Map<number, Agent>()

/** Get or create an agent for this chat, restoring saved session if available */
function getAgent(chatId: number): Agent {
  // Move existing entry to end (most-recently-used) on access
  if (agents.has(chatId)) {
    const agent = agents.get(chatId)!
    agents.delete(chatId)
    agents.set(chatId, agent)
    return agent
  }

  const agent = new Agent(agentConfig)
  const savedSessionId = store.get(chatId)
  if (savedSessionId) {
    agent.setSessionId(savedSessionId)
    logger.info("Session restored from DB", { chatId, sessionId: savedSessionId.slice(0, 16) + "..." })
  } else {
    logger.info("New agent created", { chatId })
  }

  // Evict oldest (least-recently-used) agent if at capacity
  if (agents.size >= MAX_AGENTS) {
    const oldestKey = agents.keys().next().value!
    agents.delete(oldestKey)
    logger.debug("Agent evicted (LRU)", { evictedChatId: oldestKey, mapSize: agents.size })
  }

  agents.set(chatId, agent)
  return agent
}

/** Get or create a HistoryManager for a chat, synced with agent session */
function getHistory(chatId: number, agent: Agent): HistoryManager {
  if (!histories.has(chatId)) {
    histories.set(chatId, new HistoryManager(db))
  }
  const history = histories.get(chatId)!
  const sid = agent.getSessionId()
  if (sid && history.getCurrentSessionId() !== sid) {
    history.initSession(sid)
  }
  return history
}

// Per-chat history managers (follows same LRU pattern as agents)
const histories = new Map<number, HistoryManager>()

// Serial queue: one Claude call at a time per chat
const chatQueue = new ChatQueue()

// Bot start time for uptime tracking
const botStartedAt = Date.now()

// Scheduler: executes due jobs via Agent + sends response to chat
const scheduler = new Scheduler(db, async (job) => {
  const agent = getAgent(job.chatId)
  const before = snapshotSandbox(agent)
  const result = await agent.call(job.prompt)

  // Persist message
  const history = getHistory(job.chatId, agent)
  await history.addMessage({
    timestamp: new Date().toISOString(),
    prompt: `[scheduled] ${job.prompt}`,
    response: result.text,
    durationMs: result.durationMs,
    tokenUsage: result.tokenUsage,
  })
  await persistSession(job.chatId, agent)

  // Send response to chat
  const meta = buildMeta(result)
  const { chunks, parseMode } = formatForTelegram(result.text, `⏰ ${meta}`)
  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(job.chatId, chunk, parseMode ? { parse_mode: parseMode } : {})
    } catch {
      await bot.api.sendMessage(job.chatId, chunk)
    }
  }

  // Send any files created by the scheduled job
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

/** Persist session after a successful call */
async function persistSession(chatId: number, agent: Agent): Promise<void> {
  const sid = agent.getSessionId()
  if (sid && store.get(chatId) !== sid) {
    await store.set(chatId, sid)
    logger.debug("Session persisted", { chatId, sessionId: sid.slice(0, 16) + "..." })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build plain-text metadata line (used in footer) */
function buildMeta(result: AgentCallResult): string {
  const secs = (result.durationMs / 1000).toFixed(1)
  const parts: string[] = [`⏱ ${secs}s`]
  if (result.tokenUsage) {
    const { inputTokens: i, outputTokens: o } = result.tokenUsage
    parts.push(`🔤 ${i} → ${o} tok`)
  }
  return parts.join("  ·  ")
}

/** Send "typing..." action while Claude is thinking */
async function withTyping(ctx: Context, fn: () => Promise<void>): Promise<void> {
  const typingInterval = setInterval(() => {
    ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {})
  }, 4_000)
  ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {})
  try {
    await fn()
  } finally {
    clearInterval(typingInterval)
  }
}

/** Max file size to send via Telegram (50 MB limit, we cap at 20 MB) */
const MAX_FILE_SIZE = 20 * 1024 * 1024

/** Snapshot of sandbox files before a call — used to detect new files */
type FileSnapshot = Map<string, number>

/** Take a snapshot of all files in the agent's sandbox */
function snapshotSandbox(agent: Agent): FileSnapshot {
  const files = agent.listSandboxFiles()
  return new Map(files.map((f) => [f.path, f.mtimeMs]))
}

/** Send files created/modified in the sandbox since the snapshot */
async function sendSandboxFiles(ctx: Context, agent: Agent, before: FileSnapshot): Promise<void> {
  const after = agent.listSandboxFiles()
  const newFiles = after.filter((f) => {
    const prevMtime = before.get(f.path)
    return prevMtime === undefined || f.mtimeMs > prevMtime
  })

  if (newFiles.length === 0) return

  for (const file of newFiles) {
    const fullPath = join(agent.sandboxDir, file.path)
    try {
      const data = readFileSync(fullPath)
      if (data.length === 0) continue
      if (data.length > MAX_FILE_SIZE) {
        await ctx.reply(
          `⚠️ File troppo grande per Telegram: ${file.path} (${(data.length / 1024 / 1024).toFixed(1)} MB)`
        )
        continue
      }

      const ext = extname(file.path).toLowerCase()
      const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]

      if (imageExts.includes(ext)) {
        await ctx.replyWithDocument(new InputFile(data, file.path), {
          caption: `📎 ${file.path}`,
        })
      } else {
        await ctx.replyWithDocument(new InputFile(data, file.path), {
          caption: `📎 ${file.path}`,
        })
      }

      logger.debug("Sandbox file sent", { path: file.path, size: data.length })
    } catch (err) {
      logger.warn("Failed to send sandbox file", { path: file.path, error: String(err) })
    }
  }
}

/** Send Claude's response as formatted HTML with meta footer appended */
async function sendFormatted(ctx: Context, markdown: string, result: AgentCallResult): Promise<void> {
  const meta = buildMeta(result)
  const { chunks, parseMode } = formatForTelegram(markdown, meta)
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, parseMode ? { parse_mode: parseMode } : {})
    } catch {
      // HTML parsing failed on Telegram side — retry as plain text
      await ctx.reply(chunk)
    }
  }
}

/** Download a Telegram file and return it as base64 */
async function downloadFileAsBase64(ctx: Context, fileId: string): Promise<{ base64: string; mediaType: string }> {
  const file = await ctx.api.getFile(fileId)
  const filePath = file.file_path!
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`)

  const buffer = await res.arrayBuffer()
  const base64 = Buffer.from(buffer).toString("base64")

  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  const mediaTypeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  }
  const mediaType = mediaTypeMap[ext] ?? "image/jpeg"

  return { base64, mediaType }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 Ciao! Sono il tuo agente Claude.\n\n" +
      "Scrivimi qualcosa o mandami una foto.\n\n" +
      "/help — comandi disponibili\n" +
      "/reset — nuova conversazione\n" +
      "/stats — statistiche sessione"
  )
})

bot.command("help", async (ctx) => {
  const lines = [
    "📋 *Comandi disponibili:*\n",
    "/start — messaggio di benvenuto",
    "/reset — resetta la conversazione",
    "/stats — statistiche sessione corrente",
    "/export — esporta conversazione come file",
    "/schedule — programma un job schedulato",
    "/jobs — lista job attivi",
    "/ping — stato del bot",
  ]
  if (isAdmin(ctx.chat.id)) {
    lines.push("/config — configurazione runtime (admin)")
  }
  lines.push(
    "",
    "💬 Scrivi qualsiasi messaggio per parlare con Claude.",
    "📷 Manda una foto (con o senza didascalia) per analisi visiva.",
    "✏️ Modifica un messaggio per reinviarlo a Claude."
  )
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
})

bot.command("reset", async (ctx) => {
  const chatId = ctx.chat.id
  agents.delete(chatId)
  histories.delete(chatId)
  await store.delete(chatId)
  logger.info("Session reset", { chatId })
  await ctx.reply("🔄 Sessione resettata. Puoi iniziare una nuova conversazione.")
})

bot.command("stats", async (ctx) => {
  const chatId = ctx.chat.id
  const agent = agents.get(chatId)
  const savedSid = store.get(chatId)
  const sid = agent?.getSessionId() ?? savedSid

  const lines = [
    `📊 *Sessione corrente:*\n`,
    `Session ID: \`${sid ? sid.slice(0, 16) + "..." : "nessuna"}\``,
    `Persistenza: ${savedSid ? "✅ salvata in DB" : "⏳ non ancora salvata"}`,
  ]

  if (sid) {
    const stats = db.getSessionStats(sid)
    if (stats) {
      const avgMs = Math.round(stats.totalDurationMs / stats.totalMessages)
      const totalTok = stats.totalInputTokens + stats.totalOutputTokens
      lines.push("")
      lines.push(`Messaggi: *${stats.totalMessages}*`)
      lines.push(`Durata media: *${(avgMs / 1000).toFixed(1)}s*`)
      if (totalTok > 0) {
        lines.push(
          `Token: *${totalTok.toLocaleString("it-IT")}* (${stats.totalInputTokens.toLocaleString("it-IT")} in / ${stats.totalOutputTokens.toLocaleString("it-IT")} out)`
        )
      }
      const attachments = db.getAttachmentsBySession(sid)
      if (attachments.length > 0) {
        lines.push(`Foto: *${attachments.length}*`)
      }
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
})

bot.command("ping", async (ctx) => {
  const uptimeMs = Date.now() - botStartedAt
  const uptimeSec = Math.floor(uptimeMs / 1000)
  const h = Math.floor(uptimeSec / 3600)
  const m = Math.floor((uptimeSec % 3600) / 60)
  const s = uptimeSec % 60
  const uptime = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`

  const lines = [
    "🏓 *Pong!*\n",
    `Uptime: *${uptime}*`,
    `Agenti attivi: *${agents.size}*`,
    `Sessioni Telegram: *${store.size}*`,
    `Coda messaggi: *${chatQueue.size}*`,
    `DB: ✅ operativo`,
  ]

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
})

// ---------------------------------------------------------------------------
// Export command
// ---------------------------------------------------------------------------

bot.command("export", async (ctx) => {
  const chatId = ctx.chat.id
  const agent = agents.get(chatId)
  const savedSid = store.get(chatId)
  const sid = agent?.getSessionId() ?? savedSid

  if (!sid) {
    await ctx.reply("📭 Nessuna sessione da esportare. Inizia una conversazione prima.")
    return
  }

  const messages = db.getMessages(sid)
  if (messages.length === 0) {
    await ctx.reply("📭 Sessione vuota, niente da esportare.")
    return
  }

  // Build markdown document
  const lines: string[] = [`# Sessione ${sid.slice(0, 16)}`, ""]

  for (const msg of messages) {
    const date = new Date(msg.timestamp).toLocaleString("it-IT", { timeZone: "Europe/Rome" })
    lines.push(`## 👤 Utente — ${date}`)
    lines.push("", msg.prompt, "")
    lines.push(`## 🤖 Claude — ${(msg.duration_ms / 1000).toFixed(1)}s`)
    lines.push("", msg.response, "")
    lines.push("---", "")
  }

  const content = lines.join("\n")
  const filename = `sessione-${sid.slice(0, 8)}.md`
  const blob = new Blob([content], { type: "text/markdown" })
  const buffer = Buffer.from(await blob.arrayBuffer())

  await ctx.replyWithDocument(new InputFile(buffer, filename), {
    caption: `📄 ${messages.length} messaggi esportati`,
  })
})

// ---------------------------------------------------------------------------
// Schedule commands
// ---------------------------------------------------------------------------

bot.command("schedule", async (ctx) => {
  const text = ctx.message?.text ?? ""
  const args = text.replace(/^\/schedule\s*/, "").trim()

  if (!args) {
    await ctx.reply(
      "⏰ *Uso:*\n\n" +
        "`/schedule at 18:00 <prompt>` — una volta\n" +
        "`/schedule every 09:00 <prompt>` — ricorrente\n" +
        "`/schedule in 30m <prompt>` — dopo un delay\n\n" +
        "Esempi:\n" +
        "`/schedule at 18:00 Ricordami di chiamare Mario`\n" +
        "`/schedule every 09:00 Buongiorno! Programmi per oggi?`\n" +
        "`/schedule in 2h Controlla lo stato del deploy`",
      { parse_mode: "Markdown" }
    )
    return
  }

  // Split: schedule expression + prompt
  // Patterns: "at HH:MM ...", "every HH:MM ...", "in Nm ...", "in Nh ..."
  const exprMatch = args.match(
    /^((?:at|every|alle|ogni)\s+\d{1,2}:\d{2}|in\s+\d+\s*[mh](?:in|ore|ora|inuti)?)\s+(.+)$/i
  )
  if (!exprMatch) {
    await ctx.reply("❌ Formato non valido.\n\nUsa: `/schedule at 18:00 <prompt>`, `/schedule in 30m <prompt>`", {
      parse_mode: "Markdown",
    })
    return
  }

  const scheduleExpr = exprMatch[1]
  const prompt = exprMatch[2]

  try {
    const spec = parseSchedule(scheduleExpr)
    const jobId = scheduler.createJob(ctx.chat.id, prompt, spec)

    const runAtStr = spec.runAt.toLocaleString("it-IT", { timeZone: "Europe/Rome" })
    const typeLabel = spec.type === "recurring" ? "🔄 Ricorrente" : spec.type === "delay" ? "⏳ Delay" : "📌 Una volta"

    await ctx.reply(
      `✅ Job #${jobId} creato\n\n` +
        `${typeLabel}\n` +
        `Prossima esecuzione: *${runAtStr}*\n` +
        `Prompt: _${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}_`,
      { parse_mode: "Markdown" }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`❌ ${msg}`)
  }
})

bot.command("jobs", async (ctx) => {
  const jobs = db.getJobsByChat(ctx.chat.id)

  if (jobs.length === 0) {
    await ctx.reply("📭 Nessun job attivo. Usa /schedule per crearne uno.")
    return
  }

  const lines = [`⏰ *Job attivi (${jobs.length}):*\n`]

  for (const job of jobs) {
    const runAt = new Date(job.run_at).toLocaleString("it-IT", { timeZone: "Europe/Rome" })
    const typeEmoji = job.schedule_type === "recurring" ? "🔄" : job.schedule_type === "delay" ? "⏳" : "📌"
    const promptPreview = job.prompt.slice(0, 60) + (job.prompt.length > 60 ? "..." : "")
    lines.push(`${typeEmoji} *#${job.id}* — ${runAt}`)
    lines.push(`  _${promptPreview}_\n`)
  }

  lines.push("Usa `/job delete <id>` per eliminare un job.")
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
})

bot.command("job", async (ctx) => {
  const text = ctx.message?.text ?? ""
  const args = text.replace(/^\/job\s*/, "").trim()

  const deleteMatch = args.match(/^delete\s+(\d+)$/)
  if (!deleteMatch) {
    await ctx.reply("Uso: `/job delete <id>`", { parse_mode: "Markdown" })
    return
  }

  const jobId = parseInt(deleteMatch[1], 10)
  const deleted = db.deleteJob(jobId, ctx.chat.id)

  if (deleted) {
    await ctx.reply(`✅ Job #${jobId} eliminato.`)
  } else {
    await ctx.reply(`❌ Job #${jobId} non trovato o non appartiene a questa chat.`)
  }
})

// ---------------------------------------------------------------------------
// Config command (admin only)
// ---------------------------------------------------------------------------

bot.command("config", async (ctx) => {
  const chatId = ctx.chat.id

  if (!isAdmin(chatId)) {
    await ctx.reply("🔒 Non autorizzato. Solo l'admin puo' configurare il bot.")
    return
  }

  const text = ctx.message?.text ?? ""
  const args = text.replace(/^\/config\s*/, "").trim()

  // /config — show all
  if (!args) {
    const all = runtimeConfig.getAll()
    const lines = ["⚙️ *Configurazione corrente:*\n"]
    for (const item of all) {
      const modified = item.value !== item.defaultValue ? " ✏️" : ""
      const val = item.value || '""'
      lines.push(`\`${item.key}\` = \`${val}\`${modified}`)
      lines.push(`  _${item.description}_\n`)
    }
    lines.push("_Usa /config <key> <value> per modificare_")
    lines.push("_Usa /config reset per ripristinare i default_")
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
    return
  }

  // /config reset — reset all
  if (args === "reset") {
    runtimeConfig.resetAll()
    await ctx.reply("✅ Configurazione ripristinata ai default.")
    return
  }

  // /config reset <key> — reset single
  if (args.startsWith("reset ")) {
    const key = args.slice(6).trim()
    if (!runtimeConfig.isValidKey(key)) {
      await ctx.reply(
        `❌ Chiave sconosciuta: \`${key}\`\n\nChiavi valide: ${runtimeConfig
          .getAllDefinitions()
          .map((d) => d.key)
          .join(", ")}`,
        { parse_mode: "Markdown" }
      )
      return
    }
    const { oldValue, defaultValue } = runtimeConfig.reset(key as RuntimeConfigKey)
    await ctx.reply(`✅ \`${key}\` ripristinato\n\n\`${oldValue}\` → \`${defaultValue}\``, { parse_mode: "Markdown" })
    return
  }

  const parts = args.split(/\s+/)
  const key = parts[0]

  if (!runtimeConfig.isValidKey(key)) {
    await ctx.reply(
      `❌ Chiave sconosciuta: \`${key}\`\n\nChiavi valide: ${runtimeConfig
        .getAllDefinitions()
        .map((d) => d.key)
        .join(", ")}`,
      { parse_mode: "Markdown" }
    )
    return
  }

  // /config <key> — show single
  if (parts.length === 1) {
    const def = runtimeConfig.getDefinition(key as RuntimeConfigKey)!
    const current = runtimeConfig.get(key as RuntimeConfigKey)
    const modified = current !== def.defaultValue ? " ✏️" : ""
    const lines = [
      `⚙️ \`${key}\`${modified}\n`,
      `Valore: \`${current || '""'}\``,
      `Default: \`${def.defaultValue || '""'}\``,
      `Tipo: ${def.type}`,
      `_${def.description}_`,
    ]
    if (def.min !== undefined) lines.push(`Min: ${def.min}`)
    if (def.max !== undefined) lines.push(`Max: ${def.max}`)
    if (def.enum) lines.push(`Valori: ${def.enum.join(", ")}`)
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
    return
  }

  // /config <key> <value> — set value
  const value = parts.slice(1).join(" ")
  try {
    const { oldValue, newValue } = runtimeConfig.set(key as RuntimeConfigKey, value)
    await ctx.reply(`✅ \`${key}\` aggiornato\n\n\`${oldValue || '""'}\` → \`${newValue || '""'}\``, {
      parse_mode: "Markdown",
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`❌ Errore: ${msg}`, { parse_mode: "Markdown" })
  }
})

// ---------------------------------------------------------------------------
// Text messages
// ---------------------------------------------------------------------------

/** Check if an error indicates an expired/invalid Claude session */
function isSessionError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase()
  return (
    lower.includes("invalid session") ||
    lower.includes("session not found") ||
    lower.includes("session_id") ||
    lower.includes("could not resume") ||
    lower.includes("unable to resume") ||
    (lower.includes("resume") && lower.includes("error"))
  )
}

/** Reset agent to a fresh session (no resume), keep DB history intact */
function resetAgentSession(chatId: number): Agent {
  const agent = new Agent(agentConfig)
  agents.set(chatId, agent)
  histories.delete(chatId)
  logger.info("Agent session reset (fresh)", { chatId })
  return agent
}

/** Core handler for text prompts (used by message + edited_message) */
async function handleTextPrompt(ctx: Context, prompt: string): Promise<void> {
  const chatId = ctx.chat!.id

  logger.info("Text message", { chatId, length: prompt.length })

  await withTyping(ctx, async () => {
    try {
      const agent = getAgent(chatId)
      const before = snapshotSandbox(agent)
      const result = await agent.call(prompt)

      // Persist message to DB
      const history = getHistory(chatId, agent)
      await history.addMessage({
        timestamp: new Date().toISOString(),
        prompt,
        response: result.text,
        durationMs: result.durationMs,
        tokenUsage: result.tokenUsage,
      })

      await sendFormatted(ctx, result.text, result)
      await sendSandboxFiles(ctx, agent, before)
      await persistSession(chatId, agent)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error("Text call failed", { chatId, error: msg })

      // If session expired, auto-retry with a fresh session (no resume)
      if (isSessionError(msg)) {
        logger.warn("Session expired, retrying with fresh session", { chatId })
        try {
          const freshAgent = resetAgentSession(chatId)
          const before = snapshotSandbox(freshAgent)
          const result = await freshAgent.call(prompt)

          const history = getHistory(chatId, freshAgent)
          await history.addMessage({
            timestamp: new Date().toISOString(),
            prompt,
            response: result.text,
            durationMs: result.durationMs,
            tokenUsage: result.tokenUsage,
          })

          await sendFormatted(ctx, result.text, result)
          await sendSandboxFiles(ctx, freshAgent, before)
          await persistSession(chatId, freshAgent)
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
          logger.error("Retry with fresh session also failed", { chatId, error: retryMsg })
          await ctx.reply(`❌ Errore: ${retryMsg}`)
        }
      } else {
        await ctx.reply(`❌ Errore: ${msg}`)
      }
    }
  })
}

bot.on("message:text", async (ctx) => {
  const prompt = ctx.message.text
  if (prompt.startsWith("/")) return
  await chatQueue.enqueue(ctx.chat.id, () => handleTextPrompt(ctx, prompt))
})

// ---------------------------------------------------------------------------
// Photo messages
// ---------------------------------------------------------------------------

/** Core handler for photo prompts (used by message + edited_message) */
async function handlePhotoPrompt(ctx: Context, fileId: string, caption: string): Promise<void> {
  const chatId = ctx.chat!.id

  logger.info("Photo message", { chatId, fileId, caption })

  await withTyping(ctx, async () => {
    try {
      const { base64, mediaType } = await downloadFileAsBase64(ctx, fileId)

      const agent = getAgent(chatId)
      const before = snapshotSandbox(agent)
      const result = await agent.callWithRawImage(mediaType, base64, caption)

      // Persist message + photo attachment to DB
      const history = getHistory(chatId, agent)
      const messageId = await history.addMessage({
        timestamp: new Date().toISOString(),
        prompt: `[foto] ${caption}`,
        response: result.text,
        durationMs: result.durationMs,
        tokenUsage: result.tokenUsage,
      })
      if (messageId) {
        history.addAttachment(messageId, mediaType, Buffer.from(base64, "base64"), fileId)
      }

      await sendFormatted(ctx, result.text, result)
      await sendSandboxFiles(ctx, agent, before)
      await persistSession(chatId, agent)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error("Photo call failed", { chatId, error: msg })

      if (isSessionError(msg)) {
        logger.warn("Session expired (photo), retrying with fresh session", { chatId })
        try {
          const freshAgent = resetAgentSession(chatId)
          const freshBefore = snapshotSandbox(freshAgent)
          const result = await freshAgent.callWithRawImage(mediaType, base64, caption)

          const history = getHistory(chatId, freshAgent)
          const messageId = await history.addMessage({
            timestamp: new Date().toISOString(),
            prompt: `[foto] ${caption}`,
            response: result.text,
            durationMs: result.durationMs,
            tokenUsage: result.tokenUsage,
          })
          if (messageId) {
            history.addAttachment(messageId, mediaType, Buffer.from(base64, "base64"), fileId)
          }

          await sendFormatted(ctx, result.text, result)
          await sendSandboxFiles(ctx, freshAgent, freshBefore)
          await persistSession(chatId, freshAgent)
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
          logger.error("Retry photo with fresh session also failed", { chatId, error: retryMsg })
          await ctx.reply(`❌ Errore analisi immagine: ${retryMsg}`)
        }
      } else {
        await ctx.reply(`❌ Errore analisi immagine: ${msg}`)
      }
    }
  })
}

bot.on("message:photo", async (ctx) => {
  const caption = ctx.message.caption ?? "Cosa vedi in questa immagine?"
  const largest = ctx.message.photo[ctx.message.photo.length - 1]
  await chatQueue.enqueue(ctx.chat.id, () => handlePhotoPrompt(ctx, largest.file_id, caption))
})

// ---------------------------------------------------------------------------
// Edited messages — re-process through Claude with [modifica] prefix
// ---------------------------------------------------------------------------

bot.on("edited_message:text", async (ctx) => {
  const edited = ctx.editedMessage!
  const prompt = edited.text
  if (!prompt || prompt.startsWith("/")) return
  const corrected = `[Messaggio modificato] ${prompt}`
  await chatQueue.enqueue(edited.chat.id, () => handleTextPrompt(ctx, corrected))
})

bot.on("edited_message:photo", async (ctx) => {
  const edited = ctx.editedMessage!
  const photos = edited.photo
  if (!photos || photos.length === 0) return
  const largest = photos[photos.length - 1]
  const caption = edited.caption ?? "Cosa vedi in questa immagine?"
  const corrected = `[Messaggio modificato] ${caption}`
  await chatQueue.enqueue(edited.chat.id, () => handlePhotoPrompt(ctx, largest.file_id, corrected))
})

// ---------------------------------------------------------------------------
// Error handling & start
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

// Load persisted sessions before starting
await store.load()
logger.info("Sessions loaded", { count: store.size })

// Start scheduler and bot
scheduler.start()
logger.info("Bot polling started")
bot.start({
  onStart: (info) => logger.info(`Bot online: @${info.username}`),
})
