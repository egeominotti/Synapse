/**
 * Telegram message handlers: text, photo, edited messages.
 * DRY executeWithRetry pattern handles sandbox snapshot, history, formatting,
 * file delivery, persistence, and session-error auto-retry in one place.
 */

import { readFileSync } from "fs"
import { join } from "path"
import { InputFile, type Bot, type Context } from "grammy"
import { Agent } from "../agent"
import type { HistoryManager } from "../history"
import type { AgentCallResult, AgentConfig } from "../types"
import type { Database } from "../db"
import type { SessionStore } from "../session-store"
import type { RuntimeConfig } from "../runtime-config"
import type { ChatQueue } from "../chat-queue"
import type { Scheduler } from "../scheduler"
import { formatForTelegram } from "../formatter"
import { logger } from "../logger"

// ---------------------------------------------------------------------------
// Shared deps type — passed from telegram.ts to both handlers and commands
// ---------------------------------------------------------------------------

export interface TelegramDeps {
  botToken: string
  agentConfig: AgentConfig
  db: Database
  store: SessionStore
  agents: Map<number, Agent>
  histories: Map<number, HistoryManager>
  runtimeConfig: RuntimeConfig
  chatQueue: ChatQueue
  scheduler: Scheduler
  botStartedAt: number
  isAdmin: (chatId: number) => boolean
  getAgent: (chatId: number) => Agent
  getHistory: (chatId: number, agent: Agent) => HistoryManager
  persistSession: (chatId: number, agent: Agent) => Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers (exported for scheduler use in telegram.ts)
// ---------------------------------------------------------------------------

export function buildMeta(result: AgentCallResult): string {
  const secs = (result.durationMs / 1000).toFixed(1)
  const parts: string[] = [`⏱ ${secs}s`]
  if (result.tokenUsage) {
    const { inputTokens: i, outputTokens: o } = result.tokenUsage
    parts.push(`🔤 ${i} → ${o} tok`)
  }
  return parts.join("  ·  ")
}

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

export const MAX_FILE_SIZE = 20 * 1024 * 1024
export type FileSnapshot = Map<string, number>

export function snapshotSandbox(agent: Agent): FileSnapshot {
  const files = agent.listSandboxFiles()
  return new Map(files.map((f) => [f.path, f.mtimeMs]))
}

export async function sendSandboxFiles(ctx: Context, agent: Agent, before: FileSnapshot): Promise<void> {
  const after = agent.listSandboxFiles()
  const newFiles = after.filter((f) => {
    const prevMtime = before.get(f.path)
    return prevMtime === undefined || f.mtimeMs > prevMtime
  })

  for (const file of newFiles) {
    try {
      const data = readFileSync(join(agent.sandboxDir, file.path))
      if (data.length === 0 || data.length > MAX_FILE_SIZE) {
        if (data.length > MAX_FILE_SIZE) {
          await ctx.reply(
            `⚠️ File troppo grande per Telegram: ${file.path} (${(data.length / 1024 / 1024).toFixed(1)} MB)`
          )
        }
        continue
      }
      await ctx.replyWithDocument(new InputFile(data, file.path), { caption: `📎 ${file.path}` })
      logger.debug("Sandbox file sent", { path: file.path, size: data.length })
    } catch (err) {
      logger.warn("Failed to send sandbox file", { path: file.path, error: String(err) })
    }
  }
}

async function sendFormatted(ctx: Context, markdown: string, result: AgentCallResult): Promise<void> {
  const meta = buildMeta(result)
  const { chunks, parseMode } = formatForTelegram(markdown, meta)
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, parseMode ? { parse_mode: parseMode } : {})
    } catch {
      await ctx.reply(chunk)
    }
  }
}

