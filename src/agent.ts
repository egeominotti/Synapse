/**
 * Claude Code agent.
 * Manages spawning the `claude` CLI process with retry logic,
 * timeout handling, and structured result parsing.
 * Supports both text prompts and vision (image + text) via stream-json input.
 */

import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "fs"
import { extname, join, relative } from "path"
import { tmpdir } from "os"
import type { AgentConfig, AgentCallResult, ClaudeResponse, TokenUsage } from "./types"
import { logger } from "./logger"

/** Errors that are considered transient and safe to retry */
const TRANSIENT_PATTERNS = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "socket hang up",
  "network",
  "rate limit",
  "429",
  "503",
  "502",
]

/** Distinct error class for hard timeouts — never retried */
export class TimeoutError extends Error {
  readonly isTimeout = true
  constructor(ms: number) {
    super(`Timeout: Claude did not respond within ${ms}ms`)
    this.name = "TimeoutError"
  }
}

export function isTransientError(err: Error): boolean {
  if (err instanceof TimeoutError) return false // never retry timeouts
  const lower = err.message.toLowerCase()
  return TRANSIENT_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
}

/** Supported image MIME types for vision */
const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

/** Build spawn env: inherit Bun.env, strip CLAUDECODE, inject token.
 *  Cached per token — avoids rebuilding the env object on every spawn call. */
let _cachedEnv: Record<string, string> | null = null
let _cachedToken: string | null = null

