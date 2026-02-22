/**
 * Telegram message handlers: text, photo, edited messages.
 * DRY executeWithRetry pattern handles sandbox snapshot, history, formatting,
 * file delivery, persistence, and session-error auto-retry in one place.
 */

import { readFileSync, writeFileSync } from "fs"
import { join, basename } from "path"
import { InputFile, type Bot, type Context } from "grammy"
import { Agent } from "../agent"
import type { AgentPool } from "../agent-pool"
import type { HistoryManager } from "../history"
import type { AgentCallResult, AgentConfig } from "../types"
import type { Database } from "../db"
import type { SessionStore } from "../session-store"
import type { RuntimeConfig } from "../runtime-config"
import type { ChatQueue } from "../chat-queue"
import type { Scheduler } from "../scheduler"
import { parseSchedule } from "../scheduler"
import { formatForTelegram } from "../formatter"
import { formatIdentityHeader } from "../agent-identity"
import type { WhisperConfig } from "../whisper"
import { transcribe } from "../whisper"
import { logger } from "../logger"

// ---------------------------------------------------------------------------
// Shared deps type — passed from telegram.ts to both handlers and commands
// ---------------------------------------------------------------------------

export interface TelegramDeps {
  botToken: string
  agentConfig: AgentConfig
  db: Database
  store: SessionStore
  agentPools: Map<number, AgentPool>
  histories: Map<number, HistoryManager>
  runtimeConfig: RuntimeConfig
  chatQueue: ChatQueue
  scheduler: Scheduler
  whisperConfig: WhisperConfig | null
  botStartedAt: number
  isAdmin: (chatId: number) => boolean
  getAgent: (chatId: number) => Agent
  getAgentPool: (chatId: number) => AgentPool
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
  // Only send files from the output/ directory (Claude puts requested files there)
  const newFiles = after.filter((f) => {
    if (!f.path.startsWith("output/")) return false
    const prevMtime = before.get(f.path)
    return prevMtime === undefined || f.mtimeMs > prevMtime
  })

