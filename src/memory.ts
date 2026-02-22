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
    "## Memoria conversazioni precedenti",
    "",
    "Queste sono le ultime interazioni con questo utente. Usale come contesto per rispondere in modo coerente.",
    "",
  ]

  let totalChars = lines.join("\n").length

  for (const msg of messages) {
    const date = msg.timestamp.slice(0, 10)
    const response =
      msg.response.length > MAX_RESPONSE_PREVIEW ? msg.response.slice(0, MAX_RESPONSE_PREVIEW) + "..." : msg.response

    const entry = `[${date}] User: ${msg.prompt}\nAssistant: ${response}\n`

    if (totalChars + entry.length > MAX_MEMORY_CHARS) break

    lines.push(entry)
    totalChars += entry.length
  }

  // Only header was added — no actual messages fit
  if (lines.length <= 4) return null

  return lines.join("\n")
}
