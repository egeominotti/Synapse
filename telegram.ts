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
import { loadConfig } from "./src/config"
import { Database } from "./src/db"
import { Agent } from "./src/agent"
import { HistoryManager } from "./src/history"
import { SessionStore } from "./src/session-store"
import { RuntimeConfig } from "./src/runtime-config"
import { ChatQueue } from "./src/chat-queue"
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

/** Core handler for text prompts (used by message + edited_message) */
async function handleTextPrompt(ctx: Context, prompt: string): Promise<void> {
  const chatId = ctx.chat!.id

  logger.info("Text message", { chatId, length: prompt.length })

  await withTyping(ctx, async () => {
    try {
      const agent = getAgent(chatId)
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
      await persistSession(chatId, agent)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error("Text call failed", { chatId, error: msg })

      // If session expired, clear it and let user retry fresh
      if (msg.includes("session") || msg.includes("resume")) {
        agents.delete(chatId)
        histories.delete(chatId)
        await store.delete(chatId)
        await ctx.reply("⚠️ Sessione scaduta, resettata automaticamente. Riprova!")
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
      await persistSession(chatId, agent)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error("Photo call failed", { chatId, error: msg })

      if (msg.includes("session") || msg.includes("resume")) {
        agents.delete(chatId)
        histories.delete(chatId)
        await store.delete(chatId)
        await ctx.reply("⚠️ Sessione scaduta, resettata automaticamente. Riprova!")
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
  await bot.stop()
  db.close()
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

// Load persisted sessions before starting
await store.load()
logger.info("Sessions loaded", { count: store.size })

logger.info("Bot polling started")
bot.start({
  onStart: (info) => logger.info(`Bot online: @${info.username}`),
})
