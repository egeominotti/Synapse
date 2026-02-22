import { describe, it, expect } from "bun:test"
import { ChatQueue } from "../src/chat-queue"

describe("ChatQueue", () => {
  it("processes tasks sequentially for the same chat", async () => {
    const queue = new ChatQueue()
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
})
