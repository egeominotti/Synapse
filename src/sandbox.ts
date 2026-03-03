/**
 * Sandbox management for Claude agents.
 * Creates isolated temp directories with safety rules (CLAUDE.md)
 * that prevent Claude from modifying system files.
 */

import { mkdtempSync, lstatSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs"
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

/** Build agent env: inherit Bun.env, strip CLAUDECODE, inject token.
 *  Cached per token — avoids rebuilding the env object on every call. */
let _cachedEnv: Record<string, string> | null = null
let _cachedToken: string | null = null

export function buildAgentEnv(token: string): Record<string, string> {
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
          "## 6b. SUBAGENTS (Task tool)",
          "",
          "You have specialized subagents available via the **Task** tool:",
          "- **researcher** — research, analysis, information gathering (fast, read-only)",
          "- **code-writer** — code implementation, bug fixes, file creation (full tools)",
          "- **reviewer** — code review, quality assessment (read-only)",
          "",
          "Use subagents for focused **sequential** work within your conversation.",
          "Use team decomposition (JSON array) for **parallel** independent tasks.",
          "",
          "Subagents run one at a time — for parallel execution, prefer team decomposition.",
          "",
        ]
      : []),
    `## ${collaboration ? "7" : "6"}. SCHEDULING & QUEUE MANAGEMENT (bunqueue MCP tools)`,
    "",
    "You have access to the full bunqueue MCP toolset for job scheduling, queue management,",
    "monitoring, and workflow orchestration. Use them when users ask to be reminded, schedule",
    "tasks, manage queues, or set up recurring actions.",
    "",
    "**Queue name:** `synapse-jobs`",
    "",
    "**Job data format (MUST include these fields):**",
    "```json",
    `{ "chatId": ${chatId ?? 0}, "prompt": "the task to execute", "scheduleType": "once|cron" }`,
    "```",
    "",
    "### Job Operations",
    "- `bunqueue_add_job` — add a job (use `delay` in ms for future execution)",
    "- `bunqueue_add_jobs_bulk` — add multiple jobs in one call",
    "- `bunqueue_get_job` — get job details by ID",
    "- `bunqueue_get_job_state` — get current state (waiting/delayed/active/completed/failed)",
    "- `bunqueue_get_job_result` — get result of a completed job",
    "- `bunqueue_cancel_job` — cancel a waiting or delayed job",
    "- `bunqueue_promote_job` — promote a delayed job to waiting",
    "- `bunqueue_update_progress` — update job progress (0-100)",
    "- `bunqueue_get_job_by_custom_id` — look up a job by custom ID",
    "- `bunqueue_wait_for_job` — wait for a job to complete",
    "",
    "### Job Management",
    "- `bunqueue_update_job_data` — update job payload data",
    "- `bunqueue_change_job_priority` — change job priority",
    "- `bunqueue_move_to_delayed` — move job to delayed state",
    "- `bunqueue_discard_job` — permanently discard a job",
    "- `bunqueue_get_progress` — get progress value and message",
    "- `bunqueue_change_delay` — change delay of a delayed job",
    "",
    "### Cron Jobs",
    "- `bunqueue_add_cron` — add recurring job (cron pattern or interval)",
    "- `bunqueue_list_crons` — list all scheduled crons",
    "- `bunqueue_get_cron` — get cron details by name",
    "- `bunqueue_delete_cron` — delete a cron job",
    "",
    "### Queue Control",
    "- `bunqueue_list_queues` — list all queues",
    "- `bunqueue_count_jobs` — count total jobs in a queue",
    "- `bunqueue_get_jobs` — list jobs with state filter and pagination",
    "- `bunqueue_get_job_counts` — job counts per state",
    "- `bunqueue_pause_queue` — pause job processing",
    "- `bunqueue_resume_queue` — resume processing",
    "- `bunqueue_drain_queue` — remove all waiting jobs",
    "- `bunqueue_obliterate_queue` — remove ALL data from a queue",
    "- `bunqueue_clean_queue` — remove old jobs by grace period",
    "- `bunqueue_is_paused` — check if a queue is paused",
    "- `bunqueue_get_counts_per_priority` — job counts by priority level",
    "",
    "### Dead Letter Queue",
    "- `bunqueue_get_dlq` — get failed jobs from DLQ",
    "- `bunqueue_retry_dlq` — retry jobs from DLQ",
    "- `bunqueue_purge_dlq` — clear all DLQ entries",
    "- `bunqueue_retry_completed` — reprocess completed jobs",
    "",
    "### Job Consumption",
    "- `bunqueue_pull_job` — pull a job from a queue for processing",
    "- `bunqueue_pull_job_batch` — pull multiple jobs at once",
    "- `bunqueue_ack_job` — acknowledge job completion with result",
    "- `bunqueue_ack_job_batch` — batch acknowledge multiple jobs",
    "- `bunqueue_fail_job` — mark a job as failed",
    "- `bunqueue_job_heartbeat` — send heartbeat for an active job",
    "- `bunqueue_job_heartbeat_batch` — batch heartbeat for multiple jobs",
    "- `bunqueue_extend_lock` — extend lock on an active job",
    "",
    "### Rate Limiting & Concurrency",
    "- `bunqueue_set_rate_limit` — set max jobs per second",
    "- `bunqueue_clear_rate_limit` — remove rate limit",
    "- `bunqueue_set_concurrency` — set max concurrent jobs",
    "- `bunqueue_clear_concurrency` — remove concurrency limit",
    "",
    "### Webhooks",
    "- `bunqueue_add_webhook` — add webhook for job events",
    "- `bunqueue_remove_webhook` — remove a webhook",
    "- `bunqueue_list_webhooks` — list all webhooks",
    "- `bunqueue_set_webhook_enabled` — enable/disable a webhook",
    "",
    "### Workers",
    "- `bunqueue_register_worker` — register a new worker",
    "- `bunqueue_unregister_worker` — remove a worker",
    "- `bunqueue_worker_heartbeat` — send worker heartbeat",
    "",
    "### Monitoring & Stats",
    "- `bunqueue_get_stats` — global server statistics",
    "- `bunqueue_get_queue_stats` — per-queue statistics",
    "- `bunqueue_list_workers` — list active workers",
    "- `bunqueue_get_job_logs` — get job log entries",
    "- `bunqueue_add_job_log` — add log entry to a job",
    "- `bunqueue_get_storage_status` — disk health status",
    "- `bunqueue_get_per_queue_stats` — detailed per-queue breakdown",
    "- `bunqueue_get_memory_stats` — memory usage stats",
    "- `bunqueue_get_prometheus_metrics` — Prometheus exposition format",
    "- `bunqueue_clear_job_logs` — clear logs for a job",
    "- `bunqueue_compact_memory` — force memory compaction",
    "",
    "### Job Workflows (FlowProducer)",
    "- `bunqueue_add_flow` — create a flow tree (children before parent)",
    "- `bunqueue_add_flow_chain` — create a sequential pipeline (A → B → C)",
    "- `bunqueue_add_flow_bulk_then` — fan-out/fan-in operations",
    "- `bunqueue_get_flow` — retrieve a flow tree with dependency graph",
    "- `bunqueue_get_children_values` — get child job results",
    "",
    "### MCP Resources (read via resource URI)",
    "- `bunqueue://stats` — global server statistics",
    "- `bunqueue://queues` — all queues with job counts",
    "- `bunqueue://crons` — scheduled cron jobs",
    "- `bunqueue://workers` — active workers",
    "- `bunqueue://webhooks` — registered webhooks",
    "",
    "### MCP Prompts",
    "- `bunqueue_health_report` — comprehensive health assessment with severity indicators",
    "- `bunqueue_debug_queue` — granular diagnostics for a specific queue (pass `queue` param)",
    "- `bunqueue_incident_response` — troubleshooting for 'jobs not processing' scenarios",
    "",
    "### Examples",
    '- "remind me in 5 minutes" → `bunqueue_add_job` with queue `synapse-jobs`, delay 300000',
    '- "every day at 9am" → `bunqueue_add_cron` with pattern `0 9 * * *`',
    '- "cancel job #5" → `bunqueue_cancel_job`',
    '- "show queue stats" → `bunqueue_get_queue_stats`',
    '- "pause all jobs" → `bunqueue_pause_queue`',
    '- "list failed jobs" → `bunqueue_get_dlq`',
    '- "health check" → use `bunqueue_health_report` prompt',
    '- "debug synapse-jobs queue" → use `bunqueue_debug_queue` prompt',
    "",
    `**IMPORTANT:** Always set chatId to \`${chatId ?? 0}\` in the job data so results are sent to the correct chat.`,
    "",
    `## ${collaboration ? "8" : "7"}. PERSISTENT MEMORY`,
    "",
    "The file `.memory.md` in this sandbox is your persistent memory for this chat.",
    "It survives session resets and is shared across all agents in this chat.",
    "",
    "**Reading:** Check `.memory.md` at the start to understand prior context.",
    "**Writing:** Update `.memory.md` when you learn important facts about the user or project:",
    "- User preferences, name, language, timezone",
    "- Project details, tech stack, architecture decisions",
    "- Recurring topics or ongoing tasks",
    "- Key decisions made in previous conversations",
    "",
    "**Rules:**",
    "- Do NOT rewrite it every turn — only update when there's genuinely new info to remember",
    "- Keep it concise and organized (max ~4000 chars)",
    "- Use markdown headers to organize sections",
    "- Remove outdated information when updating",
    "",
    `## ${collaboration ? "9" : "8"}. WHEN IN DOUBT`,
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

