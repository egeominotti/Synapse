import { describe, it, expect } from "bun:test"
import { buildSubagentDefinitions } from "../src/subagents"

describe("buildSubagentDefinitions", () => {
  const agents = buildSubagentDefinitions()

  it("returns researcher, code-writer, and reviewer", () => {
    expect(Object.keys(agents)).toEqual(["researcher", "code-writer", "reviewer"])
  })

  it("researcher uses haiku model", () => {
    expect(agents.researcher.model).toBe("haiku")
  })

  it("code-writer uses sonnet model", () => {
    expect(agents["code-writer"].model).toBe("sonnet")
  })

  it("reviewer uses haiku model", () => {
    expect(agents.reviewer.model).toBe("haiku")
  })

  it("researcher has read-only tools", () => {
    expect(agents.researcher.tools).toBeDefined()
    expect(agents.researcher.tools).toContain("Read")
    expect(agents.researcher.tools).toContain("Grep")
    expect(agents.researcher.tools).toContain("Glob")
    expect(agents.researcher.tools).not.toContain("Write")
    expect(agents.researcher.tools).not.toContain("Edit")
  })

  it("code-writer inherits all tools (no tools field)", () => {
    expect(agents["code-writer"].tools).toBeUndefined()
  })

  it("reviewer has read-only tools", () => {
    expect(agents.reviewer.tools).toBeDefined()
    expect(agents.reviewer.tools).toContain("Read")
    expect(agents.reviewer.tools).not.toContain("Write")
    expect(agents.reviewer.tools).not.toContain("Bash")
  })

  it("all agents have maxTurns set", () => {
    for (const [, def] of Object.entries(agents)) {
      expect(def.maxTurns).toBeDefined()
      expect(def.maxTurns).toBeGreaterThan(0)
    }
  })

  it("all agents have description and prompt", () => {
    for (const [, def] of Object.entries(agents)) {
      expect(def.description).toBeTruthy()
      expect(def.prompt).toBeTruthy()
    }
  })

  it("researcher maxTurns is 15", () => {
    expect(agents.researcher.maxTurns).toBe(15)
  })

  it("code-writer maxTurns is 25", () => {
    expect(agents["code-writer"].maxTurns).toBe(25)
  })

  it("reviewer maxTurns is 10", () => {
    expect(agents.reviewer.maxTurns).toBe(10)
  })
})
