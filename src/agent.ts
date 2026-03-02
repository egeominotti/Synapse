/**
 * Claude Code agent.
 * Uses the @anthropic-ai/claude-agent-sdk query() API for all Claude interactions.
 * Supports text prompts, vision (image + text), and streaming output.
 */

import { existsSync } from "fs"
import { dirname, extname } from "path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type {
  Options as SdkOptions,
  SDKMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { AgentConfig, AgentCallResult, TokenUsage, StreamEvent } from "./types"
import { logger } from "./logger"
import { createSandbox, cleanupSandbox, listSandboxFiles, buildAgentEnv, MIME_TYPES } from "./sandbox"
import { buildMcpServers } from "./mcp-config"

/** Hard safety timeout: aborts query even if timeout_ms = 0 (disabled). Prevents infinite hangs. */
const HARD_TIMEOUT_MS = 5 * 60 * 1_000 // 5 minutes

/** Errors that are considered transient and safe to retry */
const TRANSIENT_PATTERNS = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "socket hang up",
  "network",
  "rate limit",
  "429",
  "503",
  "502",
  "rate_limit",
  "server_error",
]

/** Distinct error class for hard timeouts — never retried */
export class TimeoutError extends Error {
  readonly isTimeout = true
  constructor(ms: number) {
    super(`Timeout: Claude did not respond within ${ms}ms`)
    this.name = "TimeoutError"
  }
}

export function isTransientError(err: Error): boolean {
  if (err instanceof TimeoutError) return false
  const lower = err.message.toLowerCase()
  return TRANSIENT_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
}

export class Agent {
  private readonly config: AgentConfig
  private sessionId: string | null = null
  /** Isolated sandbox directory — Claude runs here, not in the project root */
  readonly sandboxDir: string
  /** Active AbortController — used to cancel running queries via abort() */
  private abortController: AbortController | null = null

  constructor(config: AgentConfig) {
    this.config = config
    this.sandboxDir = createSandbox(config.collaboration, config.chatId)
  }

  /** List user-created files in the sandbox (excludes CLAUDE.md) */
  listSandboxFiles(): Array<{ path: string; mtimeMs: number }> {
    return listSandboxFiles(this.sandboxDir)
  }

  /** Remove the sandbox directory. Call before discarding the agent. */
  cleanup(): void {
    this.abort()
    cleanupSandbox(this.sandboxDir)
  }

