/**
 * Per-chat agent pool with master/worker model.
 *
 * Workers are created lazily on first acquire — no upfront allocation.
 *   - Slot 0 = master (Synapse) — uses --resume for session continuity
 *   - Workers created on-demand up to maxConcurrentPerChat-1, then overflow
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
  private readonly maxWorkers: number
  private readonly chatId: number
  private readonly config: AgentConfig
  private readonly db: Database
  private overflowCounter: number = 0

  constructor(chatId: number, primary: Agent, config: AgentConfig, db: Database) {
    this.chatId = chatId
    this.config = config
    this.db = db
    // Master agent: all tools enabled, high effort for quality decisions
    primary.effort = "high"
    this.masterSlot = { agent: primary, identity: ORCHESTRATOR_IDENTITY, busy: false }
    this.maxWorkers = config.maxConcurrentPerChat - 1

    // Workers are created lazily — no upfront allocation
    this.workerSlots = []

    logger.info("Agent pool created", {
      chatId,
      master: `${ORCHESTRATOR_IDENTITY.emoji} ${ORCHESTRATOR_IDENTITY.name}`,
      maxWorkers: this.maxWorkers,
    })
  }

  /**
   * Acquire an agent for a call.
   * Prefers master (Synapse), then first free worker, then creates a new worker lazily.
   * Workers get fresh memory context from DB before each use.
   */
  acquire(): AcquireResult {
    // Prefer master
    if (!this.masterSlot.busy) {
      this.masterSlot.busy = true
      return { agent: this.masterSlot.agent, isOverflow: false, identity: ORCHESTRATOR_IDENTITY }
    }

    // Find first free existing worker
    for (const slot of this.workerSlots) {
      if (!slot.busy) {
        slot.busy = true
        this.refreshWorkerMemory(slot.agent)
        return { agent: slot.agent, isOverflow: false, identity: slot.identity }
      }
    }

    // No free worker — create one lazily if under max
    if (this.workerSlots.length < this.maxWorkers) {
      const identity = generateIdentity(this.workerSlots.length + 1)
      const worker = this.createWorker()
      const slot: AgentSlot = { agent: worker, identity, busy: true }
      this.workerSlots.push(slot)
      this.refreshWorkerMemory(worker)
      logger.info("Worker created on-demand", {
        chatId: this.chatId,
        worker: `${identity.emoji} ${identity.name}`,
        poolSize: this.workerSlots.length,
      })
      return { agent: worker, isOverflow: false, identity }
    }

    // All slots busy and at max — create temp overflow
    logger.warn("All agent slots busy, creating temporary overflow", { chatId: this.chatId })
    const tempAgent = this.createWorker()
    this.refreshWorkerMemory(tempAgent)
    this.overflowCounter++
    const identity = generateIdentity(this.maxWorkers + this.overflowCounter)
    return { agent: tempAgent, isOverflow: true, identity }
  }

  /**
   * Release an agent after a call completes.
   * Master: marked as available. Worker: marked as available + session cleared.
   */
  release(agent: Agent, isOverflow: boolean): void {
    if (!isOverflow) {
      // Could be master or a pre-created worker
      if (agent === this.masterSlot.agent) {
        this.masterSlot.busy = false
      } else {
        for (const slot of this.workerSlots) {
          if (slot.agent === agent) {
            slot.busy = false
            agent.setSessionId(null)
            break
          }
        }
      }
    } else {
      // Temporary overflow — clean up
      agent.cleanup()
      logger.debug("Temporary overflow agent cleaned up", { chatId: this.chatId })
    }

    // Log when all agents are idle
    if (!this.masterSlot.busy && this.workerSlots.every((s) => !s.busy)) {
      const names = [this.masterSlot, ...this.workerSlots].map((s) => `${s.identity.emoji} ${s.identity.name}`)
      logger.info("All agents idle", { chatId: this.chatId, team: names })
    }
  }

  /** Create a worker agent — all tools, no session persistence, no plugins. */
  private createWorker(): Agent {
    const worker = new Agent(this.config)
    worker.workerMode = true
    return worker
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

  /** Replace the master agent (used on session reset). Cleans up the old agent. */
  setPrimary(agent: Agent): void {
    const old = this.masterSlot.agent
    agent.effort = "high"
    this.masterSlot.agent = agent
    this.masterSlot.busy = false
    old.cleanup()
  }

  /** Clean up all agents (master + workers) — used by /reset and LRU eviction */
  cleanup(): void {
    this.masterSlot.agent.cleanup()
    for (const slot of this.workerSlots) {
      slot.agent.cleanup()
    }
    this.workerSlots.length = 0
  }

  /** Number of currently created worker agents */
  get workerCount(): number {
    return this.workerSlots.length
  }

  /** Maximum number of worker agents this pool can create */
  get maxWorkerCapacity(): number {
    return this.maxWorkers
  }

  /** Number of currently busy workers (not counting master) */
  get busyWorkerCount(): number {
    return this.workerSlots.filter((s) => s.busy).length
  }

  /** Get all identities in the pool (potential — includes uncreated workers) */
  getIdentities(): AgentIdentity[] {
    const identities: AgentIdentity[] = [ORCHESTRATOR_IDENTITY]
    for (let i = 1; i < this.config.maxConcurrentPerChat; i++) {
      identities.push(generateIdentity(i))
    }
    return identities
  }

  /** Get status of all agent slots (for health monitor) */
  getStatus(): { master: { name: string; busy: boolean }; workers: Array<{ name: string; busy: boolean }> } {
    return {
      master: { name: ORCHESTRATOR_IDENTITY.name, busy: this.masterSlot.busy },
      workers: this.workerSlots.map((s) => ({ name: s.identity.name, busy: s.busy })),
    }
  }

  /**
   * Acquire N workers for parallel team execution.
   * Reuses free existing workers, creates new ones lazily, then overflow.
   * Never acquires the master — it's reserved for decomposition/synthesis.
   */
  acquireMultiple(count: number): AcquireResult[] {
    const results: AcquireResult[] = []

    for (let i = 0; i < count; i++) {
      // Find first free existing worker
      const slot = this.workerSlots.find((s) => !s.busy)
      if (slot) {
        slot.busy = true
        this.refreshWorkerMemory(slot.agent)
        results.push({ agent: slot.agent, isOverflow: false, identity: slot.identity })
      } else if (this.workerSlots.length < this.maxWorkers) {
        // Create new worker lazily
        const identity = generateIdentity(this.workerSlots.length + 1)
        const worker = this.createWorker()
        const newSlot: AgentSlot = { agent: worker, identity, busy: true }
        this.workerSlots.push(newSlot)
        this.refreshWorkerMemory(worker)
        logger.info("Worker created on-demand (team)", {
          chatId: this.chatId,
          worker: `${identity.emoji} ${identity.name}`,
          poolSize: this.workerSlots.length,
        })
        results.push({ agent: worker, isOverflow: false, identity })
      } else {
        // Create temporary overflow agent
        const temp = this.createWorker()
        this.refreshWorkerMemory(temp)
        this.overflowCounter++
        const identity = generateIdentity(this.maxWorkers + this.overflowCounter)
        results.push({ agent: temp, isOverflow: true, identity })
      }
    }

    const names = results.map((r) => `${r.identity.emoji} ${r.identity.name}`)
    logger.info("Team agents acquired", { chatId: this.chatId, count: results.length, agents: names })

    return results
  }

  /**
   * Release all agents acquired via acquireMultiple().
   * Pre-created workers are returned to the pool; overflow agents are destroyed.
   */
  releaseMultiple(agents: AcquireResult[]): void {
    for (const { agent, isOverflow } of agents) {
      if (!isOverflow) {
        const slot = this.workerSlots.find((s) => s.agent === agent)
        if (slot) {
          slot.busy = false
          agent.setSessionId(null)
        }
      } else {
        agent.cleanup()
      }
    }

    logger.info("Team agents released", { chatId: this.chatId, count: agents.length })
  }
}
