/**
 * Telegram message handlers and processing pipeline.
 *
 * Single agent per chat with inline per-chat serialization.
 * All internal helpers use grammy Api directly (no Context dependency).
 */

import { readFileSync, writeFileSync } from "fs"
import { join, basename } from "path"
import { InputFile, type Api, type Bot } from "grammy"
import { Agent } from "../agent"
import type { HistoryManager } from "../history"
import type { AgentCallResult, AgentConfig } from "../types"
import type { Database } from "../db"
import type { SessionStore } from "../session-store"
import type { RuntimeConfig } from "../runtime-config"
import { formatForTelegram } from "../formatter"
import { writeMemoryFile, readMemoryFile, MAX_MEMORY_FILE_CHARS } from "../sandbox"
import type { WhisperConfig } from "../whisper"
import { transcribe } from "../whisper"
import { logger } from "../logger"

// ---------------------------------------------------------------------------
// Shared deps type — passed from run.ts to both handlers and commands
// ---------------------------------------------------------------------------

export interface TelegramDeps {
  botToken: string
  agentConfig: AgentConfig
  db: Database
  store: SessionStore
  agents: Map<number, Agent>
  histories: Map<number, HistoryManager>
  runtimeConfig: RuntimeConfig
  whisperConfig: WhisperConfig | null
  botStartedAt: number
  isAdmin: (chatId: number) => boolean
  getAgent: (chatId: number) => Agent
  getHistory: (chatId: number, agent: Agent) => HistoryManager
  persistSession: (chatId: number, agent: Agent) => Promise<void>
}

// ---------------------------------------------------------------------------
// Per-chat serialization (inline promise chain)
// ---------------------------------------------------------------------------

const chatLocks = new Map<number, Promise<void>>()

function enqueue(chatId: number, fn: () => Promise<void>): void {
  const prev = chatLocks.get(chatId) ?? Promise.resolve()
  const next = prev
    .then(fn)
    .catch(() => {})
    .finally(() => {
      if (chatLocks.get(chatId) === next) chatLocks.delete(chatId)
    })
  chatLocks.set(chatId, next)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format token count for human readability: 850 → "850", 1234 → "1.2k", 1200000 → "1.2M" */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

export function buildMeta(result: AgentCallResult): string {
  const secs = (result.durationMs / 1000).toFixed(1)
  const parts: string[] = [`⏱ ${secs}s`]
  if (result.tokenUsage) {
    const total = result.tokenUsage.inputTokens + result.tokenUsage.outputTokens
    if (total > 0) {
      parts.push(`~${formatTokenCount(total)} tokens`)
    }
  }
  return parts.join("  ·  ")
}

async function withTyping(api: Api, chatId: number, fn: () => Promise<void>): Promise<void> {
  const typingInterval = setInterval(() => {
    api.sendChatAction(chatId, "typing").catch(() => {})
  }, 5_000)
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

export async function sendSandboxFiles(api: Api, chatId: number, agent: Agent, before: FileSnapshot): Promise<void> {
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
          await api.sendMessage(
            chatId,
            `⚠️ File too large for Telegram: ${file.path} (${(data.length / 1024 / 1024).toFixed(1)} MB)`
          )
        }
        continue
      }
      // Strip "output/" prefix for cleaner filename
      const displayName = file.path.replace(/^output\//, "")
      await api.sendDocument(chatId, new InputFile(data, displayName), { caption: `📎 ${displayName}` })
      logger.debug("Sandbox file sent", { path: file.path, size: data.length })
    } catch (err) {
      logger.warn("Failed to send sandbox file", { path: file.path, error: String(err) })
    }
  }
}

async function sendFormatted(
  api: Api,
  chatId: number,
  replyToId: number | undefined,
  markdown: string,
  result: AgentCallResult
): Promise<void> {
  const meta = buildMeta(result)
  const { chunks, parseMode } = formatForTelegram(markdown, meta)
  for (let i = 0; i < chunks.length; i++) {
    const replyParams = i === 0 && replyToId ? { reply_parameters: { message_id: replyToId } } : {}
    try {
      await api.sendMessage(chatId, chunks[i], { ...(parseMode ? { parse_mode: parseMode } : {}), ...replyParams })
    } catch {
      await api.sendMessage(chatId, chunks[i], replyParams)
    }
  }
}

