/**
 * Conversation memory builder.
 * Formats recent messages into a context block for the system prompt,
 * so Claude can "remember" past conversations after a session restart.
 */

/** Max messages to include in memory context */
export const MAX_MEMORY_MESSAGES = 30

/** Max total characters for the memory block */
export const MAX_MEMORY_CHARS = 6000

/** Max characters per response preview */
export const MAX_RESPONSE_PREVIEW = 150

/** Max characters for full conversation context (worker agents) */
export const MAX_FULL_CONTEXT_CHARS = 50_000

export interface MemoryMessage {
  prompt: string
  response: string
  timestamp: string
}

/**
 * Build a memory context string from recent messages.
 * Returns null if no messages are available.
 */
export function buildMemoryContext(messages: MemoryMessage[]): string | null {
  if (messages.length === 0) return null

  const lines: string[] = [
    "## Previous conversation memory",
    "",
    "These are the recent interactions with this user. Use them as context to respond consistently.",
    "",
  ]

  let totalChars = lines.join("\n").length

  for (const msg of messages) {
    const date = msg.timestamp.slice(0, 10)
    const resp = msg.response ?? ""
    const response = resp.length > MAX_RESPONSE_PREVIEW ? resp.slice(0, MAX_RESPONSE_PREVIEW) + "..." : resp

    const entry = `[${date}] User: ${msg.prompt}\nAssistant: ${response}\n`

    if (totalChars + entry.length > MAX_MEMORY_CHARS) break

    lines.push(entry)
    totalChars += entry.length
  }

  // Only header was added — no actual messages fit
  if (lines.length <= 4) return null

  return lines.join("\n")
}

/**
 * Build a FULL conversation context from recent messages — no truncation.
 * Used by worker agents to get the same knowledge as the master (--resume).
 * Respects a generous char limit to avoid extreme token usage.
 */
export function buildFullConversationContext(messages: MemoryMessage[]): string | null {
  if (messages.length === 0) return null

  const lines: string[] = [
    "## Complete conversation",
    "",
    "This is the complete conversation with the user. Respond consistently with the context.",
    "",
  ]

  let totalChars = lines.join("\n").length

  for (const msg of messages) {
    const entry = `User: ${msg.prompt}\nAssistant: ${msg.response ?? ""}\n`

    if (totalChars + entry.length > MAX_FULL_CONTEXT_CHARS) break

    lines.push(entry)
    totalChars += entry.length
  }

  if (lines.length <= 4) return null

  return lines.join("\n")
}
