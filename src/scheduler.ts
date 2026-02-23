/**
 * Job scheduler — embedded bunqueue Worker that processes scheduled jobs.
 * Jobs are created by Claude agents via MCP tools (bunqueue_add_job, etc.).
 * This module only runs the Worker side: it picks up completed jobs and
 * delivers results back to Telegram.
 */

import { Worker } from "bunqueue/client"
import { logger } from "./logger"

/** Data structure that agents put in the job's data field via MCP */
export interface ScheduledJobData {
  chatId: number
  prompt: string
  scheduleType?: string
}

/** Callback to process a fired job (spawn agent, format, send to Telegram) */
export type JobProcessor = (data: ScheduledJobData) => Promise<string>

/** Callback to notify a chat (send the result to Telegram) */
export type JobNotifier = (chatId: number, text: string) => Promise<void>

const QUEUE_NAME = "neo-jobs"

export class Scheduler {
  private worker: Worker<ScheduledJobData, string> | null = null
  private processor: JobProcessor
  private notifier: JobNotifier

  constructor(processor: JobProcessor, notifier: JobNotifier) {
    this.processor = processor
    this.notifier = notifier
  }

  /** Start the embedded Worker — picks up jobs from the shared SQLite DB. */
  start(): void {
    if (this.worker) return

    this.worker = new Worker<ScheduledJobData, string>(
      QUEUE_NAME,
      async (job) => {
        const data = job.data
        logger.info("Scheduler: processing job", {
          jobId: job.id,
          chatId: data.chatId,
          prompt: data.prompt?.slice(0, 80),
        })

        try {
          const result = await this.processor(data)
          await this.notifier(data.chatId, result)
          return result
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          logger.error("Scheduler: job failed", { jobId: job.id, error: errMsg })
          await this.notifier(data.chatId, `⚠️ Scheduled job failed: ${errMsg}`)
          throw err
        }
      },
      {
        embedded: true,
        concurrency: 2,
        autorun: true,
      }
    )

    this.worker.on("completed", (job) => {
      logger.info("Scheduler: job completed", { jobId: job.id, chatId: job.data.chatId })
    })

    this.worker.on("failed", (job, err) => {
      logger.error("Scheduler: job failed event", {
        jobId: job?.id,
        error: err?.message,
      })
    })

    this.worker.on("error", (err) => {
      logger.error("Scheduler: worker error", { error: String(err) })
    })

    logger.info("Scheduler started", { queue: QUEUE_NAME })
  }

  /** Gracefully stop the Worker. */
  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close()
      this.worker = null
      logger.info("Scheduler stopped")
    }
  }
}
