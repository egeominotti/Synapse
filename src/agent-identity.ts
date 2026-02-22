/**
 * Agent identity generator — Matrix-themed names, codes, and colors.
 * Used to visually distinguish the orchestrator from scheduled job agents.
 */

export interface AgentIdentity {
  name: string
  code: string
  emoji: string
}

const MATRIX_NAMES = [
  "Morpheus",
  "Trinity",
  "Tank",
  "Dozer",
  "Switch",
  "Apoc",
  "Mouse",
  "Niobe",
  "Ghost",
  "Seraph",
  "Link",
  "Zee",
  "Sati",
  "Rama",
  "Sparks",
  "Lock",
  "Ajax",
  "Vector",
  "Cipher",
  "Mifune",
]

const COLOR_EMOJIS = ["🔴", "🟢", "🔵", "🟡", "🟣", "🟠"]

const ALPHA_NUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function randomAlphaNum(len: number): string {
  let result = ""
  for (let i = 0; i < len; i++) {
    result += ALPHA_NUM[Math.floor(Math.random() * ALPHA_NUM.length)]
  }
  return result
}

/**
 * Generate a deterministic identity from a job ID.
 * Same jobId always produces the same name and color.
 * Code includes random suffix for uniqueness.
 */
export function generateIdentity(jobId: number): AgentIdentity {
  const name = MATRIX_NAMES[jobId % MATRIX_NAMES.length]
  const emoji = COLOR_EMOJIS[jobId % COLOR_EMOJIS.length]
  const prefix = name.slice(0, 3).toUpperCase()
  const code = `${prefix}-${randomAlphaNum(2)}`
  return { name, code, emoji }
}

/** The orchestrator's fixed identity. */
export const ORCHESTRATOR_IDENTITY: AgentIdentity = {
  name: "Neo",
  code: "NEO-01",
  emoji: "🤖",
}

/** Format identity as a header line for Telegram messages. */
export function formatIdentityHeader(identity: AgentIdentity, extra?: string): string {
  const parts = [identity.emoji, identity.name, identity.code]
  if (extra) parts.push(extra)
  return parts.join(" · ")
}

/**
 * Generate the full team roster for a given pool size.
 * Index 0 = ORCHESTRATOR, 1..N = workers with deterministic names.
 */
export function generateTeamIdentities(poolSize: number): AgentIdentity[] {
  const team: AgentIdentity[] = [ORCHESTRATOR_IDENTITY]
  for (let i = 1; i < poolSize; i++) {
    team.push(generateIdentity(i))
  }
  return team
}
