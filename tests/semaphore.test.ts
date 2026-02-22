import { describe, it, expect } from "bun:test"
import { Semaphore } from "../src/semaphore"

describe("Semaphore", () => {
  it("allows up to max concurrent acquires", async () => {
    const sem = new Semaphore(3)
    await sem.acquire()
    await sem.acquire()
    await sem.acquire()
    expect(sem.active).toBe(3)
    expect(sem.pending).toBe(0)
  })

  it("blocks when capacity is exhausted", async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    let resolved = false
    const waiting = sem.acquire().then(() => {
      resolved = true
    })

    await Bun.sleep(50)
    expect(resolved).toBe(false)
    expect(sem.pending).toBe(1)

    sem.release()
    await waiting
    expect(resolved).toBe(true)
    expect(sem.active).toBe(1)
    expect(sem.pending).toBe(0)
  })

  it("unblocks waiters in FIFO order", async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    const order: number[] = []

    const w1 = sem.acquire().then(() => order.push(1))
    const w2 = sem.acquire().then(() => order.push(2))
    const w3 = sem.acquire().then(() => order.push(3))

    expect(sem.pending).toBe(3)

    sem.release()
    await w1
    sem.release()
    await w2
    sem.release()
    await w3

    expect(order).toEqual([1, 2, 3])
  })

  it("with max=1 behaves as mutex", async () => {
    const sem = new Semaphore(1)
    const log: string[] = []

    const task = async (name: string) => {
      await sem.acquire()
      log.push(`${name}:start`)
      await Bun.sleep(30)
      log.push(`${name}:end`)
      sem.release()
    }

    await Promise.all([task("a"), task("b"), task("c")])

    // Tasks must not overlap
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"])
  })

  it("with max=2 allows 2 concurrent tasks", async () => {
    const sem = new Semaphore(2)
    let maxConcurrent = 0
    let current = 0

    const task = async () => {
      await sem.acquire()
      current++
      if (current > maxConcurrent) maxConcurrent = current
      await Bun.sleep(30)
      current--
      sem.release()
    }

    await Promise.all([task(), task(), task(), task()])

    expect(maxConcurrent).toBe(2)
  })

  it("release without acquire does not go negative", () => {
    const sem = new Semaphore(2)
    sem.release()
    expect(sem.active).toBe(-1) // edge case: caller's responsibility
  })

  it("active and pending report correct values", async () => {
    const sem = new Semaphore(2)
    expect(sem.active).toBe(0)
    expect(sem.pending).toBe(0)

    await sem.acquire()
    expect(sem.active).toBe(1)

    await sem.acquire()
    expect(sem.active).toBe(2)

    // Next acquire will block
    let blocked = true
    const w = sem.acquire().then(() => {
      blocked = false
    })
    await Bun.sleep(10)
    expect(blocked).toBe(true)
    expect(sem.pending).toBe(1)
    expect(sem.active).toBe(2)

    sem.release()
    await w
    expect(sem.active).toBe(2)
    expect(sem.pending).toBe(0)
  })
})