/** Max characters for persistent memory file */
export const MAX_MEMORY_FILE_CHARS = 4000

/** Write the .memory.md file into the sandbox. */
export function writeMemoryFile(sandboxDir: string, memory: string): void {
  writeFileSync(join(sandboxDir, ".memory.md"), memory)
}

/** Read the .memory.md file from the sandbox. Returns null if not present or empty. */
export function readMemoryFile(sandboxDir: string): string | null {
  const path = join(sandboxDir, ".memory.md")
  if (!existsSync(path)) return null
  const content = readFileSync(path, "utf-8").trim()
  return content || null
}

/** Cached base rules (without sandboxDir substitution) — regenerated only when chatId/collab changes */
let _rulesCache: { key: string; rules: string } | null = null

/** Create an isolated sandbox directory with safety rules. Returns the path. */
export function createSandbox(collaboration: boolean = true, chatId?: number): string {
  const sandboxDir = mkdtempSync(join(tmpdir(), "synapse-agent-"))

  // Cache the CLAUDE.md content — only regenerate when chatId or collaboration changes
  const cacheKey = `${collaboration}:${chatId ?? 0}`
  if (!_rulesCache || _rulesCache.key !== cacheKey) {
    _rulesCache = { key: cacheKey, rules: generateSandboxRules(sandboxDir, collaboration, chatId) }
  }

  writeFileSync(join(sandboxDir, "CLAUDE.md"), _rulesCache.rules)
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
          if (rel === "CLAUDE.md" || rel === ".memory.md") continue
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
