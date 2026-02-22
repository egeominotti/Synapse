/**
 * Interactive REPL with slash commands, multiline input, session management,
 * and vision (image upload) support.
 */

import { createInterface, type Interface as RlInterface } from "readline"
import { resolve } from "path"
import type { SlashCommand, ConversationMessage, AgentCallResult } from "./types"
import type { Agent } from "./agent"
import type { HistoryManager } from "./history"
import { Spinner } from "./spinner"
import { logger } from "./logger"
import {
  printBanner,
  printHelp,
  printHistory,
  printSessions,
  loadSession,
  printStats,
  parseImageArgs,
  writeMeta,
  RED,
  DIM,
  RESET,
  GREEN,
} from "./repl-commands"

const YELLOW = "\x1b[1;33m"

export class Repl {
  private readonly agent: Agent
  private readonly history: HistoryManager
  private readonly commands: Map<string, SlashCommand> = new Map()
  private readonly rl: RlInterface
  private running = true
  private rlClosed = false
  private activeSpinner: Spinner | null = null

  constructor(agent: Agent, history: HistoryManager) {
    this.agent = agent
    this.history = history

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
    })

    this.rl.on("close", () => {
      this.rlClosed = true
    })

    this.rl.on("SIGINT", () => process.emit("SIGINT", "SIGINT"))
    this.registerCommands()
  }

  stopSpinner(): void {
    this.activeSpinner?.stop()
    this.activeSpinner = null
  }

  async run(): Promise<void> {
    printBanner(this.write.bind(this))

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

      await this.executePrompt(trimmed, (agent) => agent.call(trimmed))
    }
  }

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

  private readLine(): Promise<string | null> {
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

  /**
   * Shared prompt execution — DRY for text and image calls.
   * `callFn` performs the actual agent call; `displayPrompt` is stored in history.
   */
  private async executePrompt(
    displayPrompt: string,
    callFn: (agent: Agent) => Promise<AgentCallResult>,
    spinnerLabel?: string
  ): Promise<void> {
    const spinner = new Spinner(spinnerLabel)
    this.activeSpinner = spinner
    spinner.start()

    try {
      const result = await callFn(this.agent)

      if (result.sessionId && this.history.getCurrentSessionId() !== result.sessionId) {
        this.history.initSession(result.sessionId)
      }

      await this.history.addMessage({
        timestamp: new Date().toISOString(),
        prompt: displayPrompt,
        response: result.text,
        durationMs: result.durationMs,
        tokenUsage: result.tokenUsage,
      } satisfies ConversationMessage)

      this.write(`\n${GREEN}Claude:${RESET} ${result.text}\n\n`)
      writeMeta(result.sessionId, result.durationMs, result.tokenUsage, this.write.bind(this))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error("Agent call failed", { error: errorMsg })
      this.write(`${RED}Errore: ${errorMsg}${RESET}\n\n`)
    } finally {
      spinner.stop()
      this.activeSpinner = null
    }
  }

  // ---------------------------------------------------------------------------
  // Slash command registration
  // ---------------------------------------------------------------------------

  private registerCommands(): void {
    const w = this.write.bind(this)

    const commands: SlashCommand[] = [
      {
        name: "help",
        description: "Mostra i comandi disponibili",
        handler: async () => {
          printHelp(this.commands, w)
          return true
        },
      },
      {
        name: "image",
        description: "Invia un'immagine a Claude: /image <percorso> [prompt]",
        handler: async (args) => {
          const trimmed = args.trim()
          const parsed = parseImageArgs(trimmed)
          if (!parsed) {
            if (!trimmed) {
              w(`${RED}Uso: /image <percorso_file> [prompt]${RESET}\n`)
              w(`${DIM}Formati supportati: jpg, jpeg, png, gif, webp${RESET}\n\n`)
            } else {
              const imagePath = resolve(trimmed.split(/\s+/)[0])
              w(`${RED}File non trovato: ${imagePath}${RESET}\n\n`)
            }
            return true
          }
          w(`${DIM}Caricamento immagine: ${parsed.imagePath}${RESET}\n`)
          const label = `Analisi immagine: ${parsed.imagePath}...`
          const display = `[immagine: ${parsed.imagePath}] ${parsed.prompt}`.trim()
          await this.executePrompt(display, (agent) => agent.callWithImage(parsed.imagePath, parsed.prompt), label)
          return true
        },
      },
      {
        name: "history",
        description: "Mostra gli ultimi 5 messaggi della sessione",
        handler: async () => {
          printHistory(this.history, w)
          return true
        },
      },
      {
        name: "sessions",
        description: "Lista le sessioni salvate",
        handler: async () => {
          await printSessions(this.history, w)
          return true
        },
      },
      {
        name: "load",
        description: "Carica una sessione precedente: /load <session_id>",
        handler: async (args) => {
          await loadSession(args.trim(), this.history, (id) => this.agent.setSessionId(id), w)
          return true
        },
      },
      {
        name: "stats",
        description: "Mostra le statistiche della sessione corrente",
        handler: async () => {
          printStats(this.history, w)
          return true
        },
      },
      {
        name: "reset",
        description: "Resetta la sessione corrente",
        handler: async () => {
          this.agent.setSessionId(null)
          this.history.reset()
          w(`${DIM}[sessione resettata]${RESET}\n\n`)
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

  private write(text: string): void {
    process.stdout.write(text)
  }

  stop(): void {
    this.running = false
  }
}
