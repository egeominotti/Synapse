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

/** The raw JSON structure returned by `claude --print --output-format json` */
export interface ClaudeResponse {
  session_id?: string
  result?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

/** Configuration for the agent */
export interface AgentConfig {
  token: string
  timeoutMs: number
  maxRetries: number
  initialRetryDelayMs: number
  /** Path to the SQLite database file */
  dbPath: string
  /** If true, passes --dangerously-skip-permissions to claude CLI */
  skipPermissions: boolean
  /** If true, each claude spawn runs inside a Docker container */
  useDocker: boolean
  /** Docker image to use when useDocker is true */
  dockerImage: string
  /** Optional system prompt that defines the agent's persona and capabilities */
  systemPrompt?: string
}

/** Result of a single agent call */
export interface AgentCallResult {
  text: string
  sessionId: string | null
  tokenUsage: TokenUsage | null
  durationMs: number
}

/** Slash command handler signature */
export type SlashCommandHandler = (args: string) => Promise<boolean>

/** Registry of slash commands */
export interface SlashCommand {
  name: string
  description: string
  handler: SlashCommandHandler
}
