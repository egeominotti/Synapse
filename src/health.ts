/**
 * Health monitor — checks system stability every N seconds.
 *
 * Monitors: DB, Groq API, whisper binaries, memory usage.
 * Alerts admin on Telegram only when status changes (no spam).
 */

import { logger } from "./logger"
import { checkBinaryAvailable } from "./whisper"
import type { Database } from "./db"
import type { AgentPool } from "./agent-pool"

const MEMORY_THRESHOLD_MB = 512

export interface AgentPoolStatus {
  chatId: number
  master: { name: string; busy: boolean }
  workers: Array<{ name: string; busy: boolean }>
}

export interface HealthStatus {
  db: boolean
  groq: boolean | null // null = not configured
  whisper: boolean | null // null = not configured
  memoryMb: number
  uptimeMs: number
  pools: AgentPoolStatus[]
}

export interface HealthMonitorDeps {
  db: Database
  groqApiKey?: string
  whisperModelPath?: string
  botStartedAt: number
  agentPools: Map<number, AgentPool>
}

export class HealthMonitor {
  private previous: HealthStatus | null = null
  private running = false

  constructor(
    private deps: HealthMonitorDeps,
    private onAlert: (msg: string) => void
  ) {}

  /** Run all health checks and return current status. */
  async check(): Promise<HealthStatus> {
    const pools: AgentPoolStatus[] = []
    for (const [chatId, pool] of this.deps.agentPools) {
      const s = pool.getStatus()
      pools.push({ chatId, ...s })
    }

    const status: HealthStatus = {
      db: await this.checkDb(),
      groq: this.deps.groqApiKey ? await this.checkGroq() : null,
      whisper: this.deps.whisperModelPath ? await this.checkWhisper() : null,
      memoryMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      uptimeMs: Date.now() - this.deps.botStartedAt,
      pools,
    }

    this.detectChanges(status)
    this.previous = status

    return status
  }

  /** Start the health check loop. */
  start(intervalMs: number): void {
    if (this.running) return
    this.running = true
    this.loop(intervalMs)
  }

  /** Stop the health check loop. */
  stop(): void {
    this.running = false
  }

  // ---------------------------------------------------------------------------
  // Individual checks
  // ---------------------------------------------------------------------------

  private async checkDb(): Promise<boolean> {
    try {
      this.deps.db.getAllStats()
      return true
    } catch {
      return false
    }
  }

  private async checkGroq(): Promise<boolean> {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${this.deps.groqApiKey}` },
        signal: AbortSignal.timeout(5000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  private async checkWhisper(): Promise<boolean> {
    return await checkBinaryAvailable("whisper-cli")
  }

  // ---------------------------------------------------------------------------
  // Change detection & alerting
  // ---------------------------------------------------------------------------

  private detectChanges(current: HealthStatus): void {
    const prev = this.previous

    // First run — just log
    if (!prev) {
      this.logStatus(current)
      return
    }

    const alerts: string[] = []

    // DB
    if (prev.db && !current.db) alerts.push("SQLite DB unreachable")
    if (!prev.db && current.db) alerts.push("SQLite DB restored")

    // Groq
    if (prev.groq === true && current.groq === false) alerts.push("Groq API unreachable")
    if (prev.groq === false && current.groq === true) alerts.push("Groq API restored")

    // Whisper
    if (prev.whisper === true && current.whisper === false) alerts.push("whisper-cli not found")
    if (prev.whisper === false && current.whisper === true) alerts.push("whisper-cli restored")

    // Memory
    if (prev.memoryMb < MEMORY_THRESHOLD_MB && current.memoryMb >= MEMORY_THRESHOLD_MB) {
      alerts.push(`High memory usage: ${current.memoryMb} MB`)
    }
    if (prev.memoryMb >= MEMORY_THRESHOLD_MB && current.memoryMb < MEMORY_THRESHOLD_MB) {
      alerts.push(`Memory normalized: ${current.memoryMb} MB`)
    }

    if (alerts.length > 0) {
      const isRecovery = alerts.every((a) => a.includes("restored") || a.includes("normalized"))
      const emoji = isRecovery ? "✅" : "🚨"
      const msg =
        `${emoji} <b>Health Alert</b>\n\n` +
        alerts.map((a) => `• ${a}`).join("\n") +
        `\n\n<code>memory: ${current.memoryMb} MB | uptime: ${formatUptime(current.uptimeMs)}</code>`

      this.onAlert(msg)

      for (const alert of alerts) {
        const level = alert.includes("restored") || alert.includes("normalized") ? "info" : "error"
        logger[level]("Health alert", { alert })
      }
    }

    this.logStatus(current)
  }

  private logStatus(status: HealthStatus): void {
    const agentsSummary = status.pools.map((p) => {
      const masterStatus = p.master.busy ? "BUSY" : "IDLE"
      const busyWorkers = p.workers.filter((w) => w.busy).length
      return `chat:${p.chatId} master:${masterStatus} workers:${busyWorkers}/${p.workers.length}`
    })

    logger.debug("Health check", {
      db: status.db,
      groq: status.groq,
      whisper: status.whisper,
      memoryMb: status.memoryMb,
      uptimeMs: status.uptimeMs,
      activePools: status.pools.length,
      agents: agentsSummary.length > 0 ? agentsSummary : "none",
    })
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  private async loop(intervalMs: number): Promise<void> {
    while (this.running) {
      try {
        await this.check()
      } catch (err) {
        logger.error("Health check loop error", { error: String(err) })
      }
      await Bun.sleep(intervalMs)
    }
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
