import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { MessageQueue } from "../src/message-queue"
import type { MessageJobData } from "../src/types"

/** Helper to wait for condition with timeout */
async function waitFor(fn: () => boolean, timeoutMs = 10_000, intervalMs = 50): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return
    await Bun.sleep(intervalMs)
  }
}

// Shared temp dir for all tests — set once, cleaned once
let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mq-test-"))
  process.env.DATA_PATH = join(tempDir, "bunqueue.db")
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("MessageQueue", () => {
  it("throws if enqueue is called before start", async () => {
    const q = new MessageQueue(1, async () => {})
    const data: MessageJobData = { chatId: 1, type: "text", prompt: "hello" }
    expect(q.enqueue(data)).rejects.toThrow("not started")
  })

  it("processes messages and preserves FIFO ordering per chat", async () => {
    const processed: string[] = []

    const queue = new MessageQueue(1, async (data) => {
      if (data.prompt === "slow") await Bun.sleep(50)
      processed.push(data.prompt)
    })
    queue.start()

    try {
      // Same chat — should process in order despite "slow" first
      await queue.enqueue({ chatId: 100, type: "text", prompt: "slow" })
      await queue.enqueue({ chatId: 100, type: "text", prompt: "fast" })

      await waitFor(() => processed.length === 2)

      expect(processed).toEqual(["slow", "fast"])
    } finally {
      await queue.stop()
    }
  })

  it("processes different chats concurrently", async () => {
    const order: string[] = []

    const queue = new MessageQueue(1, async (data) => {
      if (data.prompt === "A") await Bun.sleep(200)
      order.push(data.prompt)
    })
    queue.start()

    try {
      await queue.enqueue({ chatId: 200, type: "text", prompt: "A" })
      await queue.enqueue({ chatId: 201, type: "text", prompt: "B" })

      await waitFor(() => order.length === 2)

      // B should finish before A because different chats run in parallel
      expect(order).toEqual(["B", "A"])
    } finally {
      await queue.stop()
    }
  })

  it("cleans up semaphores after processing", async () => {
    let count = 0

    const queue = new MessageQueue(1, async () => {
      count++
    })
    queue.start()

    try {
      await queue.enqueue({ chatId: 300, type: "text", prompt: "a" })
      await queue.enqueue({ chatId: 301, type: "text", prompt: "b" })

      await waitFor(() => count === 2)

      expect(queue.size).toBe(0)
    } finally {
      await queue.stop()
    }
  })

  it("serializes all MessageJobData fields through bunqueue", async () => {
    let received: MessageJobData | null = null

    const queue = new MessageQueue(1, async (data) => {
      received = data
    })
    queue.start()

    try {
      await queue.enqueue({
        chatId: 400,
        messageId: 123,
        type: "photo",
        prompt: "What is this?",
        fileId: "AgACAgIAA",
        mediaType: "image/jpeg",
      })

      await waitFor(() => received !== null)

      expect(received).not.toBeNull()
      expect(received!.chatId).toBe(400)
      expect(received!.messageId).toBe(123)
      expect(received!.type).toBe("photo")
      expect(received!.prompt).toBe("What is this?")
      expect(received!.fileId).toBe("AgACAgIAA")
      expect(received!.mediaType).toBe("image/jpeg")
    } finally {
      await queue.stop()
    }
  })
})
