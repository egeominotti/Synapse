/**
 * Team collaboration orchestrator.
 *
 * The master agent autonomously decides when to decompose tasks.
 * When the master responds with a JSON subtask array, we detect it
 * and dispatch workers in parallel, then synthesize the results.
 *
 * Flow: User prompt → Master responds → detect team? → workers execute → Master synthesizes
 */

import type { Agent } from "./agent"
import type { AgentPool, AcquireResult } from "./agent-pool"
import type { TaskQueue } from "./task-queue"
import type { SubTask, WorkerResult, AgentCallResult } from "./types"
import type { AgentIdentity } from "./agent-identity"
import { logger } from "./logger"

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildSynthesizePrompt(originalPrompt: string, results: WorkerResult[]): string {
  const sections: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.result !== null) {
      sections.push(`--- Agent ${i + 1} (${r.identity.name}): ${r.subtask} ---\n${r.result.text}`)
    } else {
      sections.push(
        `--- Agent ${i + 1} (${r.identity.name}): ${r.subtask} ---\n[FAILED: ${r.error ?? "unknown error"}]`
      )
    }
  }

  return [
    `You were asked: "${originalPrompt}"`,
    "",
    "Your team executed these sub-tasks in parallel. Here are their results:",
    "",
    sections.join("\n\n"),
    "",
    "Synthesize these into a single, cohesive response. Don't repeat information — integrate the findings into a well-structured answer. If any agent failed, work with the results you have.",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Detect team response
// ---------------------------------------------------------------------------

/**
 * Detect if the master's response is a team decomposition (JSON subtask array).
 * Returns parsed subtasks if detected, null if the response is a normal answer.
 * This allows the master to autonomously decide when to use parallel workers.
 */
export function detectTeamResponse(text: string, maxAgents: number): SubTask[] | null {
  const subtasks = parseDecomposition(text, maxAgents)
  if (subtasks) {
    logger.info("Auto-team detected in master response", {
      count: subtasks.length,
      tasks: subtasks.map((s, i) => `[${i + 1}] ${s.task.slice(0, 80)}`),
    })
  }
  return subtasks
}

/**
 * Parse the master's JSON response into SubTask[].
 * Handles markdown fences, trailing text, and malformed JSON gracefully.
 */
export function parseDecomposition(raw: string, maxAgents: number): SubTask[] | null {
  let text = raw.trim()

  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fenceMatch) text = fenceMatch[1].trim()

  // Find the JSON array in the text
  const arrayStart = text.indexOf("[")
  const arrayEnd = text.lastIndexOf("]")
  if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(arrayStart, arrayEnd + 1))
  } catch {
    return null
  }

  if (!Array.isArray(parsed) || parsed.length < 2) return null

  const subtasks: SubTask[] = []
  for (const item of parsed) {
    if (typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).task === "string") {
      subtasks.push({ task: (item as Record<string, unknown>).task as string })
    }
  }

  if (subtasks.length < 2) return null

  // Apply safety cap
  if (subtasks.length > maxAgents) {
    logger.warn("Decomposition exceeded max agents, truncating", { requested: subtasks.length, max: maxAgents })
    return subtasks.slice(0, maxAgents)
  }

  return subtasks
}

// ---------------------------------------------------------------------------
// Execute team
// ---------------------------------------------------------------------------

export interface TeamProgress {
  identity: AgentIdentity
  subtask: string
  result: AgentCallResult | null
  error: string | null
  durationMs: number
}

/**
 * Execute sub-tasks in parallel via bunqueue TaskQueue.
 * Subtasks are enqueued and picked up by the Worker, which runs SDK agents.
 * Calls onProgress as each worker completes (for real-time status updates).
 */
export async function executeTeam(
  pool: AgentPool,
  subtasks: SubTask[],
  chatId: number,
  onProgress: (progress: TeamProgress) => void,
  taskQueue: TaskQueue
): Promise<{ workers: AcquireResult[]; results: WorkerResult[] }> {
  const workers = pool.acquireMultiple(subtasks.length)
  const results = await taskQueue.executeBatch(subtasks, workers, chatId, onProgress)
  return { workers, results }
}

// ---------------------------------------------------------------------------
// Synthesize
// ---------------------------------------------------------------------------

/**
 * Ask the master agent to synthesize all worker results into a final response.
 * Returns null if synthesis fails or there are no successful results.
 */
export async function synthesize(
  agent: Agent,
  originalPrompt: string,
  results: WorkerResult[]
): Promise<AgentCallResult | null> {
  const successful = results.filter((r) => r.result !== null)
  if (successful.length === 0) {
    logger.warn("No successful results to synthesize")
    return null
  }

  const prompt = buildSynthesizePrompt(originalPrompt, results)
  logger.info("Synthesis prompt sent to master", {
    successfulWorkers: successful.length,
    totalWorkers: results.length,
    promptLength: prompt.length,
  })

  try {
    const result = await agent.call(prompt)
    logger.info("Synthesis completed", { resultLength: result.text.length })
    return result
  } catch (err) {
    logger.error("Synthesis failed", { error: String(err) })
    return null
  }
}