async function downloadFileAsBase64(
  botToken: string,
  api: Api,
  fileId: string
): Promise<{ base64: string; mediaType: string }> {
  const file = await api.getFile(fileId)
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
// User-friendly error mapping
// ---------------------------------------------------------------------------

/** Map raw technical error messages to user-friendly descriptions. */
export function friendlyError(rawMsg: string): string {
  const lower = rawMsg.toLowerCase()

  if (lower.includes("429") || lower.includes("rate limit"))
    return "Too many requests. Please wait a moment and try again."

  if (lower.includes("econnreset") || lower.includes("econnrefused") || lower.includes("socket hang up"))
    return "Connection interrupted. Please try again."

  if (lower.includes("etimedout") || lower.includes("network")) return "Network issue. Please try again shortly."

  if (lower.includes("timeout") || lower.includes("did not respond within"))
    return "Response took too long. Try a shorter request."

  if (
    lower.includes("invalid session") ||
    lower.includes("session not found") ||
    lower.includes("could not resume") ||
    lower.includes("unable to resume")
  )
    return "Session expired. Starting a fresh conversation..."

  if (lower.includes("502") || lower.includes("503")) return "Claude is temporarily unavailable. Retrying..."

  // Fallback: show the raw error but capped in length
  return rawMsg.length > 120 ? rawMsg.slice(0, 117) + "..." : rawMsg
}

// ---------------------------------------------------------------------------
// DRY core: execute agent call with retry on session errors
// ---------------------------------------------------------------------------

/** Helper: safely edit a status message, swallowing errors */
async function editStatus(api: Api, chatId: number, msgId: number, text: string): Promise<void> {
  try {
    await api.editMessageText(chatId, msgId, text, { parse_mode: "HTML" })
  } catch {
    /* message may have been deleted or text unchanged */
  }
}

async function executeWithRetry(
  api: Api,
  chatId: number,
  replyToId: number | undefined,
  callFn: (agent: Agent) => Promise<AgentCallResult>,
  historyPrompt: string,
  deps: TelegramDeps,
  afterHistory?: (history: HistoryManager, messageId: number | null, result: AgentCallResult) => Promise<void>
): Promise<void> {
  const agent = deps.getAgent(chatId)
  const promptPreview = historyPrompt.slice(0, 80) + (historyPrompt.length > 80 ? "..." : "")

  logger.info("Agent acquired", { chatId, prompt: promptPreview })

  // Single status message
  const replyParams = replyToId ? { reply_parameters: { message_id: replyToId } } : {}
  let statusMsgId: number | null = null
  try {
    const sent = await api.sendMessage(chatId, "◉ <b>Synapse</b> ...", {
      parse_mode: "HTML",
      ...replyParams,
    })
    statusMsgId = sent.message_id
  } catch {
    /* non-critical */
  }

  // Live timer — updates status message every 5s with elapsed time
  const startTime = Date.now()
  const timer = statusMsgId
    ? setInterval(() => {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000)
        editStatus(api, chatId, statusMsgId!, `◉ <b>Synapse</b> thinking... ${elapsedSec}s`)
      }, 5_000)
    : null
  const stopTimer = () => {
    if (timer) clearInterval(timer)
  }

  // Inject persistent memory into sandbox before call
  const memoryBefore = deps.db.getChatMemory(chatId)
  if (memoryBefore) {
    writeMemoryFile(agent.sandboxDir, memoryBefore)
  }

  const execute = async (execAgent: Agent): Promise<void> => {
    // Ensure memory is in this agent's sandbox (may differ from initial agent on retry)
    if (memoryBefore && execAgent !== agent) {
      writeMemoryFile(execAgent.sandboxDir, memoryBefore)
    }
    const before = snapshotSandbox(execAgent)
    const result = await callFn(execAgent)

    const responsePreview = result.text.slice(0, 200) + (result.text.length > 200 ? "..." : "")
    logger.info("Agent responded", {
      chatId,
      durationMs: result.durationMs,
      tokens: result.tokenUsage ? `${result.tokenUsage.inputTokens}→${result.tokenUsage.outputTokens}` : "n/a",
      responseLength: result.text.length,
      response: responsePreview,
    })

    // Delete status message — the real response replaces it
    stopTimer()
    if (statusMsgId) {
      api.deleteMessage(chatId, statusMsgId).catch(() => {})
    }

    // Record history, send formatted, deliver files
    const history = deps.getHistory(chatId, execAgent)
    const messageId = await history.addMessage({
      timestamp: new Date().toISOString(),
      prompt: historyPrompt,
      response: result.text,
      durationMs: result.durationMs,
      tokenUsage: result.tokenUsage,
    })
    if (afterHistory) await afterHistory(history, messageId, result)

    await sendFormatted(api, chatId, replyToId, result.text, result)
    await sendSandboxFiles(api, chatId, execAgent, before)

    // Save persistent memory if agent updated it
    const memoryAfter = readMemoryFile(execAgent.sandboxDir)
    if (memoryAfter !== null && memoryAfter !== memoryBefore) {
      const truncated =
        memoryAfter.length > MAX_MEMORY_FILE_CHARS ? memoryAfter.slice(0, MAX_MEMORY_FILE_CHARS) : memoryAfter
      deps.db.setChatMemory(chatId, truncated)
      logger.debug("Chat memory updated", { chatId, chars: truncated.length })
    }

    await deps.persistSession(chatId, execAgent)
  }

  try {
    await execute(agent)
  } catch (err) {
    stopTimer()
    const msg = err instanceof Error ? err.message : String(err)
    logger.error("Agent failed", { chatId, error: msg })

    // Update status message with error
    const userMsg = friendlyError(msg)
    if (statusMsgId) {
      await editStatus(api, chatId, statusMsgId, `✗ ${userMsg}`)
    }

    if (isSessionError(msg)) {
      logger.info("Stale session, resetting with fresh agent", { chatId })
      let freshAgent: Agent | null = null
      try {
        freshAgent = resetAgentSession(chatId, deps)
        deps.agents.set(chatId, freshAgent)
        freshAgent = null // now owned by the map
        await execute(deps.agents.get(chatId)!)
      } catch (retryErr) {
        freshAgent?.cleanup()
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        logger.error("Retry with fresh session also failed", { chatId, error: retryMsg })
        const userRetryMsg = friendlyError(retryMsg)
        if (statusMsgId) {
          await editStatus(api, chatId, statusMsgId, `✗ ${userRetryMsg}`)
        } else {
          await api.sendMessage(chatId, `✗ ${userRetryMsg}`, replyParams)
        }
      }
    } else if (!statusMsgId) {
      await api.sendMessage(chatId, `✗ ${userMsg}`, replyParams)
    }
  } finally {
    stopTimer()
  }
}

