/**
 * Persistent task queue for auto-team subtask distribution.
 *
 * When the master agent decomposes a task, subtasks are enqueued to bunqueue.
 * A Worker picks them up and runs SDK agents in parallel.
 * Results are collected per batch; when all subtasks complete, the batch resolves.
 */

import { Queue, Worker } from "bunqueue/client"
import type { AcquireResult } from "./agent-pool"
import type { SubTask, SubTaskJob, WorkerResult, AgentCallResult } from "./types"
import type { TeamProgress } from "./orchestrator"
import { logger } from "./logger"

const QUEUE_NAME = "synapse-tasks"

interface BatchTracker {
  total: number
  completed: number
  results: WorkerResult[]
  agents: AcquireResult[]
  onProgress: (progress: TeamProgress) => void
  resolve: (results: WorkerResult[]) => void
  reject: (error: Error) => void
}

export class TaskQueue {
  private queue: Queue<SubTaskJob> | null = null
  private worker: Worker<SubTaskJob, void> | null = null
  private readonly batches = new Map<string, BatchTracker>()

  /** Start the queue and worker. Must be called before executeBatch(). */
  start(): void {
    if (this.worker) return

    this.queue = new Queue<SubTaskJob>(QUEUE_NAME, { embedded: true })

    this.worker = new Worker<SubTaskJob, void>(
      QUEUE_NAME,
      async (job) => {
        const { batchId, index, task } = job.data
        const batch = this.batches.get(batchId)
        if (!batch) {
          logger.warn("Orphan subtask job — batch not found", { batchId, index })
          return
        }

        const agent = batch.agents[index]
        const start = performance.now()

        let workerResult: WorkerResult
        try {
          const result: AgentCallResult = await agent.agent.call(task)
          const durationMs = Math.round(performance.now() - start)

          workerResult = { subtask: task, identity: agent.identity, result, error: null }
          batch.onProgress({ identity: agent.identity, subtask: task, result, error: null, durationMs })
        } catch (err) {
          const durationMs = Math.round(performance.now() - start)
          const errorMsg = err instanceof Error ? err.message : String(err)

          workerResult = { subtask: task, identity: agent.identity, result: null, error: errorMsg }
          batch.onProgress({ identity: agent.identity, subtask: task, result: null, error: errorMsg, durationMs })
        }

        batch.results[index] = workerResult
        batch.completed++

        logger.debug("Subtask completed", {
          batchId: batchId.slice(0, 8),
          index,
          completed: batch.completed,
          total: batch.total,
          agent: agent.identity.name,
        })

        if (batch.completed === batch.total) {
          this.batches.delete(batchId)
          batch.resolve(batch.results)
        }
      },
      {
        embedded: true,
        concurrency: 50,
        autorun: true,
        drainDelay: 100,
      }
    )

    this.worker.on("error", (err) => {
      logger.error("TaskQueue worker error", { error: String(err) })
    })

    logger.info("TaskQueue started", { queue: QUEUE_NAME })
  }

  /**
   * Execute a batch of subtasks in parallel via bunqueue.
   * Returns a Promise that resolves when ALL subtasks complete.
   * Results are ordered by index (same order as input subtasks).
   */
  async executeBatch(
    subtasks: SubTask[],
    agents: AcquireResult[],
    chatId: number,
    onProgress: (progress: TeamProgress) => void
  ): Promise<WorkerResult[]> {
    if (!this.queue) throw new Error("TaskQueue not started — call start() first")

    const batchId = crypto.randomUUID()
    const total = subtasks.length

    const promise = new Promise<WorkerResult[]>((resolve, reject) => {
      this.batches.set(batchId, {
        total,
        completed: 0,
        results: new Array(total),
        agents,
        onProgress,
        resolve,
        reject,
      })
    })

    // Enqueue all subtasks — Worker picks them up
    for (let i = 0; i < total; i++) {
      await this.queue.add(
        "subtask",
        {
          batchId,
          index: i,
          task: subtasks[i].task,
          chatId,
        },
        {
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
    }

    logger.info("Batch enqueued", {
      batchId: batchId.slice(0, 8),
      chatId,
      subtasks: total,
      agents: agents.map((a) => a.identity.name),
    })

    return promise
  }

  /** Gracefully stop the worker and queue. */
  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close()
      this.worker = null
    }
    this.queue = null
    this.batches.clear()
    logger.info("TaskQueue stopped")
  }
}