  /** Cancel the currently running query (if any). Unblocks pending calls. */
  abort(): void {
    if (this.abortController) {
      try {
        this.abortController.abort()
        logger.info("Active query aborted via AbortController")
      } catch {
        /* already aborted */
      }
      this.abortController = null
    }
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  setSessionId(id: string | null): void {
    this.sessionId = id
    logger.setSessionId(id)
  }

  /** Update the system prompt (used to refresh memory context on worker agents). */
  setSystemPrompt(prompt: string | undefined): void {
    this.overrideSystemPrompt = prompt
  }

  private overrideSystemPrompt: string | undefined | null = null

  /** When true, disables all tool use (text-only output). */
  disableTools: boolean = false

  /** When set, restricts tool access (e.g. "Bash Read Write Edit"). */
  allowedTools: string | null = null

  /** Effort level: "low", "medium", "high". Null = SDK default. */
  effort: "low" | "medium" | "high" | null = null

  /** Send a text prompt with retry + timeout. */
  async call(prompt: string): Promise<AgentCallResult> {
    return this.callWithRetry(() => this.executeQuery(prompt))
  }

  /** Send an image + optional text prompt. */
  async callWithImage(imagePath: string, prompt: string): Promise<AgentCallResult> {
    if (!existsSync(imagePath)) throw new Error(`File not found: ${imagePath}`)
    const ext = extname(imagePath).toLowerCase()
    const mediaType = MIME_TYPES[ext]
    if (!mediaType) throw new Error(`Unsupported format: ${ext}. Use: ${Object.keys(MIME_TYPES).join(", ")}`)

    const imageData = Buffer.from(await Bun.file(imagePath).arrayBuffer()).toString("base64")
    return this.callWithRetry(() => this.executeQueryWithImage(mediaType, imageData, prompt))
  }

  /** Send raw base64 image data (e.g. downloaded from Telegram CDN). */
  async callWithRawImage(mediaType: string, base64Data: string, prompt: string): Promise<AgentCallResult> {
    return this.callWithRetry(() => this.executeQueryWithImage(mediaType, base64Data, prompt))
  }

  /** Send a text prompt with streaming — emits text events as they arrive. */
  async callStream(prompt: string, onEvent: (event: StreamEvent) => void): Promise<AgentCallResult> {
    return this.callWithRetry(() => this.executeQueryStream(prompt, onEvent))
  }

  // ---------------------------------------------------------------------------
  // SDK options builder
  // ---------------------------------------------------------------------------

  /** Build SDK query options from agent config and state. */
  buildSdkOptions(): Partial<SdkOptions> {
    const opts: Partial<SdkOptions> = {
      cwd: this.sandboxDir,
      env: buildAgentEnv(this.config.token),
    }

    // Permission mode
    if (this.config.skipPermissions) {
      opts.permissionMode = "bypassPermissions"
      opts.allowDangerouslySkipPermissions = true
    }

    // Tool control
    if (this.disableTools) {
      opts.allowedTools = []
    } else if (this.allowedTools) {
      opts.allowedTools = this.allowedTools.split(" ")
    }

    // Effort level
    if (this.effort) {
      opts.effort = this.effort
    }

    // Session: resume existing or set system prompt for new
    if (this.sessionId) {
      opts.resume = this.sessionId
    } else {
      const effectivePrompt = this.overrideSystemPrompt !== null ? this.overrideSystemPrompt : this.config.systemPrompt
      if (effectivePrompt) {
        opts.systemPrompt = effectivePrompt
      }
    }

    // MCP servers (inline — no config file needed)
    opts.mcpServers = buildMcpServers(dirname(this.config.dbPath))

    return opts
  }

  // ---------------------------------------------------------------------------
  // Retry logic
  // ---------------------------------------------------------------------------

  private async callWithRetry(fn: () => Promise<AgentCallResult>): Promise<AgentCallResult> {
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        lastError = error

        if (attempt < this.config.maxRetries && isTransientError(error)) {
          const delayMs = Math.min(this.config.initialRetryDelayMs * Math.pow(2, attempt - 1), 30_000)
          logger.warn(`Transient error on attempt ${attempt}/${this.config.maxRetries}, retrying in ${delayMs}ms`, {
            error: error.message,
          })
          await Bun.sleep(delayMs)
          continue
        }
        break
      }
    }

