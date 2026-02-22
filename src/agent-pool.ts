/**
 * Per-chat agent pool with master/worker model.
 *
 * All agents are pre-created at pool construction:
 *   - Slot 0 = master (Neo) — uses --resume for session continuity
 *   - Slots 1..N = workers — pre-created with fixed identities, refreshed memory on acquire
 */

import { Agent } from "./agent"
import type { AgentConfig } from "./types"
import type { Database } from "./db"
import { buildFullConversationContext } from "./memory"
import { ORCHESTRATOR_IDENTITY, generateIdentity, type AgentIdentity } from "./agent-identity"
import { logger } from "./logger"

export interface AcquireResult {
  agent: Agent
  isOverflow: boolean
  identity: AgentIdentity
}

interface AgentSlot {
  agent: Agent
  identity: AgentIdentity
  busy: boolean
}

export class AgentPool {
  private masterSlot: AgentSlot
  private readonly workerSlots: AgentSlot[]
  private readonly chatId: number
  private readonly config: AgentConfig
  private readonly db: Database

  constructor(chatId: number, primary: Agent, config: AgentConfig, db: Database) {
    this.chatId = chatId
    this.config = config
    this.db = db
    this.masterSlot = { agent: primary, identity: ORCHESTRATOR_IDENTITY, busy: false }

    // Pre-create worker agents (slots 1..maxConcurrent-1)
    this.workerSlots = []
    for (let i = 1; i < config.maxConcurrentPerChat; i++) {
      const worker = new Agent(config)
      const identity = generateIdentity(i)
      this.workerSlots.push({ agent: worker, identity, busy: false })
    }

    if (this.workerSlots.length > 0) {
      const names = this.workerSlots.map((w) => `${w.identity.emoji} ${w.identity.name}`)
      logger.info("Agent pool created", {
        chatId,
        master: `${ORCHESTRATOR_IDENTITY.emoji} ${ORCHESTRATOR_IDENTITY.name}`,
        workers: names,
      })
    }
  }

  /**
   * Acquire an agent for a call.
   * Prefers master (Neo), then first free worker.
   * Workers get fresh memory context from DB before each use.
   */
  acquire(): AcquireResult {
    // Prefer master
    if (!this.masterSlot.busy) {
      this.masterSlot.busy = true
      return { agent: this.masterSlot.agent, isOverflow: false, identity: ORCHESTRATOR_IDENTITY }
    }

    // Find first free worker
    for (const slot of this.workerSlots) {
      if (!slot.busy) {
        slot.busy = true
        this.refreshWorkerMemory(slot.agent)
        return { agent: slot.agent, isOverflow: true, identity: slot.identity }
      }
    }

    // All slots busy — shouldn't happen with correct semaphore, create temp overflow
    logger.warn("All agent slots busy, creating temporary overflow", { chatId: this.chatId })
    const tempAgent = new Agent(this.config)
    this.refreshWorkerMemory(tempAgent)
    const identity = generateIdentity(this.workerSlots.length + 1)
    return { agent: tempAgent, isOverflow: true, identity }
  }

  /**
   * Release an agent after a call completes.
   * Master: marked as available. Worker: marked as available + session cleared.
   */
  release(agent: Agent, isOverflow: boolean): void {
    if (!isOverflow) {
      this.masterSlot.busy = false
      return
    }

    // Check if it's a pre-created worker
    for (const slot of this.workerSlots) {
      if (slot.agent === agent) {
        slot.busy = false
        agent.setSessionId(null)
        return
      }
    }

    // Temporary overflow — clean up
    agent.cleanup()
    logger.debug("Temporary overflow agent cleaned up", { chatId: this.chatId })
  }

  /** Refresh a worker's system prompt with full conversation context from DB. */
  private refreshWorkerMemory(agent: Agent): void {
    const recentMessages = this.db.getRecentMessagesByChatId(this.chatId, 100)
    const memory = buildFullConversationContext(recentMessages)
    const basePrompt = this.config.systemPrompt ?? ""
    agent.setSystemPrompt(memory ? basePrompt + "\n\n" + memory : basePrompt || undefined)
  }

  /** Get the master agent (for session ID access, history, etc.) */
  getPrimary(): Agent {
    return this.masterSlot.agent
  }

  /** Replace the master agent (used on session reset) */
  setPrimary(agent: Agent): void {
    this.masterSlot.agent = agent
    this.masterSlot.busy = false
  }

  /** Clean up all agents (master + workers) — used by /reset and LRU eviction */
  cleanup(): void {
    this.masterSlot.agent.abort()
    this.masterSlot.agent.cleanup()
    for (const slot of this.workerSlots) {
      slot.agent.cleanup()
    }
    this.workerSlots.length = 0
  }

  /** Number of pre-created worker agents */
  get workerCount(): number {
    return this.workerSlots.length
  }

  /** Number of currently busy workers (not counting master) */
  get busyWorkerCount(): number {
    return this.workerSlots.filter((s) => s.busy).length
  }

  /** Get all identities in the pool (for display) */
  getIdentities(): AgentIdentity[] {
    return [ORCHESTRATOR_IDENTITY, ...this.workerSlots.map((s) => s.identity)]
  }

  /** Get status of all agent slots (for health monitor) */
  getStatus(): { master: { name: string; busy: boolean }; workers: Array<{ name: string; busy: boolean }> } {
    return {
      master: { name: ORCHESTRATOR_IDENTITY.name, busy: this.masterSlot.busy },
      workers: this.workerSlots.map((s) => ({ name: s.identity.name, busy: s.busy })),
    }
  }
}
