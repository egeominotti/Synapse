import { describe, it, expect } from "bun:test"
import { parseDecomposition, detectTeamResponse, buildSynthesizePrompt } from "../src/orchestrator"
import { generateIdentity } from "../src/agent-identity"
import type { WorkerResult } from "../src/types"

// ---------------------------------------------------------------------------
// parseDecomposition — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("parseDecomposition", () => {
  it("parses a clean JSON array", () => {
    const raw = '[{"task": "Analyze React"}, {"task": "Analyze Vue"}]'
    const result = parseDecomposition(raw, 20)
    expect(result).toEqual([{ task: "Analyze React" }, { task: "Analyze Vue" }])
  })

  it("parses JSON with markdown code fences", () => {
    const raw = '```json\n[{"task": "Task A"}, {"task": "Task B"}]\n```'
    const result = parseDecomposition(raw, 20)
    expect(result).toEqual([{ task: "Task A" }, { task: "Task B" }])
  })

  it("parses JSON with plain code fences (no language tag)", () => {
    const raw = '```\n[{"task": "X"}, {"task": "Y"}]\n```'
    const result = parseDecomposition(raw, 20)
    expect(result).toEqual([{ task: "X" }, { task: "Y" }])
  })

  it("parses JSON with surrounding text", () => {
    const raw = 'Here are the sub-tasks:\n[{"task": "A"}, {"task": "B"}]\nDone.'
    const result = parseDecomposition(raw, 20)
    expect(result).toEqual([{ task: "A" }, { task: "B" }])
  })

  it("parses many sub-tasks", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ task: `Task ${i + 1}` }))
    const raw = JSON.stringify(tasks)
    const result = parseDecomposition(raw, 20)
    expect(result).toHaveLength(10)
    expect(result![0].task).toBe("Task 1")
    expect(result![9].task).toBe("Task 10")
  })

  it("truncates when exceeding maxAgents", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ task: `Task ${i + 1}` }))
    const raw = JSON.stringify(tasks)
    const result = parseDecomposition(raw, 5)
    expect(result).toHaveLength(5)
    expect(result![4].task).toBe("Task 5")
  })

  it("returns null for single sub-task (need at least 2)", () => {
    const raw = '[{"task": "Only one task"}]'
    const result = parseDecomposition(raw, 20)
    expect(result).toBeNull()
  })

  it("returns null for empty array", () => {
    const raw = "[]"
    const result = parseDecomposition(raw, 20)
    expect(result).toBeNull()
  })

  it("returns null for invalid JSON", () => {
    const raw = "this is not json at all"
    const result = parseDecomposition(raw, 20)
    expect(result).toBeNull()
  })

  it("returns null for no array brackets", () => {
    const raw = '{"task": "single object"}'
    const result = parseDecomposition(raw, 20)
    expect(result).toBeNull()
  })

  it("returns null for malformed JSON array", () => {
    const raw = '[{"task": "A"}, {"task": '
    const result = parseDecomposition(raw, 20)
    expect(result).toBeNull()
  })

  it("skips items without task field", () => {
    const raw = '[{"task": "A"}, {"name": "B"}, {"task": "C"}]'
    const result = parseDecomposition(raw, 20)
    expect(result).toEqual([{ task: "A" }, { task: "C" }])
  })

  it("returns null when only one valid task after filtering", () => {
    const raw = '[{"task": "A"}, {"invalid": true}, {"also_invalid": 42}]'
    const result = parseDecomposition(raw, 20)
    expect(result).toBeNull()
  })

  it("handles whitespace and newlines", () => {
    const raw = `
      [
        { "task": "First task" },
        { "task": "Second task" }
      ]
    `
    const result = parseDecomposition(raw, 20)
    expect(result).toEqual([{ task: "First task" }, { task: "Second task" }])
  })

  it("handles maxAgents = 2 (minimum useful)", () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({ task: `T${i}` }))
    const raw = JSON.stringify(tasks)
    const result = parseDecomposition(raw, 2)
    expect(result).toHaveLength(2)
  })

  it("does not truncate when exactly at maxAgents", () => {
    const tasks = [{ task: "A" }, { task: "B" }, { task: "C" }]
    const raw = JSON.stringify(tasks)
    const result = parseDecomposition(raw, 3)
    expect(result).toHaveLength(3)
  })

  it("handles tasks with special characters", () => {
    const tasks = [{ task: 'Analyze "React" framework' }, { task: "Check for SQL injection in user's input" }]
    const result = parseDecomposition(JSON.stringify(tasks), 20)
    expect(result).toHaveLength(2)
    expect(result![0].task).toBe('Analyze "React" framework')
    expect(result![1].task).toBe("Check for SQL injection in user's input")
  })

  it("handles nested brackets in text (finds outermost array)", () => {
    const raw = 'Some text [{"task": "Compare [React] vs [Vue]"}, {"task": "Benchmark arrays []"}]'
    const result = parseDecomposition(raw, 20)
    expect(result).toHaveLength(2)
    expect(result![0].task).toBe("Compare [React] vs [Vue]")
  })

  it("handles fenced JSON with extra whitespace", () => {
    const raw = '```json\n\n  [  {"task": "A"} , {"task": "B"} ]  \n\n```'
    const result = parseDecomposition(raw, 20)
    expect(result).toEqual([{ task: "A" }, { task: "B" }])
  })
})

// ---------------------------------------------------------------------------
// detectTeamResponse — wraps parseDecomposition, used by auto-team logic
// ---------------------------------------------------------------------------

