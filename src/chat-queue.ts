/**
 * Per-chat message queue with configurable concurrency.
 *
 * maxConcurrency=1 (default): serial, identical to previous behavior.
 * maxConcurrency=N: up to N tasks per chat run concurrently.
 * Different chats always run independently.
 */

import { Semaphore } from "./semaphore"
import { logger } from "./logger"

type Task = () => Promise<void>

export class ChatQueue {
  private readonly semaphores = new Map<number, Semaphore>()
  private readonly pending = new Map<number, number>()
  private maxConcurrency: number

  constructor(maxConcurrency = 1) {
    this.maxConcurrency = maxConcurrency
  }

  /** Update the max concurrency. New semaphores will use this value. */
  setMaxConcurrency(n: number): void {
    this.maxConcurrency = n
    logger.info("ChatQueue max concurrency updated", { maxConcurrency: n })
  }

  /**
   * Enqueue a task for the given chat.
   * Up to maxConcurrency tasks run concurrently per chat.
   * Different chats run independently.
   * Optional onQueued callback fires when the task must wait (all slots occupied).
   */
  async enqueue(chatId: number, task: Task, onQueued?: () => void): Promise<void> {
    if (!this.semaphores.has(chatId)) {
      this.semaphores.set(chatId, new Semaphore(this.maxConcurrency))
    }
    const sem = this.semaphores.get(chatId)!
    this.pending.set(chatId, (this.pending.get(chatId) ?? 0) + 1)

    // Notify caller if this task will have to wait (all slots occupied)
    if (sem.active >= this.maxConcurrency && onQueued) {
      onQueued()
    }

    await sem.acquire()
    try {
      await task()
    } catch (err) {
      logger.error("ChatQueue task failed", { chatId, error: String(err) })
    } finally {
      sem.release()
      const count = (this.pending.get(chatId) ?? 1) - 1
      if (count <= 0) {
        this.semaphores.delete(chatId)
        this.pending.delete(chatId)
      } else {
        this.pending.set(chatId, count)
      }
    }
  }

  /** Number of chats with pending work */
  get size(): number {
    return this.semaphores.size
  }
}