async function downloadFileAsBase64(
  botToken: string,
  ctx: Context,
  fileId: string
): Promise<{ base64: string; mediaType: string }> {
  const file = await ctx.api.getFile(fileId)
  const filePath = file.file_path!
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`)

  const contentLength = Number(res.headers.get("content-length") ?? 0)
  if (contentLength > MAX_FILE_SIZE) {
    throw new Error(
      `File troppo grande: ${(contentLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_SIZE / 1024 / 1024} MB)`
    )
  }

  const buffer = await res.arrayBuffer()
  if (buffer.byteLength > MAX_FILE_SIZE) {
    throw new Error(
      `File troppo grande: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_SIZE / 1024 / 1024} MB)`
    )
  }
  const base64 = Buffer.from(buffer).toString("base64")

  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  const mediaTypeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  }
  return { base64, mediaType: mediaTypeMap[ext] ?? "image/jpeg" }
}

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

function resetAgentSession(chatId: number, deps: TelegramDeps): Agent {
  const agent = new Agent(deps.agentConfig)
  deps.agents.set(chatId, agent)
  deps.histories.delete(chatId)
  logger.info("Agent session reset (fresh)", { chatId })
  return agent
}

// ---------------------------------------------------------------------------
// DRY core: execute agent call with retry on session errors
// ---------------------------------------------------------------------------

async function executeWithRetry(
  ctx: Context,
  chatId: number,
  callFn: (agent: Agent) => Promise<AgentCallResult>,
  historyPrompt: string,
  deps: TelegramDeps,
  afterHistory?: (history: HistoryManager, messageId: number | null, result: AgentCallResult) => Promise<void>
): Promise<void> {
  const execute = async (agent: Agent): Promise<void> => {
    const before = snapshotSandbox(agent)
    const result = await callFn(agent)

    const history = deps.getHistory(chatId, agent)
    const messageId = await history.addMessage({
      timestamp: new Date().toISOString(),
      prompt: historyPrompt,
      response: result.text,
      durationMs: result.durationMs,
      tokenUsage: result.tokenUsage,
    })
    if (afterHistory) await afterHistory(history, messageId, result)

    await sendFormatted(ctx, result.text, result)
    await sendSandboxFiles(ctx, agent, before)
    await deps.persistSession(chatId, agent)
  }

  try {
    await execute(deps.getAgent(chatId))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error("Agent call failed", { chatId, error: msg })

    if (isSessionError(msg)) {
      logger.warn("Session expired, retrying with fresh session", { chatId })
      try {
        await execute(resetAgentSession(chatId, deps))
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        logger.error("Retry with fresh session also failed", { chatId, error: retryMsg })
        await ctx.reply(`❌ Errore: ${retryMsg}`)
      }
    } else {
      await ctx.reply(`❌ Errore: ${msg}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Register message listeners
// ---------------------------------------------------------------------------

export function registerHandlers(bot: Bot, deps: TelegramDeps): void {
  bot.on("message:text", async (ctx) => {
    const prompt = ctx.message.text
    if (prompt.startsWith("/")) return

    await deps.chatQueue.enqueue(ctx.chat.id, async () => {
      logger.info("Text message", { chatId: ctx.chat.id, length: prompt.length })
      await withTyping(ctx, () => executeWithRetry(ctx, ctx.chat.id, (agent) => agent.call(prompt), prompt, deps))
    })
  })

  bot.on("message:photo", async (ctx) => {
    const caption = ctx.message.caption ?? "Cosa vedi in questa immagine?"
    const largest = ctx.message.photo[ctx.message.photo.length - 1]

    await deps.chatQueue.enqueue(ctx.chat.id, async () => {
      logger.info("Photo message", { chatId: ctx.chat.id, fileId: largest.file_id, caption })

      await withTyping(ctx, async () => {
        const { base64, mediaType } = await downloadFileAsBase64(deps.botToken, ctx, largest.file_id)

        await executeWithRetry(
          ctx,
          ctx.chat.id,
          (agent) => agent.callWithRawImage(mediaType, base64, caption),
          `[foto] ${caption}`,
          deps,
          async (history, messageId) => {
            if (messageId) {
              history.addAttachment(messageId, mediaType, Buffer.from(base64, "base64"), largest.file_id)
            }
          }
        )
      })
    })
  })

  bot.on("edited_message:text", async (ctx) => {
    const edited = ctx.editedMessage!
    const prompt = edited.text
    if (!prompt || prompt.startsWith("/")) return
    const corrected = `[Messaggio modificato] ${prompt}`

    await deps.chatQueue.enqueue(edited.chat.id, async () => {
      logger.info("Edited text", { chatId: edited.chat.id, length: prompt.length })
      await withTyping(ctx, () =>
        executeWithRetry(ctx, edited.chat.id, (agent) => agent.call(corrected), corrected, deps)
      )
    })
  })

  bot.on("edited_message:photo", async (ctx) => {
    const edited = ctx.editedMessage!
    const photos = edited.photo
    if (!photos || photos.length === 0) return
    const largest = photos[photos.length - 1]
    const caption = edited.caption ?? "Cosa vedi in questa immagine?"
    const corrected = `[Messaggio modificato] ${caption}`

    await deps.chatQueue.enqueue(edited.chat.id, async () => {
      logger.info("Edited photo", { chatId: edited.chat.id, fileId: largest.file_id })

      await withTyping(ctx, async () => {
        const { base64, mediaType } = await downloadFileAsBase64(deps.botToken, ctx, largest.file_id)

        await executeWithRetry(
          ctx,
          edited.chat.id,
          (agent) => agent.callWithRawImage(mediaType, base64, corrected),
          `[foto] ${corrected}`,
          deps,
          async (history, messageId) => {
            if (messageId) {
              history.addAttachment(messageId, mediaType, Buffer.from(base64, "base64"), largest.file_id)
            }
          }
        )
      })
    })
  })
}
