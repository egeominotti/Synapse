/**
 * Claude Agent — Telegram Bot
 *
 * Every Telegram chat gets its own Claude session with infinite memory.
 * Sessions are persisted to disk and survive process restarts.
 * Supports text messages and photos (jpg/png/webp/gif).
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=<token> CLAUDE_CODE_OAUTH_TOKEN=<token> bun run telegram.ts
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN          (required) Telegram bot token from @BotFather
 *   CLAUDE_CODE_OAUTH_TOKEN     (required) OAuth token for Claude CLI
 *   CLAUDE_AGENT_SYSTEM_PROMPT  (optional) System prompt defining the agent's persona
 *   CLAUDE_TELEGRAM_SESSION_FILE (optional) Path to session persistence file
 *   CLAUDE_AGENT_LOG_LEVEL      (optional) DEBUG|INFO|WARN|ERROR (default: INFO)
 *   CLAUDE_AGENT_SKIP_PERMISSIONS (optional) Set "0" to disable skip-permissions
 */

import { Bot, type Context } from "grammy"
import { loadConfig } from "./src/config"
import { Agent } from "./src/agent"
import { logger } from "./src/logger"
import { SessionStore, DEFAULT_SESSION_FILE } from "./src/session-store"
import type { AgentCallResult, LogLevel } from "./src/types"

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

const sessionFile = Bun.env.CLAUDE_TELEGRAM_SESSION_FILE ?? DEFAULT_SESSION_FILE
const store = new SessionStore(sessionFile)

logger.info("Starting Telegram bot", {
  sessionFile,
  hasSystemPrompt: !!agentConfig.systemPrompt,
})

const bot = new Bot(botToken)

// One Agent per chat — each has its own sessionId and conversation memory
const agents = new Map<number, Agent>()

/** Get or create an agent for this chat, restoring saved session if available */
function getAgent(chatId: number): Agent {
  if (!agents.has(chatId)) {
    const agent = new Agent(agentConfig)
    const savedSessionId = store.get(chatId)
    if (savedSessionId) {
      agent.setSessionId(savedSessionId)
      logger.info("Session restored from disk", { chatId, sessionId: savedSessionId.slice(0, 16) + "..." })
    } else {
      logger.info("New agent created", { chatId })
    }
    agents.set(chatId, agent)
  }
  return agents.get(chatId)!
}

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

/** Format the footer metadata line shown after each Claude response */
function formatMeta(result: AgentCallResult): string {
  const secs = (result.durationMs / 1000).toFixed(1)
  const parts: string[] = [`⏱ ${secs}s`]
  if (result.tokenUsage) {
    const { inputTokens: i, outputTokens: o } = result.tokenUsage
    parts.push(`🔤 ${i} → ${o} tok`)
  }
  return `_${parts.join("  ·  ")}_`
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

/** Send a long text split into Telegram-safe chunks (max 4096 chars) */
async function sendLong(ctx: Context, text: string): Promise<void> {
  const MAX = 4096
  if (text.length <= MAX) {
    await ctx.reply(text)
    return
  }
  for (let i = 0; i < text.length; i += MAX) {
    await ctx.reply(text.slice(i, i + MAX))
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
    jpg: "image/jpeg", jpeg: "image/jpeg",
    png: "image/png", gif: "image/gif", webp: "image/webp",
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
  await ctx.reply(
    "📋 *Comandi disponibili:*\n\n" +
    "/start — messaggio di benvenuto\n" +
    "/reset — resetta la conversazione\n" +
    "/stats — statistiche sessione corrente\n\n" +
    "💬 Scrivi qualsiasi messaggio per parlare con Claude.\n" +
    "📷 Manda una foto (con o senza didascalia) per analisi visiva.",
    { parse_mode: "Markdown" }
  )
})

bot.command("reset", async (ctx) => {
  const chatId = ctx.chat.id
  agents.delete(chatId)
  await store.delete(chatId)
  logger.info("Session reset", { chatId })
  await ctx.reply("🔄 Sessione resettata. Puoi iniziare una nuova conversazione.")
})

bot.command("stats", async (ctx) => {
  const chatId = ctx.chat.id
  const agent = agents.get(chatId)
  const savedSid = store.get(chatId)
  const sid = agent?.getSessionId() ?? savedSid

  await ctx.reply(
    `📊 *Sessione corrente:*\n\n` +
    `Session ID: \`${sid ? sid.slice(0, 16) + "..." : "nessuna"}\`\n` +
    `Persistenza: ${savedSid ? "✅ salvata su disco" : "⏳ non ancora salvata"}`,
    { parse_mode: "Markdown" }
  )
})

// ---------------------------------------------------------------------------
// Text messages
// ---------------------------------------------------------------------------

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id
  const prompt = ctx.message.text

  if (prompt.startsWith("/")) return // ignore unknown commands

  logger.info("Text message", { chatId, length: prompt.length })

  await withTyping(ctx, async () => {
    try {
      const agent = getAgent(chatId)
      const result = await agent.call(prompt)

      await sendLong(ctx, result.text)
      await ctx.reply(formatMeta(result), { parse_mode: "Markdown" })
      await persistSession(chatId, agent)

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error("Text call failed", { chatId, error: msg })

      // If session expired, clear it and let user retry fresh
      if (msg.includes("session") || msg.includes("resume")) {
        agents.delete(chatId)
        await store.delete(chatId)
        await ctx.reply("⚠️ Sessione scaduta, resettata automaticamente. Riprova!")
      } else {
        await ctx.reply(`❌ Errore: ${msg}`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Photo messages
// ---------------------------------------------------------------------------

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id
  const caption = ctx.message.caption ?? "Cosa vedi in questa immagine?"

  const photos = ctx.message.photo
  const largest = photos[photos.length - 1]

  logger.info("Photo message", { chatId, fileId: largest.file_id, caption })

  await withTyping(ctx, async () => {
    try {
      const { base64, mediaType } = await downloadFileAsBase64(ctx, largest.file_id)

      const agent = getAgent(chatId)
      const result = await agent.callWithRawImage(mediaType, base64, caption)

      await sendLong(ctx, result.text)
      await ctx.reply(formatMeta(result), { parse_mode: "Markdown" })
      await persistSession(chatId, agent)

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error("Photo call failed", { chatId, error: msg })

      if (msg.includes("session") || msg.includes("resume")) {
        agents.delete(chatId)
        await store.delete(chatId)
        await ctx.reply("⚠️ Sessione scaduta, resettata automaticamente. Riprova!")
      } else {
        await ctx.reply(`❌ Errore analisi immagine: ${msg}`)
      }
    }
  })
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