  for (const file of newFiles) {
    try {
      const data = readFileSync(join(agent.sandboxDir, file.path))
      if (data.length === 0 || data.length > MAX_FILE_SIZE) {
        if (data.length > MAX_FILE_SIZE) {
          await ctx.reply(`⚠️ File too large for Telegram: ${file.path} (${(data.length / 1024 / 1024).toFixed(1)} MB)`)
        }
        continue
      }
      // Strip "output/" prefix for cleaner filename
      const displayName = file.path.replace(/^output\//, "")
      await ctx.replyWithDocument(new InputFile(data, displayName), { caption: `📎 ${displayName}` })
      logger.debug("Sandbox file sent", { path: file.path, size: data.length })
    } catch (err) {
      logger.warn("Failed to send sandbox file", { path: file.path, error: String(err) })
    }
  }
}

async function sendFormatted(ctx: Context, markdown: string, result: AgentCallResult, header?: string): Promise<void> {
  const meta = buildMeta(result)
  const { chunks, parseMode } = formatForTelegram(markdown, meta, header)
  const replyToId = ctx.msg?.message_id
  for (let i = 0; i < chunks.length; i++) {
    const replyParams = i === 0 && replyToId ? { reply_parameters: { message_id: replyToId } } : {}
    try {
      await ctx.reply(chunks[i], { ...(parseMode ? { parse_mode: parseMode } : {}), ...replyParams })
    } catch {
      await ctx.reply(chunks[i], replyParams)
    }
  }
}

async function downloadFileAsBase64(
  botToken: string,
  ctx: Context,
  fileId: string
): Promise<{ base64: string; mediaType: string }> {
  const file = await ctx.api.getFile(fileId)
  if (!file.file_path) throw new Error("Telegram returned no file_path for this file")
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`)

  const contentLength = Number(res.headers.get("content-length") ?? 0)
  if (contentLength > MAX_FILE_SIZE) {
    throw new Error(
      `File too large: ${(contentLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_SIZE / 1024 / 1024} MB)`
    )
  }

  const buffer = await res.arrayBuffer()
  if (buffer.byteLength > MAX_FILE_SIZE) {
    throw new Error(
      `File too large: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_SIZE / 1024 / 1024} MB)`
    )
  }
  const base64 = Buffer.from(buffer).toString("base64")

  const ext = file.file_path.split(".").pop()?.toLowerCase() ?? ""
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
    lower.includes("no conversation found") ||
    lower.includes("session_id") ||
    lower.includes("could not resume") ||
    lower.includes("unable to resume") ||
    (lower.includes("resume") && lower.includes("error"))
  )
}

function resetAgentSession(chatId: number, deps: TelegramDeps): Agent {
  const agent = new Agent(deps.agentConfig)
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
  const pool = deps.getAgentPool(chatId)
  const { agent, isOverflow, identity } = pool.acquire()
  const identityHeader = formatIdentityHeader(identity)
  const role = isOverflow ? "worker" : "master"
  const promptPreview = historyPrompt.slice(0, 80) + (historyPrompt.length > 80 ? "..." : "")

  logger.info(`${identity.emoji} ${identity.name} acquired`, {
    chatId,
    role,
    agent: identity.name,
    prompt: promptPreview,
  })

  // Notify user which agent picked up the request
  const statusMsg = `${identity.emoji} <b>${identity.name}</b> is processing...`
  ctx.reply(statusMsg, { parse_mode: "HTML" }).catch(() => {})

  const execute = async (execAgent: Agent): Promise<void> => {
    const before = snapshotSandbox(execAgent)
    const result = await callFn(execAgent)

    logger.info(`${identity.emoji} ${identity.name} responded`, {
      chatId,
      agent: identity.name,
      durationMs: result.durationMs,
      tokens: result.tokenUsage ? `${result.tokenUsage.inputTokens}→${result.tokenUsage.outputTokens}` : "n/a",
    })

    // Always record history under the primary agent's session
    const primaryAgent = pool.getPrimary()
    const history = deps.getHistory(chatId, primaryAgent)
    const messageId = await history.addMessage({
      timestamp: new Date().toISOString(),
      prompt: historyPrompt,
      response: result.text,
      durationMs: result.durationMs,
      tokenUsage: result.tokenUsage,
    })
    if (afterHistory) await afterHistory(history, messageId, result)

    await sendFormatted(ctx, result.text, result, identityHeader)
    await sendSandboxFiles(ctx, execAgent, before)

    // Only persist session for primary agent
    if (!isOverflow) {
      await deps.persistSession(chatId, execAgent)
    }
  }

  try {
    await execute(agent)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`${identity.emoji} ${identity.name} failed`, { chatId, agent: identity.name, error: msg })

    if (!isOverflow && isSessionError(msg)) {
      logger.info("Stale session, resetting with fresh agent", { chatId })
      try {
        const freshAgent = resetAgentSession(chatId, deps)
        pool.setPrimary(freshAgent)
        await execute(freshAgent)
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        logger.error("Retry with fresh session also failed", { chatId, error: retryMsg })
        const rp = ctx.msg ? { reply_parameters: { message_id: ctx.msg.message_id } } : {}
        await ctx.reply(`❌ Error: ${retryMsg}`, rp)
      }
    } else {
      const rp = ctx.msg ? { reply_parameters: { message_id: ctx.msg.message_id } } : {}
      await ctx.reply(`❌ Error: ${msg}`, rp)
    }
  } finally {
    pool.release(agent, isOverflow)
    logger.info(`${identity.emoji} ${identity.name} released`, { chatId, agent: identity.name, role })
  }
}

// ---------------------------------------------------------------------------
// File download: save Telegram document into agent sandbox
// ---------------------------------------------------------------------------

async function downloadFileToSandbox(
  botToken: string,
  ctx: Context,
  fileId: string,
  fileName: string,
  agent: Agent
): Promise<string> {
  const file = await ctx.api.getFile(fileId)
  if (!file.file_path) throw new Error("Telegram returned no file_path for this file")
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(
      `File too large: ${(buffer.length / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_SIZE / 1024 / 1024} MB)`
    )
  }

  // Sanitize filename to prevent path traversal
  const safeName = basename(fileName)
  const dest = join(agent.sandboxDir, safeName)
  writeFileSync(dest, buffer)
  logger.debug("File saved to sandbox", { fileName: safeName, size: buffer.length })
  return dest
}

// ---------------------------------------------------------------------------
// Free-text schedule detection
// ---------------------------------------------------------------------------

/**
 * Try to detect a scheduling intent from free text.
 * Returns { scheduleExpr, prompt } if detected, null otherwise.
 *
 * Patterns:
 *   "every 30s say hello"         → every 30s, "say hello"
 *   "every 5m check status"       → every 5m, "check status"
 *   "in 10m remind me..."         → in 10m, "remind me..."
 *   "at 18:00 remind me..."       → at 18:00, "remind me..."
 */
const RE_FREETEXT_SCHEDULE =
  /^(?:every\s+\d+\s*(?:s|m|h|sec|min)|in\s+\d+\s*(?:s|m|h|sec|min)|(?:every|at)\s+\d{1,2}:\d{2})\b/i

export function parseFreetextSchedule(text: string): { scheduleExpr: string; prompt: string } | null {
  const match = text.match(RE_FREETEXT_SCHEDULE)
  if (!match) return null

  const scheduleExpr = match[0].trim()
  const prompt = text.slice(match[0].length).trim()
  if (!prompt) return null

  const normalized = scheduleExpr

  // Validate it actually parses
  try {
    parseSchedule(normalized)
  } catch {
    return null
  }

  return { scheduleExpr: normalized, prompt }
}

// ---------------------------------------------------------------------------
// Register message listeners
// ---------------------------------------------------------------------------

export function registerHandlers(bot: Bot, deps: TelegramDeps): void {
  bot.on("message:text", async (ctx) => {
    const prompt = ctx.message.text
    if (prompt.startsWith("/")) return

    // Immediate typing feedback — before queue, before anything
    ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {})

    // Free-text schedule detection (DISABLED)
    // const schedule = parseFreetextSchedule(prompt)
    // if (schedule) {
    //   try {
    //     const spec = parseSchedule(schedule.scheduleExpr)
    //     const jobId = deps.scheduler.createJob(ctx.chat.id, schedule.prompt, spec)
    //     const runAtStr = spec.runAt.toLocaleString("en-US", { timeZone: "Europe/Rome" })
    //     const typeLabel =
    //       spec.type === "recurring" ? "🔄 Recurring" : spec.type === "delay" ? "⏳ Delay" : "📌 Once"
    //     const intervalInfo =
    //       spec.intervalMs && spec.intervalMs < 86_400_000
    //         ? ` (every ${spec.intervalMs >= 3_600_000 ? `${spec.intervalMs / 3_600_000}h` : spec.intervalMs >= 60_000 ? `${spec.intervalMs / 60_000}m` : `${spec.intervalMs / 1_000}s`})`
    //         : ""
    //     await ctx.reply(
    //       `✅ Job #${jobId} created\n\n` +
    //         `${typeLabel}${intervalInfo}\n` +
    //         `Next execution: *${runAtStr}*\n` +
    //         `Prompt: _${schedule.prompt.slice(0, 100)}${schedule.prompt.length > 100 ? "..." : ""}_`,
    //       { parse_mode: "Markdown" }
    //     )
    //     return
    //   } catch (err) {
    //     const msg = err instanceof Error ? err.message : String(err)
    //     await ctx.reply(`❌ ${msg}`)
    //     return
    //   }
    // }

    deps.chatQueue.enqueue(ctx.chat.id, async () => {
      logger.info("Text message", { chatId: ctx.chat.id, length: prompt.length })
      await withTyping(ctx, () => executeWithRetry(ctx, ctx.chat.id, (agent) => agent.call(prompt), prompt, deps))
    })
  })

  bot.on("message:photo", async (ctx) => {
    const caption = ctx.message.caption ?? "What do you see in this image?"
    const largest = ctx.message.photo[ctx.message.photo.length - 1]

    ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {})

    deps.chatQueue.enqueue(ctx.chat.id, async () => {
      logger.info("Photo message", { chatId: ctx.chat.id, fileId: largest.file_id, caption })

      await withTyping(ctx, async () => {
        const { base64, mediaType } = await downloadFileAsBase64(deps.botToken, ctx, largest.file_id)

        await executeWithRetry(
          ctx,
          ctx.chat.id,
          (agent) => agent.callWithRawImage(mediaType, base64, caption),
          `[photo] ${caption}`,
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

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document
    const fileName = doc.file_name ?? "file"
    const caption = ctx.message.caption ?? `Analyze the file ${fileName}`

    ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {})

    deps.chatQueue.enqueue(ctx.chat.id, async () => {
      logger.info("Document message", { chatId: ctx.chat.id, fileId: doc.file_id, fileName, size: doc.file_size })

      const prompt = `I uploaded the file "${fileName}" in the current directory. ${caption}`
      await withTyping(ctx, () =>
        executeWithRetry(
          ctx,
          ctx.chat.id,
          async (agent) => {
            await downloadFileToSandbox(deps.botToken, ctx, doc.file_id, fileName, agent)
            return agent.call(prompt)
          },
          prompt,
          deps
        )
      )
    })
  })

  bot.on("edited_message:text", async (ctx) => {
    const edited = ctx.editedMessage!
    const prompt = edited.text
    if (!prompt || prompt.startsWith("/")) return
    const corrected = `[Edited message] ${prompt}`

    deps.chatQueue.enqueue(edited.chat.id, async () => {
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
    const caption = edited.caption ?? "What do you see in this image?"
    const corrected = `[Edited message] ${caption}`

    deps.chatQueue.enqueue(edited.chat.id, async () => {
      logger.info("Edited photo", { chatId: edited.chat.id, fileId: largest.file_id })

      await withTyping(ctx, async () => {
        const { base64, mediaType } = await downloadFileAsBase64(deps.botToken, ctx, largest.file_id)

        await executeWithRetry(
          ctx,
          edited.chat.id,
          (agent) => agent.callWithRawImage(mediaType, base64, corrected),
          `[photo] ${corrected}`,
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

  // ---------------------------------------------------------------------------
  // Voice messages (whisper.cpp transcription)
  // ---------------------------------------------------------------------------

  bot.on("message:voice", async (ctx) => {
    const voice = ctx.message.voice

    if (!deps.whisperConfig) {
      await ctx.reply(
        "🎙 Voice transcription not available.\n\n" +
          "To enable it:\n" +
          "1. `brew install whisper-cpp ffmpeg`\n" +
          "2. Download a model: `curl -L -o model.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`\n" +
          "3. Set `WHISPER_MODEL_PATH=/path/to/model.bin`",
        { parse_mode: "Markdown" }
      )
      return
    }

    ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {})

    deps.chatQueue.enqueue(ctx.chat.id, async () => {
      logger.info("Voice message", { chatId: ctx.chat.id, fileId: voice.file_id, duration: voice.duration })

      await withTyping(ctx, async () => {
        const agent = deps.getAgent(ctx.chat.id)
        const voiceFile = `voice_${Date.now()}.ogg`
        await downloadFileToSandbox(deps.botToken, ctx, voice.file_id, voiceFile, agent)

        const text = await transcribe(join(agent.sandboxDir, voiceFile), deps.whisperConfig!)
        const voiceRp = ctx.msg ? { reply_parameters: { message_id: ctx.msg.message_id } } : {}
        await ctx.reply(`🎙 _"${text}"_`, { parse_mode: "Markdown", ...voiceRp })

        const prompt = `[voice] ${text}`
        await executeWithRetry(ctx, ctx.chat.id, (a) => a.call(prompt), prompt, deps)
      })
    })
  })

  bot.on("message:audio", async (ctx) => {
    const audio = ctx.message.audio
    const caption = ctx.message.caption

    if (!deps.whisperConfig) {
      await ctx.reply("🎙 Audio transcription not available.\n\nSet `WHISPER_MODEL_PATH` to enable whisper-cpp.", {
        parse_mode: "Markdown",
      })
      return
    }

    ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {})

    deps.chatQueue.enqueue(ctx.chat.id, async () => {
      const fileName = audio.file_name ?? `audio_${Date.now()}.mp3`
      logger.info("Audio message", { chatId: ctx.chat.id, fileId: audio.file_id, fileName })

      await withTyping(ctx, async () => {
        const agent = deps.getAgent(ctx.chat.id)
        await downloadFileToSandbox(deps.botToken, ctx, audio.file_id, fileName, agent)

        const text = await transcribe(join(agent.sandboxDir, fileName), deps.whisperConfig!)
        const audioRp = ctx.msg ? { reply_parameters: { message_id: ctx.msg.message_id } } : {}
        await ctx.reply(`🎙 _"${text}"_`, { parse_mode: "Markdown", ...audioRp })

        const prompt = caption ? `[audio] ${text}\n\n${caption}` : `[audio] ${text}`
        await executeWithRetry(ctx, ctx.chat.id, (a) => a.call(prompt), prompt, deps)
      })
    })
  })
}