export function buildSpawnEnv(token: string): Record<string, string> {
  if (_cachedEnv && _cachedToken === token) return _cachedEnv
  const { CLAUDECODE: _stripped, ...rest } = Bun.env
  _cachedEnv = Object.fromEntries(
    Object.entries({ ...rest, CLAUDE_CODE_OAUTH_TOKEN: token }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
  _cachedToken = token
  return _cachedEnv
}

export class Agent {
  private readonly config: AgentConfig
  private sessionId: string | null = null
  /** Isolated sandbox directory — Claude runs here, not in the project root */
  readonly sandboxDir: string

  constructor(config: AgentConfig) {
    this.config = config
    this.sandboxDir = mkdtempSync(join(tmpdir(), "neo-agent-"))
    this.writeSandboxRules()
  }

  /** Write CLAUDE.md rules in the sandbox to constrain Claude's behavior */
  private writeSandboxRules(): void {
    const rules = [
      "# CLAUDE.md",
      "",
      "## Safety Rules — MANDATORY",
      "",
      "You are running in an isolated sandbox. These rules are NON-NEGOTIABLE.",
      "Violations can cause irreversible damage to the host system.",
      "",
      "## 1. FILESYSTEM — FORBIDDEN PATHS",
      "",
      "**NEVER read, write, delete, or modify files outside this sandbox.**",
      "",
      "**Linux protected paths:**",
      "- `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/boot`, `/opt`, `/var`, `/root`, `/proc`, `/sys`, `/dev`",
      "",
      "**macOS protected paths:**",
      "- `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/sbin`, `/etc`, `/var`, `/private`, `/cores`",
      "",
      "**Windows protected paths:**",
      "- `C:\\Windows`, `C:\\Program Files`, `C:\\Program Files (x86)`, `C:\\ProgramData`",
      "- `C:\\Users\\<user>\\AppData`, `C:\\Recovery`, `C:\\$Recycle.Bin`",
      "",
      "**User home protected paths (all platforms):**",
      "- `~`, `$HOME`, `%USERPROFILE%` — never delete or recursively modify",
      "- `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.config`, `~/.local`",
      "- `~/.bashrc`, `~/.zshrc`, `~/.profile`, `~/.bash_profile`",
      "- Any `.env`, `.env.*`, `credentials`, `secrets`, `token` files",
      "",
      "## 2. DESTRUCTIVE COMMANDS — FORBIDDEN",
      "",
      "**Never execute these commands or any variation:**",
      "",
      "File destruction:",
      "- `rm -rf /`, `rm -rf ~`, `rm -rf $HOME`, `rm -rf /*`",
      "- `del /s /q C:\\`, `rd /s /q C:\\`",
      "- Any recursive delete (`rm -rf`, `rd /s`) targeting paths outside this sandbox",
      "",
      "Disk/partition:",
      "- `mkfs`, `fdisk`, `dd` (on block devices), `format`, `diskpart`, `parted`",
      "",
      "System control:",
      "- `shutdown`, `reboot`, `halt`, `poweroff`, `init 0`, `init 6`",
      "- `shutdown /s`, `shutdown /r` (Windows)",
      "",
      "Process killing:",
      "- `kill -9 1`, `killall` (system processes), `pkill` (system processes)",
      "- `taskkill /f` on: svchost, csrss, winlogon, lsass, wininit, smss",
      "",
      "Privilege escalation:",
      "- `sudo`, `su`, `doas`, `runas`, `pkexec`",
      "- `chmod 777`, `chmod +s`, `chown root` on any system files",
      "",
      "Registry/config:",
      "- `reg delete`, `regedit` (Windows registry)",
      "- `defaults write` on system domains (macOS)",
      "",
      "Service management:",
      "- `systemctl stop/disable`, `launchctl unload`, `sc stop` on system services",
      "- `crontab -r` (delete all cron jobs)",
      "",
      "Network/firewall:",
      "- `iptables -F`, `ufw disable`, `pfctl -d` (flush/disable firewalls)",
      "- `route del`, `ip route flush` (delete network routes)",
      "",
      "Container/VM (if accessible):",
      "- `docker rm -f`, `docker system prune -af`, `docker rmi -f`",
      "- `docker run --privileged`, `docker run -v /:/host`",
      "",
      "Remote code execution:",
      "- `curl | sh`, `curl | bash`, `wget -O- | sh` (piped execution)",
      "- `eval` on untrusted remote content",
      "",
      "Package managers (global installs):",
      "- `npm install -g`, `pip install` (system-wide), `gem install` (system)",
      "- `apt remove`, `brew uninstall`, `pacman -R` (system packages)",
      "",
      "Symlink attacks:",
      "- Do NOT create symlinks pointing outside this sandbox directory",
      "",
      "## 3. ALLOWED OPERATIONS",
      "",
      "- Create, read, write, delete files ONLY within this sandbox: `" + this.sandboxDir + "`",
      "- Run read-only commands: `ls`, `cat`, `head`, `tail`, `wc`, `df`, `uname`, `whoami`, `date`, `dir`",
      "- Network read operations: `curl`, `wget`, `fetch` (GET requests for data retrieval)",
      "- Language REPLs within sandbox: `python`, `node`, `bun` (operating on sandbox files only)",
      "",
      "## 4. WHEN IN DOUBT",
      "",
      "If a user asks you to perform a potentially dangerous operation:",
      "1. REFUSE the operation",
      "2. Explain what was requested and why it is dangerous",
      "3. Suggest a safe alternative if possible",
      "",
      "**Remember: you can always create and work on files in this sandbox freely.**",
      "**You MUST NEVER operate on files outside it.**",
    ].join("\n")

    writeFileSync(join(this.sandboxDir, "CLAUDE.md"), rules)
  }

  /**
   * List all user-created files in the sandbox (excludes CLAUDE.md).
   * Returns relative paths with their modification times.
   */
  listSandboxFiles(): Array<{ path: string; mtimeMs: number }> {
    const results: Array<{ path: string; mtimeMs: number }> = []
    const walk = (dir: string): void => {
      let names: string[]
      try {
        names = readdirSync(dir) as string[]
      } catch {
        return
      }
      for (const name of names) {
        const fullPath = join(dir, name)
        try {
          const stat = statSync(fullPath)
          if (stat.isDirectory()) {
            walk(fullPath)
          } else if (stat.isFile()) {
            const rel = relative(this.sandboxDir, fullPath)
            if (rel === "CLAUDE.md") continue
            results.push({ path: rel, mtimeMs: stat.mtimeMs })
          }
        } catch {
          /* file may have been deleted between readdir and stat */
        }
      }
    }
    walk(this.sandboxDir)
    return results
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  setSessionId(id: string | null): void {
    this.sessionId = id
    logger.setSessionId(id)
  }

  /** Send a text prompt with retry + timeout. */
  async call(prompt: string): Promise<AgentCallResult> {
    return this.callWithRetry(() => this.spawnText(prompt))
  }

  /**
   * Send an image + optional text prompt.
   * Uses --input-format stream-json to send a vision content block via stdin.
   */
  async callWithImage(imagePath: string, prompt: string): Promise<AgentCallResult> {
    if (!existsSync(imagePath)) throw new Error(`File non trovato: ${imagePath}`)
    const ext = extname(imagePath).toLowerCase()
    const mediaType = MIME_TYPES[ext]
    if (!mediaType) throw new Error(`Formato non supportato: ${ext}. Usa: ${Object.keys(MIME_TYPES).join(", ")}`)

    return this.callWithRetry(() => this.spawnWithImage(imagePath, mediaType, prompt))
  }

  /** Send raw base64 image data (e.g. downloaded from Telegram CDN). */
  async callWithRawImage(mediaType: string, base64Data: string, prompt: string): Promise<AgentCallResult> {
    return this.callWithRetry(() =>
      this.config.useDocker
        ? this.spawnViaDocker({ prompt, vision: { mediaType, data: base64Data } })
        : this.spawnWithRawImage(mediaType, base64Data, prompt)
    )
  }

  private async callWithRetry(fn: () => Promise<AgentCallResult>): Promise<AgentCallResult> {
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        lastError = error

        if (attempt < this.config.maxRetries && isTransientError(error)) {
          const delayMs = this.config.initialRetryDelayMs * Math.pow(2, attempt - 1)
          logger.warn(`Transient error on attempt ${attempt}/${this.config.maxRetries}, retrying in ${delayMs}ms`, {
            error: error.message,
          })
          await Bun.sleep(delayMs)
          continue
        }
        break
      }
    }

    throw lastError ?? new Error("Unknown error during agent call")
  }

  /** Spawn claude CLI for a plain text prompt (direct or Docker). */
  private async spawnText(prompt: string): Promise<AgentCallResult> {
    logger.debug("Spawning claude (text)", {
      mode: this.config.useDocker ? "docker" : "direct",
      hasSession: !!this.sessionId,
      promptLength: prompt.length,
    })

    if (this.config.useDocker) {
      return this.spawnViaDocker({ prompt, vision: null })
    }

    const proc = Bun.spawn(this.buildArgs(prompt), {
      cwd: this.sandboxDir,
      env: buildSpawnEnv(this.config.token),
      stdout: "pipe",
      stderr: "pipe",
    })
    return this.raceWithTimeout(proc)
  }

  /** Spawn claude CLI with vision input (direct or Docker). */
  private async spawnWithImage(imagePath: string, mediaType: string, prompt: string): Promise<AgentCallResult> {
    const imageData = Buffer.from(await Bun.file(imagePath).arrayBuffer()).toString("base64")
    return this.spawnWithRawImage(mediaType, imageData, prompt)
  }

  /** Core vision spawn — accepts pre-computed base64 data. */
  private async spawnWithRawImage(mediaType: string, imageData: string, prompt: string): Promise<AgentCallResult> {
    logger.debug("Spawning claude (vision)", {
      mode: this.config.useDocker ? "docker" : "direct",
      hasSession: !!this.sessionId,
      mediaType,
    })

    if (this.config.useDocker) {
      return this.spawnViaDocker({ prompt, vision: { mediaType, data: imageData } })
    }

    const args = this.buildArgs(null, "stream-json")
    args.push("--input-format", "stream-json")

    const proc = Bun.spawn(args, {
      cwd: this.sandboxDir,
      env: buildSpawnEnv(this.config.token),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    const message = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageData } },
          { type: "text", text: prompt || "Cosa vedi in questa immagine?" },
        ],
      },
    }
    proc.stdin.write(JSON.stringify(message) + "\n")
    proc.stdin.end()

    return this.raceWithTimeout(proc)
  }

  /**
   * Spawn claude inside an isolated Docker container.
   * Token is passed via stdin as JSON — never appears in process args or env.
   * No filesystem mounts: image data is passed inline as base64.
   */
  private async spawnViaDocker(payload: {
    prompt: string
    vision: { mediaType: string; data: string } | null
  }): Promise<AgentCallResult> {
    const dockerArgs = [
      "docker",
      "run",
      "--rm", // auto-remove container after exit
      "--interactive", // keep stdin open
      "--network=host", // needed for claude CLI to reach Anthropic API
      "--memory=512m", // cap memory per container
      "--cpus=1", // cap CPU per container
      this.config.dockerImage,
    ]

    const proc = Bun.spawn(dockerArgs, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Do NOT pass env with token here — token goes via stdin payload
    })

    // Send the payload; token never touches docker args or env
    const stdinPayload = JSON.stringify({
      token: this.config.token,
      prompt: payload.prompt,
      sessionId: this.sessionId,
      vision: payload.vision,
    })
    proc.stdin.write(stdinPayload)
    proc.stdin.end()

    return this.raceWithTimeout(proc)
  }

  /**
   * Race a spawned process against the configured timeout.
   * Kills the process if the timeout fires (no orphans).
   * Reads stdout and stderr CONCURRENTLY to prevent pipe deadlock.
   */
  private async raceWithTimeout(proc: ReturnType<typeof Bun.spawn>): Promise<AgentCallResult> {
    const startTime = performance.now()

    // Drain both pipes concurrently — if stderr fills (>512KB on macOS) while
    // we sequentially wait for stdout, the child blocks and deadlocks.
    // Cast required because Bun's generic spawn return type is a union that
    // includes `number` for non-piped streams; we always set stdout/stderr:"pipe".
    const readText = (s: unknown): Promise<string> => new Response(s as ReadableStream<Uint8Array>).text()
    const readPromise = Promise.all([readText(proc.stdout), readText(proc.stderr)])

    let timedOut = false
    const timeoutHandle = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, this.config.timeoutMs)

    let rawStdout: string
    let stderrText: string
    try {
      ;[rawStdout, stderrText] = await readPromise
    } finally {
      clearTimeout(timeoutHandle)
    }

    if (timedOut) throw new TimeoutError(this.config.timeoutMs)

    const exitCode = await proc.exited
    const durationMs = Math.round(performance.now() - startTime)

    if (exitCode !== 0) {
      const errorMsg = stderrText.trim() || `claude exited with code ${exitCode}`
      logger.error("Claude process failed", { exitCode, error: errorMsg })
      throw new Error(errorMsg)
    }

    return { ...this.parseResponse(rawStdout), durationMs }
  }

  buildArgs(inlinePrompt: string | null, outputFormat: "json" | "stream-json" = "json"): string[] {
    const args = ["claude", "--print", "--output-format", outputFormat]
    if (outputFormat === "stream-json") args.push("--verbose")
    if (this.config.skipPermissions) args.push("--dangerously-skip-permissions")
    if (this.sessionId) {
      args.push("--resume", this.sessionId)
    } else if (this.config.systemPrompt) {
      // Only inject system prompt on new sessions — resumed sessions already have it baked in
      args.push("--system-prompt", this.config.systemPrompt)
    }
    if (inlinePrompt !== null) args.push(inlinePrompt)
    return args
  }

  parseResponse(rawStdout: string): Omit<AgentCallResult, "durationMs"> {
    const trimmed = rawStdout.trim()
    const lines = trimmed.split("\n").filter((l) => l.trim())

    // stream-json output: multiple newline-delimited JSON events — find the "result" event
    if (lines.length > 1) {
      for (const line of lines) {
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        if (obj.type !== "result") continue

        const parsed = obj as unknown as ClaudeResponse & { type: string }
        if (parsed.session_id) this.setSessionId(parsed.session_id)
        const tokenUsage: TokenUsage | null = parsed.usage
          ? { inputTokens: parsed.usage.input_tokens ?? 0, outputTokens: parsed.usage.output_tokens ?? 0 }
          : null
        const text = parsed.result ?? trimmed
        logger.debug("Claude response received (stream-json)", {
          resultLength: text.length,
          hasTokenUsage: !!tokenUsage,
        })
        return { text, sessionId: this.sessionId, tokenUsage }
      }
      logger.warn("stream-json: no result event found, returning raw stdout")
      return { text: trimmed, sessionId: this.sessionId, tokenUsage: null }
    }

    // Standard json output: single JSON object
    let parsed: ClaudeResponse
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      logger.warn("Failed to parse Claude JSON response, returning raw text")
      return { text: trimmed, sessionId: this.sessionId, tokenUsage: null }
    }

    if (parsed.session_id) this.setSessionId(parsed.session_id)

    let tokenUsage: TokenUsage | null = null
    if (parsed.usage) {
      tokenUsage = {
        inputTokens: parsed.usage.input_tokens ?? 0,
        outputTokens: parsed.usage.output_tokens ?? 0,
      }
    }

    const text = parsed.result ?? trimmed
    logger.debug("Claude response received", { resultLength: text.length, hasTokenUsage: !!tokenUsage })
    return { text, sessionId: this.sessionId, tokenUsage }
  }
}
