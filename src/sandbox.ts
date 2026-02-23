/**
 * Sandbox management for Claude agents.
 * Creates isolated temp directories with safety rules (CLAUDE.md)
 * that prevent Claude from modifying system files.
 */

import { mkdtempSync, lstatSync, readdirSync, rmSync, writeFileSync } from "fs"
import { join, relative, extname } from "path"
import { tmpdir } from "os"
import { logger } from "./logger"

/** Supported image MIME types for vision */
export const MIME_TYPES: Record<string, string> = {
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

/** Generate the CLAUDE.md safety rules text for a sandbox directory */
export function generateSandboxRules(sandboxDir: string, collaboration: boolean = true, chatId?: number): string {
  return [
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
    `- Create, read, write, delete files ONLY within this sandbox: \`${sandboxDir}\``,
    "- Run read-only commands: `ls`, `cat`, `head`, `tail`, `wc`, `df`, `uname`, `whoami`, `date`, `dir`",
    "- Network read operations: `curl`, `wget`, `fetch` (GET requests for data retrieval)",
    "- Language REPLs within sandbox: `python`, `node`, `bun` (operating on sandbox files only)",
    "",
    "## 4. CODE EXECUTION",
    "",
    "When the user asks you to write, run, or execute code:",
    "1. Write the code to a file in this sandbox",
    "2. Execute it using the appropriate runtime (`bun`, `node`, `python3`)",
    "3. Report the output (stdout/stderr) to the user",
    "",
    "You have full access to execute code within this sandbox. Do it proactively when it helps answer the question.",
    "",
    "## 5. FILE DELIVERY",
    "",
    "**IMPORTANT: Files are ONLY delivered to the user when placed in the `output/` directory.**",
    "",
    "- ONLY save files to `output/` when the user EXPLICITLY asks for a file (e.g. 'generate a PDF', 'create a file', 'send me the code')",
    "- Do NOT put files in `output/` unless the user requested them",
    "- Temporary/intermediate files (scripts, helpers) should stay in the sandbox root, NOT in `output/`",
    "- Example: if user says 'generate a PDF report', write the script in the root and the PDF in `output/report.pdf`",
    "",
    "### Projects — ALWAYS create ZIP package",
    "",
    "When the user asks to create a **project** (website, app, code, template, etc.):",
    "1. Create all project files in the sandbox root",
    "2. **ALWAYS** at the end, create a ZIP with all project files",
    "3. Save the ZIP to `output/project.zip` (or a descriptive name)",
    "4. The ZIP is automatically sent to the user on Telegram",
    "",
    "Example: `zip -r output/landing-page.zip index.html style.css script.js assets/`",
    "",
    "This is **mandatory** for every project — the user must always receive a downloadable package.",
    "",
    ...(collaboration
      ? [
          "## 6. TEAM DECOMPOSITION — AUTONOMOUS DECISION",
          "",
          "You are the orchestrator of a team of parallel agents.",
          "When a task is complex and would benefit from parallel execution, you may decompose it.",
          "",
          "**When to decompose:**",
          "- Comparing multiple items (frameworks, languages, tools, products)",
          "- Auditing or analyzing multiple things in parallel",
          "- Research across several independent topics",
          "- Creating multiple independent deliverables",
          "",
          "**When NOT to decompose:**",
          "- Simple questions, greetings, single-topic discussions",
          "- Tasks that depend on sequential steps",
          "- Short or trivial requests",
          "",
          "**How to decompose:**",
          "Respond ONLY with a JSON array of independent sub-tasks (minimum 2). No other text:",
          "```",
          '[{"task": "detailed description of sub-task 1"}, {"task": "detailed description of sub-task 2"}]',
          "```",
          "",
          "Each sub-task will be executed by a separate agent in parallel.",
          "",
          "**Sub-task quality rules:**",
          "- Each sub-task MUST be self-contained with enough context to produce a useful result independently",
          "- Decompose to the right granularity: sub-tasks should be atomic and actionable, not vague",
          '- BAD: `"Create the frontend"` — too vague, the worker won\'t know what to build',
          '- GOOD: `"Create a login page with email/password form, validation, and error handling using React"` — specific and actionable',
          "- Workers cannot decompose further, so your plan must be detailed enough in one shot",
          "",
          "**IMPORTANT: Only respond with a JSON array when you decide to decompose. Otherwise respond normally.**",
          "",
        ]
      : []),
    `## ${collaboration ? "7" : "6"}. SCHEDULING (bunqueue MCP tools)`,
    "",
    "You have access to bunqueue MCP tools for scheduling jobs. Use them when users ask",
    "to be reminded, schedule tasks, or set up recurring actions.",
    "",
    "**Queue name:** `neo-jobs`",
    "",
    "**Job data format (MUST include these fields):**",
    "```json",
    `{ "chatId": ${chatId ?? 0}, "prompt": "the task to execute", "scheduleType": "once|cron" }`,
    "```",
    "",
    "**Key tools:**",
    "- `bunqueue_add_job` — one-time job (use `delay` in ms for future execution)",
    "- `bunqueue_add_cron` — recurring job (standard cron expressions)",
    "- `bunqueue_list_crons` — list active cron schedules",
    "- `bunqueue_delete_cron` — remove a cron schedule",
    "",
    "**Examples:**",
    '- "remind me in 5 minutes" → `bunqueue_add_job` with queue `neo-jobs`, delay 300000',
    '- "every day at 9am" → `bunqueue_add_cron` with pattern `0 9 * * *`',
    "",
    `**IMPORTANT:** Always set chatId to \`${chatId ?? 0}\` in the job data so results are sent to the correct chat.`,
    "",
    `## ${collaboration ? "8" : "7"}. WHEN IN DOUBT`,
    "",
    "If a user asks you to perform a potentially dangerous operation:",
    "1. REFUSE the operation",
    "2. Explain what was requested and why it is dangerous",
    "3. Suggest a safe alternative if possible",
    "",
    "**Remember: you can always create and work on files in this sandbox freely.**",
    "**You MUST NEVER operate on files outside it.**",
  ].join("\n")
}

/** Create an isolated sandbox directory with safety rules. Returns the path. */
export function createSandbox(collaboration: boolean = true, chatId?: number): string {
  const sandboxDir = mkdtempSync(join(tmpdir(), "neo-agent-"))
  writeFileSync(join(sandboxDir, "CLAUDE.md"), generateSandboxRules(sandboxDir, collaboration, chatId))
  return sandboxDir
}

/** Remove the sandbox directory and all its contents. */
export function cleanupSandbox(sandboxDir: string): void {
  try {
    rmSync(sandboxDir, { recursive: true, force: true })
    logger.debug("Sandbox cleaned up", { dir: sandboxDir })
  } catch (err) {
    logger.warn("Failed to cleanup sandbox", { dir: sandboxDir, error: String(err) })
  }
}

/**
 * List all user-created files in the sandbox (excludes CLAUDE.md).
 * Returns relative paths with their modification times.
 */
/** Directories to skip when listing sandbox files (generated/dependency/build dirs) */
const IGNORED_DIRS = new Set([
  // JavaScript / Node / Bun
  "node_modules",
  ".bun",
  ".npm",
  ".next",
  ".nuxt",
  ".svelte-kit",
  // Python
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".eggs",
  "*.egg-info",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  // Rust
  "target",
  // Go
  "vendor",
  // Java / Kotlin
  ".gradle",
  ".m2",
  // General build/cache
  "dist",
  "build",
  ".cache",
  ".git",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  ".DS_Store",
  "coverage",
  ".turbo",
  ".parcel-cache",
])

/** File extensions to skip (lock files, binaries, etc.) */
const IGNORED_EXTENSIONS = new Set([
  ".lock",
  ".log",
  ".pyc",
  ".pyo",
  ".so",
  ".dylib",
  ".dll",
  ".o",
  ".a",
  ".class",
  ".jar",
  ".war",
  ".wasm",
  ".map",
])

export function listSandboxFiles(sandboxDir: string): Array<{ path: string; mtimeMs: number }> {
  const results: Array<{ path: string; mtimeMs: number }> = []
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir) as string[]
    } catch (err) {
      logger.debug("Failed to read sandbox directory", { dir, error: String(err) })
      return
    }
    for (const name of names) {
      const fullPath = join(dir, name)
      try {
        const stat = lstatSync(fullPath)
        if (stat.isSymbolicLink()) continue // never follow symlinks outside sandbox
        if (stat.isDirectory()) {
          if (IGNORED_DIRS.has(name)) continue
          walk(fullPath)
        } else if (stat.isFile()) {
          const rel = relative(sandboxDir, fullPath)
          if (rel === "CLAUDE.md") continue
          if (IGNORED_EXTENSIONS.has(extname(name).toLowerCase())) continue
          results.push({ path: rel, mtimeMs: stat.mtimeMs })
        }
      } catch {
        /* file may have been deleted between readdir and stat */
      }
    }
  }
  walk(sandboxDir)
  return results
}
