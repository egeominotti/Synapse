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
  private readonly pending = new Map<number, number>()

  /**
   * Enqueue a task for the given chat.
   * The task will wait for any previous task on the same chat to complete
   * before executing. Different chats run concurrently.
   */
  enqueue(chatId: number, task: Task): Promise<void> {
    const previous = this.queues.get(chatId) ?? Promise.resolve()
    this.pending.set(chatId, (this.pending.get(chatId) ?? 0) + 1)

    const next = previous
      .then(task)
      .catch((err) => {
        logger.error("ChatQueue task failed", { chatId, error: String(err) })
      })
      .finally(() => {
        const count = (this.pending.get(chatId) ?? 1) - 1
        if (count <= 0) {
          this.queues.delete(chatId)
          this.pending.delete(chatId)
        } else {
          this.pending.set(chatId, count)
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
