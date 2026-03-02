/**
 * Persistent message queue backed by bunqueue (SQLite).
 *
 * Incoming Telegram messages are serialized and enqueued to a durable queue.
 * A Worker processes messages with per-chat ordering via Semaphore.
 * Messages survive process restarts — unfinished jobs are retried automatically.
 */

import { Queue, Worker } from "bunqueue/client"
import { Semaphore } from "./semaphore"
import { logger } from "./logger"
import type { MessageJobData } from "./types"

const QUEUE_NAME = "synapse-messages"

export type MessageProcessor = (data: MessageJobData) => Promise<void>

export class MessageQueue {
  private queue: Queue<MessageJobData> | null = null
  private worker: Worker<MessageJobData, void> | null = null
  private readonly semaphores = new Map<number, Semaphore>()
  private maxConcurrency: number
  private readonly processor: MessageProcessor

  constructor(maxConcurrency: number, processor: MessageProcessor) {
    this.maxConcurrency = maxConcurrency
    this.processor = processor
  }

  /** Update the max concurrency for per-chat ordering. */
  setMaxConcurrency(n: number): void {
    this.maxConcurrency = n
    logger.info("MessageQueue max concurrency updated", { maxConcurrency: n })
  }

  /** Enqueue a message for processing. Persisted to SQLite immediately. */
  async enqueue(data: MessageJobData): Promise<void> {
    if (!this.queue) {
      throw new Error("MessageQueue not started — call start() first")
    }
    await this.queue.add("msg", data, {
      attempts: 2,
      backoff: { type: "fixed", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { count: 100 },
    })
    logger.debug("Message enqueued", { chatId: data.chatId, type: data.type })
  }

  /** Start the queue and worker. Must be called before enqueue(). */
  start(): void {
    if (this.worker) return

    this.queue = new Queue<MessageJobData>(QUEUE_NAME, { embedded: true })

    this.worker = new Worker<MessageJobData, void>(
      QUEUE_NAME,
      async (job) => {
        const data = job.data
        const chatId = data.chatId
        const sem = this.getSemaphore(chatId)

        logger.debug("Message dequeued", {
          jobId: job.id,
          chatId,
          type: data.type,
          prompt: data.prompt?.slice(0, 80),
        })

        await sem.acquire()
        try {
          await this.processor(data)
        } catch (err) {
          logger.error("Message processing failed", {
            jobId: job.id,
            chatId,
            type: data.type,
            error: err instanceof Error ? err.message : String(err),
          })
          throw err // let bunqueue handle retry
        } finally {
          sem.release()
          this.cleanupSemaphore(chatId, sem)
        }
      },
      {
        embedded: true,
        concurrency: 50, // high global concurrency — per-chat ordering via semaphore
        autorun: true,
        drainDelay: 100, // fast poll interval (100ms) for responsive message processing
      }
    )

    this.worker.on("completed", (job) => {
      logger.debug("Message job completed", { jobId: job.id, chatId: job.data.chatId })
    })

    this.worker.on("failed", (job, err) => {
      logger.error("Message job failed (final)", {
        jobId: job?.id,
        chatId: job?.data.chatId,
        error: err?.message,
      })
    })

    this.worker.on("error", (err) => {
      logger.error("MessageQueue worker error", { error: String(err) })
    })

    logger.info("MessageQueue started", { queue: QUEUE_NAME, maxConcurrency: this.maxConcurrency })
  }

  /** Gracefully stop the worker and queue. */
  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close()
      this.worker = null
    }
    this.queue = null
    logger.info("MessageQueue stopped")
  }

  /** Number of chats with active semaphores. */
  get size(): number {
    return this.semaphores.size
  }

  private getSemaphore(chatId: number): Semaphore {
    if (!this.semaphores.has(chatId)) {
      this.semaphores.set(chatId, new Semaphore(this.maxConcurrency))
    }
    return this.semaphores.get(chatId)!
  }

  private cleanupSemaphore(chatId: number, sem: Semaphore): void {
    if (sem.active === 0 && sem.pending === 0) {
      this.semaphores.delete(chatId)
    }
  }
}
