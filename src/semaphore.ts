/**
 * Counting semaphore for concurrent task limiting.
 *
 * acquire() resolves immediately if capacity is available,
 * otherwise queues the caller until a slot opens via release().
 */

export class Semaphore {
  private current = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly max: number) {}

  /** Acquire a permit. Resolves when a slot is available. */
  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++
        resolve()
      })
    })
  }

  /** Release a permit, unblocking the next queued caller. */
  release(): void {
    this.current--
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    }
  }

  /** Number of callers waiting for a permit. */
  get pending(): number {
    return this.queue.length
  }

  /** Number of permits currently held. */
  get active(): number {
    return this.current
  }
}
