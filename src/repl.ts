/**
 * Interactive REPL with slash commands, multiline input, session management,
 * and vision (image upload) support.
 */

import { createInterface, type Interface as RlInterface } from "readline"
import { existsSync } from "fs"
import { resolve } from "path"
import type { SlashCommand, ConversationMessage } from "./types"
import type { Agent } from "./agent"
import type { HistoryManager } from "./history"
import { Spinner } from "./spinner"
import { logger } from "./logger"
import { formatDuration } from "./utils"

const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"
const CYAN = "\x1b[1;36m"
const YELLOW = "\x1b[1;33m"
const GREEN = "\x1b[1;32m"
const RED = "\x1b[31m"
const DIM = "\x1b[90m"

export class Repl {
  private readonly agent: Agent
  private readonly history: HistoryManager
  private readonly commands: Map<string, SlashCommand> = new Map()
  private readonly rl: RlInterface
  private running = true
  private rlClosed = false // tracks whether readline interface has closed
  private activeSpinner: Spinner | null = null

  constructor(agent: Agent, history: HistoryManager) {
    this.agent = agent
    this.history = history

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
    })

    // Track close state so readLine() never hangs after EOF
    this.rl.on("close", () => {
      this.rlClosed = true
    })

    // When terminal:true, readline intercepts Ctrl+C as a raw byte and emits
    // "SIGINT" on the rl interface — not on the process. Re-emit it so our
    // process.on("SIGINT") handler fires correctly.
    this.rl.on("SIGINT", () => process.emit("SIGINT", "SIGINT"))

    this.registerCommands()
  }

  /** Public method so index.ts shutdown can stop any in-flight spinner */
  stopSpinner(): void {
    this.activeSpinner?.stop()
    this.activeSpinner = null
  }

  /** Main REPL loop */
  async run(): Promise<void> {
    this.printBanner()

    while (this.running) {
      const input = await this.readInput()

      if (input === null) {
        this.running = false
        break
      }

      const trimmed = input.trim()
      if (trimmed === "") continue

      if (trimmed.startsWith("/")) {
        await this.handleSlashCommand(trimmed)
        continue
      }

      await this.sendPrompt(trimmed)
    }
  }

  /** Read input from stdin, supporting multiline with trailing backslash */
  private async readInput(): Promise<string | null> {
    const lines: string[] = []
    let isMultiline = false

    while (true) {
      this.write(isMultiline ? `${DIM}... ${RESET}` : `${YELLOW}Tu: ${RESET}`)

      const line = await this.readLine()
      if (line === null) return lines.length > 0 ? lines.join("\n") : null

      if (line.endsWith("\\")) {
        lines.push(line.slice(0, -1))
        isMultiline = true
        continue
      }

      lines.push(line)
      break
    }

    return lines.join("\n")
  }

  /** Read a single line via readline. Returns null on EOF or already-closed interface. */
  private readLine(): Promise<string | null> {
    // If rl closed while we were away (e.g. Ctrl+D during agent.call()), resolve
    // immediately instead of hanging forever waiting for an event that won't come.
    if (this.rlClosed) return Promise.resolve(null)

    return new Promise<string | null>((resolve) => {
      const onLine = (line: string): void => {
        this.rl.off("line", onLine)
        this.rl.off("close", onClose)
        resolve(line)
      }
      const onClose = (): void => {
        this.rlClosed = true
        this.rl.off("line", onLine)
        resolve(null)
      }
      this.rl.once("line", onLine)
      this.rl.once("close", onClose)
    })
  }

  /** Parse and execute a slash command */
  private async handleSlashCommand(input: string): Promise<void> {
    const parts = input.slice(1).split(/\s+/)
    const name = parts[0].toLowerCase()
    const args = parts.slice(1).join(" ")

    const command = this.commands.get(name)
    if (!command) {
      this.write(`${RED}Comando sconosciuto: /${name}. Usa /help per la lista comandi.${RESET}\n\n`)
      return
    }

    await command.handler(args)
  }

  /** Send a plain text prompt to the agent */
  private async sendPrompt(prompt: string): Promise<void> {
    const spinner = new Spinner()
    this.activeSpinner = spinner
    spinner.start()

    try {
      const result = await this.agent.call(prompt)

      if (result.sessionId && this.history.getCurrentSessionId() !== result.sessionId) {
        this.history.initSession(result.sessionId)
      }

      await this.history.addMessage({
        timestamp: new Date().toISOString(),
        prompt,
        response: result.text,
        durationMs: result.durationMs,
        tokenUsage: result.tokenUsage,
      } satisfies ConversationMessage)

      this.write(`\n${GREEN}Claude:${RESET} ${result.text}\n\n`)
      this.writeMeta(result.sessionId, result.durationMs, result.tokenUsage)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error("Agent call failed", { error: errorMsg })
      this.write(`${RED}Errore: ${errorMsg}${RESET}\n\n`)
    } finally {
      spinner.stop()
      this.activeSpinner = null
    }
  }

  /** Send an image + optional text prompt to the agent */
  private async sendImagePrompt(imagePath: string, prompt: string): Promise<void> {
    const spinner = new Spinner(`Analisi immagine: ${imagePath}...`)
    this.activeSpinner = spinner
    spinner.start()

    try {
      const result = await this.agent.callWithImage(imagePath, prompt)

      if (result.sessionId && this.history.getCurrentSessionId() !== result.sessionId) {
        this.history.initSession(result.sessionId)
      }

      const displayPrompt = `[immagine: ${imagePath}] ${prompt}`.trim()
      await this.history.addMessage({
        timestamp: new Date().toISOString(),
        prompt: displayPrompt,
        response: result.text,
        durationMs: result.durationMs,
        tokenUsage: result.tokenUsage,
      } satisfies ConversationMessage)

      this.write(`\n${GREEN}Claude:${RESET} ${result.text}\n\n`)
      this.writeMeta(result.sessionId, result.durationMs, result.tokenUsage)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error("Image call failed", { error: errorMsg })
      this.write(`${RED}Errore: ${errorMsg}${RESET}\n\n`)
    } finally {
      spinner.stop()
      this.activeSpinner = null
    }
  }

  private writeMeta(
    sessionId: string | null,
    durationMs: number,
    tokenUsage: { inputTokens: number; outputTokens: number } | null
  ): void {
    const meta: string[] = []
    if (sessionId) meta.push(`session: ${sessionId.slice(0, 8)}...`)
    meta.push(`${durationMs}ms`)
    if (tokenUsage) meta.push(`tokens: ${tokenUsage.inputTokens}in/${tokenUsage.outputTokens}out`)
    this.write(`${DIM}[${meta.join(" | ")}]${RESET}\n\n`)
  }

  // ---------------------------------------------------------------------------
  // Slash command registration
  // ---------------------------------------------------------------------------

  private registerCommands(): void {
    const commands: SlashCommand[] = [
      {
        name: "help",
        description: "Mostra i comandi disponibili",
        handler: async () => {
          this.printHelp()
          return true
        },
      },
      {
        name: "image",
        description: "Invia un'immagine a Claude: /image <percorso> [prompt]",
        handler: async (args) => {
          await this.handleImageCommand(args.trim())
          return true
        },
      },
      {
        name: "history",
        description: "Mostra gli ultimi 5 messaggi della sessione",
        handler: async () => {
          this.printHistory()
          return true
        },
      },
      {
        name: "sessions",
        description: "Lista le sessioni salvate",
        handler: async () => {
          await this.printSessions()
          return true
        },
      },
      {
        name: "load",
        description: "Carica una sessione precedente: /load <session_id>",
        handler: async (args) => {
          await this.loadSession(args.trim())
          return true
        },
      },
      {
        name: "stats",
        description: "Mostra le statistiche della sessione corrente",
        handler: async () => {
          this.printStats()
          return true
        },
      },
      {
        name: "reset",
        description: "Resetta la sessione corrente",
        handler: async () => {
          this.agent.setSessionId(null)
          this.history.reset()
          this.write(`${DIM}[sessione resettata]${RESET}\n\n`)
          return true
        },
      },
      {
        name: "exit",
        description: "Esci dall'agente",
        handler: async () => {
          this.running = false
          return true
        },
      },
    ]

    for (const cmd of commands) this.commands.set(cmd.name, cmd)
  }

  // ---------------------------------------------------------------------------
  // Slash command implementations
  // ---------------------------------------------------------------------------

  private async handleImageCommand(args: string): Promise<void> {
    if (!args) {
      this.write(`${RED}Uso: /image <percorso_file> [prompt]${RESET}\n`)
      this.write(`${DIM}Formati supportati: jpg, jpeg, png, gif, webp${RESET}\n\n`)
      return
    }

    // First token is path, rest is the optional prompt
    const spaceIdx = args.indexOf(" ")
    const rawPath = spaceIdx === -1 ? args : args.slice(0, spaceIdx)
    const prompt = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim()
    const imagePath = resolve(rawPath)

    if (!existsSync(imagePath)) {
      this.write(`${RED}File non trovato: ${imagePath}${RESET}\n\n`)
      return
    }

    this.write(`${DIM}Caricamento immagine: ${imagePath}${RESET}\n`)
    await this.sendImagePrompt(imagePath, prompt)
  }

  private printBanner(): void {
    this.write(`\n${CYAN}`)
    this.write("  ╔══════════════════════════════════════════════════╗\n")
    this.write("  ║       Claude Agent v2.0 (Enterprise)            ║\n")
    this.write("  ║                                                  ║\n")
    this.write("  ║  /help per i comandi  |  /image per le foto     ║\n")
    this.write("  ╚══════════════════════════════════════════════════╝\n")
    this.write(`${RESET}\n`)
  }

  private printHelp(): void {
    this.write(`\n${BOLD}Comandi disponibili:${RESET}\n\n`)
    const sorted = [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const cmd of sorted) {
      this.write(`  ${CYAN}/${cmd.name.padEnd(12)}${RESET} ${cmd.description}\n`)
    }
    this.write(`\n${DIM}Suggerimento: termina una riga con \\ per input multilinea.${RESET}\n\n`)
  }

  private printHistory(): void {
    const messages = this.history.getRecentMessages(5)
    if (messages.length === 0) {
      this.write(`${DIM}Nessun messaggio in questa sessione.${RESET}\n\n`)
      return
    }
    this.write(`\n${BOLD}Ultimi ${messages.length} messaggi:${RESET}\n\n`)
    for (const msg of messages) {
      const ts = new Date(msg.timestamp).toLocaleTimeString("it-IT")
      const q = msg.prompt.length > 60 ? msg.prompt.slice(0, 57) + "..." : msg.prompt
      const a = msg.response.length > 80 ? msg.response.slice(0, 77) + "..." : msg.response
      this.write(`  ${DIM}${ts}${RESET} ${YELLOW}Tu:${RESET} ${q}\n`)
      this.write(`         ${GREEN}Claude:${RESET} ${a}\n`)
      this.write(`         ${DIM}(${msg.durationMs}ms)${RESET}\n\n`)
    }
  }

  private async printSessions(): Promise<void> {
    const sessions = await this.history.listSessions()
    if (sessions.length === 0) {
      this.write(`${DIM}Nessuna sessione salvata.${RESET}\n\n`)
      return
    }
    this.write(`\n${BOLD}Sessioni salvate (${sessions.length}):${RESET}\n\n`)
    const n = Math.min(sessions.length, 15)
    for (let i = 0; i < n; i++) {
      const s = sessions[i]
      const date = new Date(s.createdAt).toLocaleString("it-IT")
      this.write(`  ${CYAN}${s.sessionId.slice(0, 12)}...${RESET}  ${date}  ${DIM}(${s.messageCount} msg)${RESET}\n`)
    }
    if (sessions.length > n) this.write(`\n  ${DIM}... e altre ${sessions.length - n} sessioni${RESET}\n`)
    this.write(`\n${DIM}Usa /load <session_id> per caricare una sessione.${RESET}\n\n`)
  }

  private async loadSession(sessionId: string): Promise<void> {
    if (!sessionId) {
      this.write(`${RED}Uso: /load <session_id>${RESET}\n\n`)
      return
    }
    const session = await this.history.loadSession(sessionId)
    if (!session) {
      this.write(`${RED}Sessione non trovata: ${sessionId}${RESET}\n\n`)
      return
    }
    this.agent.setSessionId(session.sessionId)
    this.write(
      `${GREEN}Sessione caricata: ${session.sessionId.slice(0, 12)}... (${session.messages.length} messaggi)${RESET}\n\n`
    )
  }

  private printStats(): void {
    const stats = this.history.getStats()
    if (!stats || stats.totalMessages === 0) {
      this.write(`${DIM}Nessuna statistica disponibile.${RESET}\n\n`)
      return
    }
    const avg = Math.round(stats.totalDurationMs / stats.totalMessages)
    const tot = stats.totalInputTokens + stats.totalOutputTokens
    this.write(`\n${BOLD}Statistiche sessione:${RESET}\n\n`)
    this.write(`  Messaggi totali:     ${CYAN}${stats.totalMessages}${RESET}\n`)
    this.write(`  Durata totale:       ${CYAN}${formatDuration(stats.totalDurationMs)}${RESET}\n`)
    this.write(`  Durata media:        ${CYAN}${formatDuration(avg)}${RESET}\n`)
    if (tot > 0) {
      this.write(`  Token input totali:  ${CYAN}${stats.totalInputTokens.toLocaleString("it-IT")}${RESET}\n`)
      this.write(`  Token output totali: ${CYAN}${stats.totalOutputTokens.toLocaleString("it-IT")}${RESET}\n`)
      this.write(`  Token totali:        ${CYAN}${tot.toLocaleString("it-IT")}${RESET}\n`)
    } else {
      this.write(`  Token:               ${DIM}non disponibile${RESET}\n`)
    }
    this.write("\n")
  }

  private write(text: string): void {
    process.stdout.write(text)
  }

  stop(): void {
    this.running = false
  }
}
