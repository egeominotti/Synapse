import { describe, it, expect } from "bun:test"
import { buildMemoryContext, MAX_MEMORY_CHARS, MAX_RESPONSE_PREVIEW, type MemoryMessage } from "../src/memory"

describe("buildMemoryContext", () => {
  it("returns null for empty messages", () => {
    expect(buildMemoryContext([])).toBeNull()
  })

  it("formats messages with date, user prompt, and assistant response", () => {
    const messages: MemoryMessage[] = [
      { prompt: "Ciao", response: "Ciao! Come posso aiutarti?", timestamp: "2024-06-15T10:30:00Z" },
    ]
    const result = buildMemoryContext(messages)!
    expect(result).toContain("Previous conversation memory")
    expect(result).toContain("[2024-06-15] User: Ciao")
    expect(result).toContain("Assistant: Ciao! Come posso aiutarti?")
  })

  it("formats multiple messages in chronological order", () => {
    const messages: MemoryMessage[] = [
      { prompt: "Prima", response: "Risposta 1", timestamp: "2024-06-15T10:00:00Z" },
      { prompt: "Seconda", response: "Risposta 2", timestamp: "2024-06-15T11:00:00Z" },
    ]
    const result = buildMemoryContext(messages)!
    const primaIdx = result.indexOf("Prima")
    const secondaIdx = result.indexOf("Seconda")
    expect(primaIdx).toBeLessThan(secondaIdx)
  })

  it("truncates long responses", () => {
    const longResponse = "A".repeat(500)
    const messages: MemoryMessage[] = [{ prompt: "Test", response: longResponse, timestamp: "2024-06-15T10:00:00Z" }]
    const result = buildMemoryContext(messages)!
    expect(result).toContain("A".repeat(MAX_RESPONSE_PREVIEW) + "...")
    expect(result).not.toContain("A".repeat(MAX_RESPONSE_PREVIEW + 1))
  })

  it("respects MAX_MEMORY_CHARS limit", () => {
    const messages: MemoryMessage[] = Array.from({ length: 100 }, (_, i) => ({
      prompt: `Domanda numero ${i + 1} con testo lungo per riempire spazio`,
      response: "Risposta dettagliata con molte parole per simulare una risposta reale dell'assistente",
      timestamp: `2024-06-${String(15 + (i % 15)).padStart(2, "0")}T10:00:00Z`,
    }))
    const result = buildMemoryContext(messages)!
    expect(result.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS + 200) // small margin for last entry
  })

  it("preserves full prompts (no truncation)", () => {
    const longPrompt = "Scrivi una funzione che " + "X".repeat(200)
    const messages: MemoryMessage[] = [{ prompt: longPrompt, response: "Ok", timestamp: "2024-06-15T10:00:00Z" }]
    const result = buildMemoryContext(messages)!
    expect(result).toContain(longPrompt)
  })
})
