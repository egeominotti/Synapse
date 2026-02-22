/**
 * Per-chat serial message queue.
 *
 * Ensures that for any given chatId, only one message is being processed
 * at a time. Subsequent messages are queued and executed in order.
 * Prevents race conditions on Claude sessions (which are not concurrent-safe).
 */

import { logger } from "./logger"

type Task = () => Promise<void>

export class ChatQueue {
  private readonly queues = new Map<number, Promise<void>>()

  /**
   * Enqueue a task for the given chat.
   * The task will wait for any previous task on the same chat to complete
   * before executing. Different chats run concurrently.
   */
  enqueue(chatId: number, task: Task): Promise<void> {
    const previous = this.queues.get(chatId) ?? Promise.resolve()

    const next = previous
      .then(task)
      .catch((err) => {
        logger.error("ChatQueue task failed", { chatId, error: String(err) })
      })
      .finally(() => {
        // Clean up if this is still the last task in the chain
        if (this.queues.get(chatId) === next) {
          this.queues.delete(chatId)
        }
      })

    this.queues.set(chatId, next)
    return next
  }

  /** Number of chats with pending work */
  get size(): number {
    return this.queues.size
  }
}