    throw lastError ?? new Error("Unknown error during agent call")
  }

  // ---------------------------------------------------------------------------
  // Shared query lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Run a query with timeout, abort, session tracking, and duration measurement.
   * The iterateFn receives each SDK message and can accumulate results.
   */
  private async runQuery(
    prompt: string | AsyncIterable<SDKUserMessage>,
    extraOpts: Partial<SdkOptions>,
    iterateFn: (msg: SDKMessage, state: QueryState) => void
  ): Promise<QueryState> {
    const startTime = performance.now()
    this.abortController = new AbortController()
    const opts = { ...this.buildSdkOptions(), ...extraOpts, abortController: this.abortController }

    const effectiveTimeout = this.config.timeoutMs > 0 ? this.config.timeoutMs : HARD_TIMEOUT_MS
    const timeoutHandle = setTimeout(() => this.abortController?.abort(), effectiveTimeout)

    const state: QueryState = { resultText: "", sessionId: this.sessionId, tokenUsage: null }

    try {
      for await (const msg of query({ prompt, options: opts as SdkOptions })) {
        this.processMessage(msg, state)
        iterateFn(msg, state)
      }
    } catch (err) {
      if (this.abortController?.signal.aborted) throw new TimeoutError(effectiveTimeout)
      throw err
    } finally {
      clearTimeout(timeoutHandle)
      this.abortController = null
    }

    if (state.sessionId && state.sessionId !== this.sessionId) {
      this.setSessionId(state.sessionId)
    }

    state.durationMs = Math.round(performance.now() - startTime)
    return state
  }

  // ---------------------------------------------------------------------------
  // Core query execution (text)
  // ---------------------------------------------------------------------------

  private async executeQuery(prompt: string): Promise<AgentCallResult> {
    logger.info("Agent query", {
      hasSession: !!this.sessionId,
      sessionId: this.sessionId?.slice(0, 16) ?? null,
      promptPreview: prompt.slice(0, 120),
      promptLength: prompt.length,
    })

    const state = await this.runQuery(prompt, {}, () => {})

    logger.info("Agent call completed", {
      sessionId: this.sessionId?.slice(0, 16) ?? null,
      durationMs: state.durationMs,
      resultLength: state.resultText.length,
      tokens: state.tokenUsage ? `${state.tokenUsage.inputTokens}in/${state.tokenUsage.outputTokens}out` : null,
    })

    return {
      text: state.resultText,
      sessionId: this.sessionId,
      tokenUsage: state.tokenUsage,
      durationMs: state.durationMs!,
    }
  }

  // ---------------------------------------------------------------------------
  // Query execution with streaming
  // ---------------------------------------------------------------------------

  private async executeQueryStream(prompt: string, onEvent: (event: StreamEvent) => void): Promise<AgentCallResult> {
    logger.debug("Agent query (streaming)", { hasSession: !!this.sessionId, promptLength: prompt.length })

    let accumulated = ""

    const state = await this.runQuery(prompt, { includePartialMessages: true }, (msg) => {
      if (msg.type === "stream_event") {
        const partial = msg as SDKPartialAssistantMessage
        const event = partial.event as { type?: string; delta?: { type?: string; text?: string } }
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          accumulated += event.delta.text
          onEvent({ type: "text", text: event.delta.text })
        }
      }
    })

    const result: AgentCallResult = {
      text: state.resultText || accumulated,
      sessionId: this.sessionId,
      tokenUsage: state.tokenUsage,
      durationMs: state.durationMs!,
    }

    onEvent({ type: "done", result })
    return result
  }

  // ---------------------------------------------------------------------------
  // Query execution with image (vision)
  // ---------------------------------------------------------------------------

  private async executeQueryWithImage(mediaType: string, base64Data: string, prompt: string): Promise<AgentCallResult> {
    logger.debug("Agent query (vision)", { hasSession: !!this.sessionId, mediaType })

    async function* imagePrompt(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: base64Data,
              },
            },
            { type: "text", text: prompt || "What do you see in this image?" },
          ],
        },
        parent_tool_use_id: null,
        session_id: "",
      } as SDKUserMessage
    }

    const state = await this.runQuery(imagePrompt(), {}, () => {})

    logger.info("Agent call completed", {
      sessionId: this.sessionId?.slice(0, 16) ?? null,
      durationMs: state.durationMs,
      resultLength: state.resultText.length,
      tokens: state.tokenUsage ? `${state.tokenUsage.inputTokens}in/${state.tokenUsage.outputTokens}out` : null,
    })

    return {
      text: state.resultText,
      sessionId: this.sessionId,
      tokenUsage: state.tokenUsage,
      durationMs: state.durationMs!,
    }
  }

  // ---------------------------------------------------------------------------
  // Shared message processor
  // ---------------------------------------------------------------------------

  /** Process a single SDK message — extracts session ID, result text, token usage, logs tool calls. */
  private processMessage(msg: SDKMessage, state: QueryState): void {
    // System init: capture session ID
    if (msg.type === "system") {
      const sysMsg = msg as SDKSystemMessage
      if (sysMsg.subtype === "init") {
        state.sessionId = sysMsg.session_id
      }
    }

    // Assistant messages: log MCP tool calls
    if (msg.type === "assistant") {
      const assistantMsg = msg as SDKAssistantMessage
      if (assistantMsg.message?.content) {
        for (const block of assistantMsg.message.content) {
          if (typeof block === "object" && "type" in block && block.type === "tool_use") {
            const b = block as { type: string; id?: string; name?: string; input?: unknown }
            logger.info("MCP tool called", {
              tool: b.name,
              toolId: b.id?.slice(0, 16),
              input: JSON.stringify(b.input ?? {}).slice(0, 200),
            })
          }
        }
      }

      if (assistantMsg.error) {
        logger.warn("Assistant message error", { error: assistantMsg.error })
      }
    }

    // Result: extract final text, usage, session ID
    if (msg.type === "result") {
      const resultMsg = msg as SDKResultMessage
      state.sessionId = resultMsg.session_id

      if (resultMsg.subtype === "success") {
        const success = resultMsg as SDKResultSuccess
        state.resultText = success.result
        state.tokenUsage = {
          inputTokens: success.usage.input_tokens ?? 0,
          outputTokens: success.usage.output_tokens ?? 0,
        }
      } else {
        const errorResult = resultMsg as SDKResultError
        const errorMsg = errorResult.errors?.join("; ") || `Query failed: ${errorResult.subtype}`
        throw new Error(errorMsg)
      }
    }
  }
}

/** Mutable state accumulated during a query lifecycle. */
interface QueryState {
  resultText: string
  sessionId: string | null
  tokenUsage: TokenUsage | null
  durationMs?: number
}
