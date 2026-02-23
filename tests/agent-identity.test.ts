import { describe, it, expect } from "bun:test"
import {
  generateIdentity,
  ORCHESTRATOR_IDENTITY,
  formatIdentityHeader,
  type AgentIdentity,
} from "../src/agent-identity"

describe("generateIdentity", () => {
  it("returns a valid identity", () => {
    const id = generateIdentity(1)
    expect(id.name).toBeTruthy()
    expect(id.code).toBeTruthy()
    expect(id.emoji).toBeTruthy()
  })

  it("name is deterministic for same jobId", () => {
    const a = generateIdentity(5)
    const b = generateIdentity(5)
    expect(a.name).toBe(b.name)
    expect(a.emoji).toBe(b.emoji)
  })

  it("different jobIds can produce different names", () => {
    const a = generateIdentity(0)
    const b = generateIdentity(1)
    expect(a.name).not.toBe(b.name)
  })

  it("code has 3-letter prefix from name + dash + 2 chars", () => {
    const id = generateIdentity(1)
    const prefix = id.name.slice(0, 3).toUpperCase()
    expect(id.code).toMatch(new RegExp(`^${prefix}-[A-Z0-9]{2}$`))
  })

  it("emoji cycles through color pool", () => {
    const emojis = new Set<string>()
    for (let i = 0; i < 6; i++) {
      emojis.add(generateIdentity(i).emoji)
    }
    expect(emojis.size).toBe(6)
  })
})

describe("ORCHESTRATOR_IDENTITY", () => {
  it('is named "Synapse"', () => {
    expect(ORCHESTRATOR_IDENTITY.name).toBe("Synapse")
    expect(ORCHESTRATOR_IDENTITY.code).toBe("SYN-01")
    expect(ORCHESTRATOR_IDENTITY.emoji).toBe("◉")
  })
})

describe("formatIdentityHeader", () => {
  it("formats identity without extra", () => {
    const id: AgentIdentity = { name: "Morpheus", code: "MRP-7X", emoji: "◈" }
    expect(formatIdentityHeader(id)).toBe("◈ · Morpheus · MRP-7X")
  })

  it("formats identity with extra info", () => {
    const id: AgentIdentity = { name: "Trinity", code: "TRN-3K", emoji: "◇" }
    expect(formatIdentityHeader(id, "⏰ Job #5")).toBe("◇ · Trinity · TRN-3K · ⏰ Job #5")
  })

  it("formats orchestrator identity", () => {
    const header = formatIdentityHeader(ORCHESTRATOR_IDENTITY)
    expect(header).toBe("◉ · Synapse · SYN-01")
  })
})