describe("detectTeamResponse", () => {
  it("returns subtasks when master responds with JSON array", () => {
    const text = '[{"task": "Analyze React"}, {"task": "Analyze Vue"}]'
    const result = detectTeamResponse(text, 20)
    expect(result).toEqual([{ task: "Analyze React" }, { task: "Analyze Vue" }])
  })

  it("returns null for a normal text response", () => {
    const text = "Ciao! Come posso aiutarti oggi?"
    const result = detectTeamResponse(text, 20)
    expect(result).toBeNull()
  })

  it("returns null for a long normal response with brackets in text", () => {
    const text = "React is a library for building UIs. It uses [JSX] syntax and virtual DOM."
    const result = detectTeamResponse(text, 20)
    expect(result).toBeNull()
  })

  it("detects subtasks inside markdown fences", () => {
    const text = '```json\n[{"task": "Research A"}, {"task": "Research B"}]\n```'
    const result = detectTeamResponse(text, 20)
    expect(result).toHaveLength(2)
    expect(result![0].task).toBe("Research A")
  })

  it("respects maxAgents limit", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ task: `Task ${i}` }))
    const text = JSON.stringify(tasks)
    const result = detectTeamResponse(text, 3)
    expect(result).toHaveLength(3)
  })

  it("returns null for single-task array (not worth parallelizing)", () => {
    const text = '[{"task": "Only one"}]'
    const result = detectTeamResponse(text, 20)
    expect(result).toBeNull()
  })

  it("returns null for empty string", () => {
    const result = detectTeamResponse("", 20)
    expect(result).toBeNull()
  })

  it("handles response with surrounding explanation text", () => {
    const text =
      'I will decompose this into sub-tasks:\n[{"task": "Part A"}, {"task": "Part B"}]\nEach will be handled by a worker.'
    const result = detectTeamResponse(text, 20)
    expect(result).toEqual([{ task: "Part A" }, { task: "Part B" }])
  })
})

// ---------------------------------------------------------------------------
// buildSynthesizePrompt — builds the synthesis prompt for the master
// ---------------------------------------------------------------------------

function makeWorkerResult(overrides: Partial<WorkerResult> & { subtask: string }): WorkerResult {
  return {
    identity: generateIdentity(1),
    result: { text: "Some result", durationMs: 100, sessionId: null, tokenUsage: null },
    error: null,
    ...overrides,
  }
}

describe("buildSynthesizePrompt", () => {
  it("includes all successful workers with correct numbering", () => {
    const results: WorkerResult[] = [
      makeWorkerResult({
        subtask: "Task A",
        identity: generateIdentity(1),
        result: { text: "Result A", durationMs: 100, sessionId: null, tokenUsage: null },
      }),
      makeWorkerResult({
        subtask: "Task B",
        identity: generateIdentity(2),
        result: { text: "Result B", durationMs: 200, sessionId: null, tokenUsage: null },
      }),
    ]
    const prompt = buildSynthesizePrompt("Compare X and Y", results)
    expect(prompt).toContain("Agent 1")
    expect(prompt).toContain("Agent 2")
    expect(prompt).toContain("Result A")
    expect(prompt).toContain("Result B")
    expect(prompt).toContain("Compare X and Y")
  })

  it("includes failed workers with error message", () => {
    const results: WorkerResult[] = [
      makeWorkerResult({
        subtask: "Task A",
        result: { text: "OK", durationMs: 100, sessionId: null, tokenUsage: null },
      }),
      makeWorkerResult({ subtask: "Task B", result: null, error: "timeout" }),
    ]
    const prompt = buildSynthesizePrompt("Do stuff", results)
    expect(prompt).toContain("Agent 1")
    expect(prompt).toContain("OK")
    expect(prompt).toContain("Agent 2")
    expect(prompt).toContain("[FAILED: timeout]")
  })

  it("uses 'unknown error' when error is null on a failed result", () => {
    const results: WorkerResult[] = [
      makeWorkerResult({ subtask: "A", result: { text: "OK", durationMs: 100, sessionId: null, tokenUsage: null } }),
      makeWorkerResult({ subtask: "B", result: null, error: null }),
    ]
    const prompt = buildSynthesizePrompt("test", results)
    expect(prompt).toContain("[FAILED: unknown error]")
  })

  it("preserves original order numbering with mixed success/failure", () => {
    const results: WorkerResult[] = [
      makeWorkerResult({ subtask: "A", result: null, error: "err1" }),
      makeWorkerResult({ subtask: "B", result: { text: "OK", durationMs: 100, sessionId: null, tokenUsage: null } }),
      makeWorkerResult({ subtask: "C", result: null, error: "err3" }),
    ]
    const prompt = buildSynthesizePrompt("test", results)
    const agent1Pos = prompt.indexOf("Agent 1")
    const agent2Pos = prompt.indexOf("Agent 2")
    const agent3Pos = prompt.indexOf("Agent 3")
    expect(agent1Pos).toBeLessThan(agent2Pos)
    expect(agent2Pos).toBeLessThan(agent3Pos)
  })

  it("includes worker identity names", () => {
    const results: WorkerResult[] = [
      makeWorkerResult({
        subtask: "A",
        identity: generateIdentity(1),
        result: { text: "R", durationMs: 0, sessionId: null, tokenUsage: null },
      }),
      makeWorkerResult({
        subtask: "B",
        identity: generateIdentity(2),
        result: { text: "R", durationMs: 0, sessionId: null, tokenUsage: null },
      }),
    ]
    const prompt = buildSynthesizePrompt("test", results)
    expect(prompt).toContain("Trinity") // generateIdentity(1)
    expect(prompt).toContain("Tank") // generateIdentity(2)
  })
})
