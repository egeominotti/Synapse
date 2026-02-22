/**
 * REPL slash command implementations — pure functions with injected dependencies.
 */

import { existsSync } from "fs"
import { resolve } from "path"
import type { SlashCommand } from "./types"
import type { HistoryManager } from "./history"
import { formatDuration } from "./utils"

const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"
const CYAN = "\x1b[1;36m"
const YELLOW = "\x1b[1;33m"
const GREEN = "\x1b[1;32m"
const RED = "\x1b[31m"
const DIM = "\x1b[90m"

type WriteFn = (text: string) => void

export function printBanner(write: WriteFn): void {
  write(`\n${CYAN}`)
  write("  ╔══════════════════════════════════════════════════╗\n")
  write("  ║       Claude Agent v2.0 (Enterprise)            ║\n")
  write("  ║                                                  ║\n")
  write("  ║  /help for commands   |  /image for photos      ║\n")
  write("  ╚══════════════════════════════════════════════════╝\n")
  write(`${RESET}\n`)
}

export function printHelp(commands: Map<string, SlashCommand>, write: WriteFn): void {
  write(`\n${BOLD}Available commands:${RESET}\n\n`)
  const sorted = [...commands.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const cmd of sorted) {
    write(`  ${CYAN}/${cmd.name.padEnd(12)}${RESET} ${cmd.description}\n`)
  }
  write(`\n${DIM}Tip: end a line with \\ for multiline input.${RESET}\n\n`)
}

export function printHistory(history: HistoryManager, write: WriteFn): void {
  const messages = history.getRecentMessages(5)
  if (messages.length === 0) {
    write(`${DIM}No messages in this session.${RESET}\n\n`)
    return
  }
  write(`\n${BOLD}Last ${messages.length} messages:${RESET}\n\n`)
  for (const msg of messages) {
    const ts = new Date(msg.timestamp).toLocaleTimeString("en-US")
    const q = msg.prompt.length > 60 ? msg.prompt.slice(0, 57) + "..." : msg.prompt
    const a = msg.response.length > 80 ? msg.response.slice(0, 77) + "..." : msg.response
    write(`  ${DIM}${ts}${RESET} ${YELLOW}You:${RESET} ${q}\n`)
    write(`         ${GREEN}Claude:${RESET} ${a}\n`)
    write(`         ${DIM}(${msg.durationMs}ms)${RESET}\n\n`)
  }
}

export async function printSessions(history: HistoryManager, write: WriteFn): Promise<void> {
  const sessions = await history.listSessions()
  if (sessions.length === 0) {
    write(`${DIM}No saved sessions.${RESET}\n\n`)
    return
  }
  write(`\n${BOLD}Saved sessions (${sessions.length}):${RESET}\n\n`)
  const n = Math.min(sessions.length, 15)
  for (let i = 0; i < n; i++) {
    const s = sessions[i]
    const date = new Date(s.createdAt).toLocaleString("en-US")
    write(`  ${CYAN}${s.sessionId.slice(0, 12)}...${RESET}  ${date}  ${DIM}(${s.messageCount} msg)${RESET}\n`)
  }
  if (sessions.length > n) write(`\n  ${DIM}... and ${sessions.length - n} more sessions${RESET}\n`)
  write(`\n${DIM}Use /load <session_id> to load a session.${RESET}\n\n`)
}

export async function loadSession(
  sessionId: string,
  history: HistoryManager,
  setAgentSessionId: (id: string) => void,
  write: WriteFn
): Promise<void> {
  if (!sessionId) {
    write(`${RED}Usage: /load <session_id>${RESET}\n\n`)
    return
  }
  const session = await history.loadSession(sessionId)
  if (!session) {
    write(`${RED}Session not found: ${sessionId}${RESET}\n\n`)
    return
  }
  setAgentSessionId(session.sessionId)
  write(
    `${GREEN}Session loaded: ${session.sessionId.slice(0, 12)}... (${session.messages.length} messages)${RESET}\n\n`
  )
}

export function printStats(history: HistoryManager, write: WriteFn): void {
  const stats = history.getStats()
  if (!stats || stats.totalMessages === 0) {
    write(`${DIM}No statistics available.${RESET}\n\n`)
    return
  }
  const avg = Math.round(stats.totalDurationMs / stats.totalMessages)
  const tot = stats.totalInputTokens + stats.totalOutputTokens
  write(`\n${BOLD}Session statistics:${RESET}\n\n`)
  write(`  Total messages:      ${CYAN}${stats.totalMessages}${RESET}\n`)
  write(`  Total duration:      ${CYAN}${formatDuration(stats.totalDurationMs)}${RESET}\n`)
  write(`  Average duration:    ${CYAN}${formatDuration(avg)}${RESET}\n`)
  if (tot > 0) {
    write(`  Total input tokens:  ${CYAN}${stats.totalInputTokens.toLocaleString("en-US")}${RESET}\n`)
    write(`  Total output tokens: ${CYAN}${stats.totalOutputTokens.toLocaleString("en-US")}${RESET}\n`)
    write(`  Total tokens:        ${CYAN}${tot.toLocaleString("en-US")}${RESET}\n`)
  } else {
    write(`  Tokens:              ${DIM}unavailable${RESET}\n`)
  }
  write("\n")
}

export function parseImageArgs(args: string): { imagePath: string; prompt: string } | null {
  if (!args) return null
  const spaceIdx = args.indexOf(" ")
  const rawPath = spaceIdx === -1 ? args : args.slice(0, spaceIdx)
  const prompt = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim()
  const imagePath = resolve(rawPath)
  if (!existsSync(imagePath)) return null
  return { imagePath, prompt }
}

export function writeMeta(
  sessionId: string | null,
  durationMs: number,
  tokenUsage: { inputTokens: number; outputTokens: number } | null,
  write: WriteFn
): void {
  const meta: string[] = []
  if (sessionId) meta.push(`session: ${sessionId.slice(0, 8)}...`)
  meta.push(`${durationMs}ms`)
  if (tokenUsage) meta.push(`tokens: ${tokenUsage.inputTokens}in/${tokenUsage.outputTokens}out`)
  write(`${DIM}[${meta.join(" | ")}]${RESET}\n\n`)
}

export { RED, DIM, RESET, GREEN }