// ---------------------------------------------------------------------------
// File download: save Telegram document into agent sandbox
// ---------------------------------------------------------------------------

async function downloadFileToSandbox(
  botToken: string,
  api: Api,
  fileId: string,
  fileName: string,
  agent: Agent
): Promise<string> {
  const file = await api.getFile(fileId)
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
// Register message listeners
// ---------------------------------------------------------------------------

export function registerHandlers(bot: Bot, deps: TelegramDeps): void {
  bot.on("message:text", (ctx) => {
    const chatId = ctx.chat.id
    const messageId = ctx.message.message_id
    const prompt = ctx.message.text
    if (prompt.startsWith("/")) return

    ctx.api.sendChatAction(chatId, "typing").catch(() => {})

    logger.info("Text message", { chatId, length: prompt.length })
    enqueue(chatId, () =>
      withTyping(ctx.api, chatId, () =>
        executeWithRetry(ctx.api, chatId, messageId, (agent) => agent.call(prompt), prompt, deps)
      )
    )
  })

  bot.on("message:photo", (ctx) => {
    const chatId = ctx.chat.id
    const messageId = ctx.message.message_id
    const caption = ctx.message.caption ?? "What do you see in this image?"
    const largest = ctx.message.photo[ctx.message.photo.length - 1]
    const fileId = largest.file_id

    ctx.api.sendChatAction(chatId, "typing").catch(() => {})

    logger.info("Photo message", { chatId, fileId, caption })
    enqueue(chatId, async () => {
      await withTyping(ctx.api, chatId, async () => {
        const { base64, mediaType } = await downloadFileAsBase64(deps.botToken, ctx.api, fileId)
        await executeWithRetry(
          ctx.api,
          chatId,
          messageId,
          (agent) => agent.callWithRawImage(mediaType, base64, caption),
          `[photo] ${caption}`,
          deps,
          async (history, msgId) => {
            if (msgId) history.addAttachment(msgId, mediaType, Buffer.from(base64, "base64"), fileId)
          }
        )
      })
    })
  })

  bot.on("message:document", (ctx) => {
    const chatId = ctx.chat.id
    const messageId = ctx.message.message_id
    const doc = ctx.message.document
    const fileName = doc.file_name ?? "file"
    const caption = ctx.message.caption ?? `Analyze the file ${fileName}`
    const fileId = doc.file_id
    const docPrompt = `I uploaded the file "${fileName}" in the current directory. ${caption}`

    ctx.api.sendChatAction(chatId, "typing").catch(() => {})

    logger.info("Document message", { chatId, fileId, fileName })
    enqueue(chatId, () =>
      withTyping(ctx.api, chatId, () =>
        executeWithRetry(
          ctx.api,
          chatId,
          messageId,
          async (agent) => {
            await downloadFileToSandbox(deps.botToken, ctx.api, fileId, fileName, agent)
            return agent.call(docPrompt)
          },
          docPrompt,
          deps
        )
      )
    )
  })

  bot.on("edited_message:text", (ctx) => {
    const edited = ctx.editedMessage!
    const chatId = edited.chat.id
    const messageId = edited.message_id
    const prompt = edited.text
    if (!prompt || prompt.startsWith("/")) return

    const corrected = `[Edited message] ${prompt}`
    logger.info("Edited text", { chatId, length: prompt.length })
    enqueue(chatId, () =>
      withTyping(ctx.api, chatId, () =>
        executeWithRetry(ctx.api, chatId, messageId, (agent) => agent.call(corrected), corrected, deps)
      )
    )
  })

  bot.on("edited_message:photo", (ctx) => {
    const edited = ctx.editedMessage!
    const chatId = edited.chat.id
    const messageId = edited.message_id
    const photos = edited.photo
    if (!photos || photos.length === 0) return
    const largest = photos[photos.length - 1]
    const fileId = largest.file_id
    const caption = edited.caption ?? "What do you see in this image?"
    const corrected = `[Edited message] ${caption}`

    logger.info("Edited photo", { chatId, fileId })
    enqueue(chatId, async () => {
      await withTyping(ctx.api, chatId, async () => {
        const { base64, mediaType } = await downloadFileAsBase64(deps.botToken, ctx.api, fileId)
        await executeWithRetry(
          ctx.api,
          chatId,
          messageId,
          (agent) => agent.callWithRawImage(mediaType, base64, corrected),
          `[photo] ${corrected}`,
          deps,
          async (history, msgId) => {
            if (msgId) history.addAttachment(msgId, mediaType, Buffer.from(base64, "base64"), fileId)
          }
        )
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Voice messages (whisper transcription)
  // ---------------------------------------------------------------------------

  bot.on("message:voice", (ctx) => {
    const chatId = ctx.chat.id
    const messageId = ctx.message.message_id
    const voice = ctx.message.voice
    const fileName = `voice_${Date.now()}.ogg`

    if (!deps.whisperConfig) {
      ctx.reply(
        "🎙 Voice transcription not available.\n\n" +
          "To enable it:\n" +
          "1. `brew install whisper-cpp ffmpeg`\n" +
          "2. Download a model: `curl -L -o model.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`\n" +
          "3. Set `WHISPER_MODEL_PATH=/path/to/model.bin`",
        { parse_mode: "Markdown" }
      )
      return
    }

    ctx.api.sendChatAction(chatId, "typing").catch(() => {})

    logger.info("Voice message", { chatId, fileId: voice.file_id, fileName })
    enqueue(chatId, () =>
      withTyping(ctx.api, chatId, async () => {
        const agent = deps.getAgent(chatId)
        await downloadFileToSandbox(deps.botToken, ctx.api, voice.file_id, fileName, agent)
        const text = await transcribe(join(agent.sandboxDir, fileName), deps.whisperConfig!)
        const rp = { reply_parameters: { message_id: messageId } }
        await ctx.api.sendMessage(chatId, `🎙 _"${text}"_`, { parse_mode: "Markdown", ...rp })
        const voicePrompt = `[voice] ${text}`
        await executeWithRetry(ctx.api, chatId, messageId, (a) => a.call(voicePrompt), voicePrompt, deps)
      })
    )
  })

  bot.on("message:audio", (ctx) => {
    const chatId = ctx.chat.id
    const messageId = ctx.message.message_id
    const audio = ctx.message.audio
    const caption = ctx.message.caption
    const fileName = audio.file_name ?? `audio_${Date.now()}.mp3`

    if (!deps.whisperConfig) {
      ctx.reply("🎙 Audio transcription not available.\n\nSet `WHISPER_MODEL_PATH` to enable whisper-cpp.", {
        parse_mode: "Markdown",
      })
      return
    }

    ctx.api.sendChatAction(chatId, "typing").catch(() => {})

    logger.info("Audio message", { chatId, fileId: audio.file_id, fileName })
    enqueue(chatId, () =>
      withTyping(ctx.api, chatId, async () => {
        const agent = deps.getAgent(chatId)
        await downloadFileToSandbox(deps.botToken, ctx.api, audio.file_id, fileName, agent)
        const text = await transcribe(join(agent.sandboxDir, fileName), deps.whisperConfig!)
        const rp = { reply_parameters: { message_id: messageId } }
        await ctx.api.sendMessage(chatId, `🎙 _"${text}"_`, { parse_mode: "Markdown", ...rp })
        const voicePrompt = caption ? `[audio] ${text}\n\n${caption}` : `[audio] ${text}`
        await executeWithRetry(ctx.api, chatId, messageId, (a) => a.call(voicePrompt), voicePrompt, deps)
      })
    )
  })
}
