import { describe, it, expect } from "bun:test"
import { ChatQueue } from "../src/chat-queue"

describe("ChatQueue", () => {
  it("processes tasks sequentially for the same chat (maxConcurrency=1)", async () => {
    const queue = new ChatQueue(1)
    const order: number[] = []

    const task = (id: number, delayMs: number) => async () => {
      await Bun.sleep(delayMs)
      order.push(id)
    }

    // Enqueue 3 tasks for chat 1 — task 2 is faster but should still run after task 1
    queue.enqueue(1, task(1, 30))
    queue.enqueue(1, task(2, 10))
    await queue.enqueue(1, task(3, 10))

    expect(order).toEqual([1, 2, 3])
  })

  it("processes different chats concurrently", async () => {
    const queue = new ChatQueue()
    const order: string[] = []

    const task = (label: string, delayMs: number) => async () => {
      await Bun.sleep(delayMs)
      order.push(label)
    }

    // Chat A is slow, Chat B is fast — B should finish before A
    const a = queue.enqueue(1, task("A", 50))
    const b = queue.enqueue(2, task("B", 10))

    await Promise.all([a, b])
    expect(order).toEqual(["B", "A"])
  })

  it("continues processing after a task throws", async () => {
    const queue = new ChatQueue()
    const order: number[] = []

    queue.enqueue(1, async () => {
      throw new Error("boom")
    })
    await queue.enqueue(1, async () => {
      order.push(2)
    })

    expect(order).toEqual([2])
  })

  it("cleans up completed queues", async () => {
    const queue = new ChatQueue()

    await queue.enqueue(1, async () => {})
    expect(queue.size).toBe(0)
  })

  it("reports size correctly with pending tasks", async () => {
    const queue = new ChatQueue()

    queue.enqueue(1, () => Bun.sleep(50))
    queue.enqueue(2, () => Bun.sleep(50))

    expect(queue.size).toBe(2)

    // Wait for completion
    await Bun.sleep(70)
    expect(queue.size).toBe(0)
  })

  // --- Concurrency > 1 tests ---

  it("allows concurrent tasks with maxConcurrency > 1", async () => {
    const queue = new ChatQueue(3)
    let maxConcurrent = 0
    let current = 0

    const task = () => async () => {
      current++
      if (current > maxConcurrent) maxConcurrent = current
      await Bun.sleep(30)
      current--
    }

    // Enqueue 3 tasks for same chat — all should run concurrently
    await Promise.all([queue.enqueue(1, task()), queue.enqueue(1, task()), queue.enqueue(1, task())])

    expect(maxConcurrent).toBe(3)
  })

  it("limits concurrency to maxConcurrency", async () => {
    const queue = new ChatQueue(2)
    let maxConcurrent = 0
    let current = 0

    const task = () => async () => {
      current++
      if (current > maxConcurrent) maxConcurrent = current
      await Bun.sleep(30)
      current--
    }

    // Enqueue 4 tasks — only 2 should run at a time
    await Promise.all([
      queue.enqueue(1, task()),
      queue.enqueue(1, task()),
      queue.enqueue(1, task()),
      queue.enqueue(1, task()),
    ])

    expect(maxConcurrent).toBe(2)
  })

  it("default maxConcurrency=1 preserves serial behavior", async () => {
    const queue = new ChatQueue() // default = 1
    const order: number[] = []

    queue.enqueue(1, async () => {
      await Bun.sleep(20)
      order.push(1)
    })
    await queue.enqueue(1, async () => {
      order.push(2)
    })

    expect(order).toEqual([1, 2])
  })

  // --- onQueued callback tests ---

  it("calls onQueued when task must wait for a slot", async () => {
    const queue = new ChatQueue(1)
    let queuedCalled = false

    // First task occupies the slot
    queue.enqueue(1, () => Bun.sleep(50))

    // Second task should trigger onQueued since slot is occupied
    await queue.enqueue(
      1,
      async () => {},
      () => {
        queuedCalled = true
      }
    )

    expect(queuedCalled).toBe(true)
  })

  it("does not call onQueued when a slot is immediately available", async () => {
    const queue = new ChatQueue(1)
    let queuedCalled = false

    await queue.enqueue(
      1,
      async () => {},
      () => {
        queuedCalled = true
      }
    )

    expect(queuedCalled).toBe(false)
  })

  it("calls onQueued for each waiting task", async () => {
    const queue = new ChatQueue(1)
    let queuedCount = 0
    const onQueued = () => {
      queuedCount++
    }

    // First task occupies the slot
    queue.enqueue(1, () => Bun.sleep(50))

    // Both of these should trigger onQueued
    queue.enqueue(1, async () => {}, onQueued)
    await queue.enqueue(1, async () => {}, onQueued)

    expect(queuedCount).toBe(2)
  })
})
