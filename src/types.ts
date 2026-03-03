/**
 * Type definitions for the Claude Agent REPL.
 * All shared interfaces and type aliases live here.
 */

/** Log severity levels */
export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG"

/** A single message exchange in a conversation */
export interface ConversationMessage {
  timestamp: string
  prompt: string
  response: string
  durationMs: number
  tokenUsage: TokenUsage | null
}

/** Token usage reported by Claude (when available in JSON output) */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/** A persisted session on disk */
export interface SessionFile {
  sessionId: string
  createdAt: string
  updatedAt: string
  messages: ConversationMessage[]
  stats: SessionStats
}

/** Cumulative statistics for a session */
export interface SessionStats {
  totalMessages: number
  totalDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
}

/** Configuration for the agent */
export interface AgentConfig {
  token: string
  timeoutMs: number
  maxRetries: number
  initialRetryDelayMs: number
  /** Path to the SQLite database file */
  dbPath: string
  /** If true, bypasses permission prompts in the SDK */
  skipPermissions: boolean
  /** Optional system prompt that defines the agent's persona and capabilities */
  systemPrompt?: string
  /** Path to whisper.cpp GGML model file — enables voice transcription if set */
  whisperModelPath?: string
  /** Whisper language code (ISO 639-1, default: "auto") */
  whisperLanguage?: string
  /** CPU threads for whisper transcription (default: 4) */
  whisperThreads?: number
  /** Groq API key — enables cloud STT as primary with local fallback */
  groqApiKey?: string
  /** Telegram chat ID — passed to sandbox for scheduling context */
  chatId?: number
}

/** Result of a single agent call */
export interface AgentCallResult {
  text: string
  sessionId: string | null
  tokenUsage: TokenUsage | null
  durationMs: number
}

/** Streaming event emitted during agent.callStream() */
export type StreamEvent = { type: "text"; text: string } | { type: "done"; result: AgentCallResult }

/** Slash command handler signature */
export type SlashCommandHandler = (args: string) => Promise<boolean>

/** Registry of slash commands */
export interface SlashCommand {
  name: string
  description: string
  handler: SlashCommandHandler
}

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

/** Keys that can be configured at runtime via Telegram */
export type RuntimeConfigKey =
  | "system_prompt"
  | "timeout_ms"
  | "max_retries"
  | "retry_delay_ms"
  | "skip_permissions"
  | "log_level"

/** Definition of a runtime-configurable parameter */
export interface ConfigDefinition {
  key: RuntimeConfigKey
  type: "string" | "number" | "boolean"
  description: string
  /** Default value (from env or hardcoded) — set at load time */
  defaultValue: string
  /** Minimum value for numbers */
  min?: number
  /** Maximum value for numbers */
  max?: number
  /** Allowed values for enums (e.g. log levels) */
  enum?: string[]
}
