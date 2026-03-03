# CLAUDE.md

"When I report a bug, don't start by trying to fix it. Instead, start by writing a test that reproduces the bug. Then, have subagents try to fix the bug and prove it with a passing test."

## Project Overview

Synapse is a Claude AI agent platform with REPL and Telegram bot interfaces. Uses the `@anthropic-ai/claude-agent-sdk` `query()` API for all Claude interactions. Written in TypeScript, runs on Bun. Persistence via SQLite (bun:sqlite). Runtime configuration via Telegram admin commands.

## Tech Stack

- **Runtime**: Bun (no build step, JIT TypeScript)
- **Language**: TypeScript (strict mode, ESNext target)
- **Database**: SQLite via `bun:sqlite` (WAL mode)
- **Telegram**: grammy v1.40+
- **Logging**: pino + pino-pretty (structured, stderr only)
- **Scheduler**: bunqueue (MCP-based job scheduling for all agents)
- **Voice**: Groq API (primary) + whisper-cli local (fallback), whisper-large-v3-turbo
- **Task Queue**: bunqueue (auto-team subtask distribution via Queue/Worker)
- **SDK Hooks**: PreToolUse security, PostToolUse progress, Notification forwarding
- **SDK Subagents**: researcher (haiku), code-writer (sonnet), reviewer (haiku) via Task tool
- **Testing**: bun:test (387 tests, 25 files)
- **Linting**: ESLint (typescript-eslint) + Prettier
- **CI/CD**: GitHub Actions + Husky pre-commit hooks
- **Claude Integration**: `@anthropic-ai/claude-agent-sdk` `query()` API (structured messages, inline MCP, AbortController)

## Architecture

```
index.ts / run.ts                  Entry points (REPL / Telegram bot)
        │
        ▼
    AgentPool (src/agent-pool.ts)    Master + worker agents per chat
        │
    Agent (src/agent.ts)             SDK query() API, retry + timeout
        │
   ┌────┴────┐
   ▼         ▼
History   SessionStore               Persistence layer
   │         │
   ▼         ▼
Database (src/db.ts)                 SQLite — sessions, messages, attachments,
        ▲                            telegram_sessions, runtime_config, scheduled_jobs
   ┌────┼────────┐
   ▼    ▼        ▼
RuntimeConfig  ChatQueue  Scheduler   Config + in-memory queue + bunqueue scheduler

TaskQueue (src/task-queue.ts)        bunqueue-backed subtask distribution for auto-team
Hooks (src/hooks.ts)                 SDK hooks: security, logging, progress, notifications
Subagents (src/subagents.ts)         SDK subagent definitions: researcher, code-writer, reviewer
Semaphore (src/semaphore.ts)         Counting semaphore for per-chat concurrency
Whisper (src/whisper.ts)             Groq API (primary) + whisper-cli local (fallback)
HealthMonitor (src/health.ts)        System stability checks every 30s with Telegram alerts
Sandbox (src/sandbox.ts)             Isolated /tmp dirs with safety rules per agent
Memory (src/memory.ts)               Conversation context builder for worker agents
McpConfig (src/mcp-config.ts)        MCP server configuration (bunqueue for all agents)
Orchestrator (src/orchestrator.ts)   Auto-team: detect decomposition, execute workers, synthesize
```

## Project Structure

```
index.ts                → REPL entry point (125 lines)
run.ts                  → Telegram bot entry point (352 lines)
src/
  agent.ts              → Claude SDK wrapper: query(), retry, timeout, vision, streaming, hooks, subagents (430 lines)
  agent-pool.ts         → Per-chat agent pool: master + workers + overflow, lazy init, subagents (278 lines)
  agent-identity.ts     → Identity generator: names, codes, geometric symbols (84 lines)
  orchestrator.ts       → Auto-team: detectTeamResponse, executeTeam (via TaskQueue), synthesize (172 lines)
  hooks.ts              → SDK hook factories: security, logging, progress, notifications (155 lines)
  subagents.ts          → SDK subagent definitions: researcher, code-writer, reviewer (44 lines)
  semaphore.ts          → Counting semaphore for concurrent task limiting (46 lines)
  health.ts             → Health monitor: DB, Groq, whisper, memory checks (204 lines)
  sandbox.ts            → Sandbox creation, safety rules, agent env caching (500 lines)
  memory.ts             → Conversation memory context builder (89 lines)
  mcp-config.ts         → MCP server configuration (bunqueue for all agents) (78 lines)
  db-core.ts            → Database base class: schema, sessions, messages, attachments (448 lines)
  db.ts                 → Database extends core: Telegram sessions, config, jobs (307 lines)
  task-queue.ts         → bunqueue-backed subtask distribution for auto-team (159 lines)
  chat-queue.ts         → In-memory per-chat queue with semaphore concurrency (69 lines)
  config.ts             → Env-based configuration with range validation (61 lines)
  formatter.ts          → Markdown → Telegram HTML converter + smart chunking (252 lines)
  runtime-config.ts     → Runtime configuration manager for Telegram /config (270 lines)
  scheduler.ts          → Job scheduler: bunqueue-powered, once/recurring/delay/cron (322 lines)
  whisper.ts            → Speech-to-text: Groq API primary + local whisper-cli fallback (199 lines)
  history.ts            → Session & message persistence (136 lines)
  repl.ts               → Interactive terminal with slash commands (282 lines)
  repl-commands.ts      → REPL command implementations (pure functions) (140 lines)
  session-store.ts      → Telegram chatId → sessionId mapping with in-memory cache (54 lines)
  types.ts              → All TypeScript interfaces + runtime config types (156 lines)
  logger.ts             → Pino-based structured logging to stderr (72 lines)
  spinner.ts            → Terminal spinner animation (45 lines)
  utils.ts              → Duration formatting helper (9 lines)
  index.ts              → Barrel re-exports (28 lines)
  telegram/
    handlers.ts         → Message handlers: text, photo, document, voice, audio, edited, auto-team (821 lines)
    commands.ts         → Bot commands: /start, /help, /reset, /stats, /config, etc. (503 lines)
tests/                  → 387 tests across 25 files
```

## Commands

```bash
bun run index.ts          # Run REPL
bun run run.ts            # Run Telegram bot
bun test                  # Run tests (387 tests)
bun run typecheck         # Type check (bunx tsc --noEmit)
bun run lint              # ESLint
bun run format            # Prettier write
bun run format:check      # Prettier check
bun install               # Install deps
```

## Key Patterns

### Agent & SDK

- **Claude Agent SDK**: Uses `@anthropic-ai/claude-agent-sdk` `query()` API — structured messages, no CLI parsing
- **Session continuity**: SDK `resume` option resumes conversations by session ID
- **Master agent**: `effort: "high"`, all tools enabled, subagents for sequential delegation (researcher/code-writer/reviewer)
- **Worker agents**: Fresh session per acquire, conversation context injected via system prompt
- **SDK Hooks**: PreToolUse security (block .env/credentials), PostToolUse logging + Telegram progress, Notification forwarding
- **SDK Subagents**: Master delegates to specialist agents via Task tool — researcher (haiku), code-writer (sonnet), reviewer (haiku)
- **Vision**: SDK `AsyncIterable<SDKUserMessage>` with base64 image content blocks
- **Streaming**: SDK `includePartialMessages: true` yields `stream_event` messages with text deltas
- **Retry**: Exponential backoff on transient errors (429, 503, ETIMEDOUT, ECONNRESET, rate_limit, server_error)
- **Timeout**: AbortController + setTimeout, configurable timeout (default: disabled), hard safety cap at 5 minutes
- **MCP servers**: Configured inline via SDK `mcpServers` option (no config file needed)

### Concurrency & Auto-Team

- **Agent pool**: Master agent (resume) + N-1 worker agents (fresh memory each acquire), lazy init
- **Auto-team**: Master autonomously decomposes complex tasks into parallel subtasks (JSON array response)
- **Orchestrator**: `detectTeamResponse()` parses master reply, `executeTeam()` runs workers in parallel, `synthesize()` merges results
- **ChatQueue**: In-memory per-chat ordering via Semaphore (zero I/O, instant)
- **TaskQueue**: bunqueue-backed subtask distribution — master enqueues, Worker runs SDK agents in parallel, batch resolves on completion
- **LRU eviction**: Telegram bot caps agent pools at 500, cleanup on eviction
- **Overflow agents**: Temporary agents created when pool exhausted, cleaned up on release

### Persistence

- **SQLite WAL**: Atomic writes, no corruption on crash
- **Session cleanup**: Old sessions (>90 days) + orphan mappings cleaned at startup
- **Session error auto-retry**: Detects stale sessions and retries with fresh agent
- **Photo attachments**: Stored as BLOBs in `attachments` table, linked to messages (max 20 MB)

### Telegram Bot

- **HTML formatted output**: Markdown → Telegram HTML with smart chunking (4096 char limit) + plain text fallback
- **Edited message support**: Re-processes with `[Messaggio modificato]` prefix
- **Closure-based handlers**: Handlers capture context in closures, enqueue to `ChatQueue` for per-chat ordering
- **DRY execution**: `executeWithRetry()` handles acquire/snapshot/call/history/format/retry/release + auto-team detection
- **Single status message**: Progress updates via `editMessageText` (no spam), deleted before final response
- **Voice-to-text**: Groq API primary (OGG direct, <1 sec) → local whisper-cli fallback
- **Sandbox file delivery**: New files in `output/` directory auto-sent to user
- **Reply-to-original**: Responses reply to the original user message in groups and DMs

### Safety & Isolation

- **Sandbox isolation**: Each Agent runs in `/tmp/synapse-agent-*` with CLAUDE.md safety rules
- **Cross-platform safety rules**: Prevent destructive ops on Linux, macOS, Windows
- **Cached agent env**: `buildAgentEnv()` cached per token
- **Cached SDK base options**: Stable options (cwd, env, permissions, MCP) cached per Agent instance
- **Cached sandbox rules**: `generateSandboxRules()` cached, avoid regeneration per agent
- **Cached worker memory**: `acquireMultiple()` queries DB once, shares memory across workers
- **Pre-compiled regex**: Formatter regex compiled once at module level
- **Batch SQL**: `SessionStore.clearAll()` uses single DELETE instead of per-row loop

### Configuration

- **Startup config**: Environment variables with range validation (clamped to safe ranges)
- **Runtime config**: All agent params configurable via Telegram `/config` (admin only, persisted in SQLite)
- **Health monitoring**: DB, Groq, whisper, memory checks every 30s with Telegram alerts on state changes

## Configuration

### Environment Variables

All config via environment variables loaded in `src/config.ts`. Required: `CLAUDE_CODE_OAUTH_TOKEN`. For Telegram bot: also `TELEGRAM_BOT_TOKEN`. See `.env.example` for full reference.

| Variable                        | Required  | Default                      | Description                                    |
| ------------------------------- | --------- | ---------------------------- | ---------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`       | Yes       | —                            | OAuth token for Claude CLI                     |
| `TELEGRAM_BOT_TOKEN`            | Yes (bot) | —                            | Telegram bot token                             |
| `TELEGRAM_ADMIN_ID`             | No        | —                            | Admin chat ID for privileged commands          |
| `CLAUDE_AGENT_TIMEOUT_MS`       | No        | `0` (disabled)               | Agent timeout (0–600000 ms)                    |
| `CLAUDE_AGENT_MAX_RETRIES`      | No        | `3`                          | Retry count (0–10)                             |
| `CLAUDE_AGENT_RETRY_DELAY_MS`   | No        | `1000`                       | Initial retry delay (100–30000 ms)             |
| `CLAUDE_AGENT_DB_PATH`          | No        | `~/.claude-agent/synapse.db` | SQLite database path                           |
| `CLAUDE_AGENT_SKIP_PERMISSIONS` | No        | `1`                          | Skip SDK permission prompts (1/0)              |
| `CLAUDE_AGENT_SYSTEM_PROMPT`    | No        | —                            | Custom system prompt                           |
| `CLAUDE_AGENT_MCP_CONFIG_PATH`  | No        | (auto-generated)             | Path to MCP config JSON                        |
| `CLAUDE_AGENT_MAX_CONCURRENT`   | No        | `1`                          | Max concurrent agents per chat (1–10)          |
| `GROQ_API_KEY`                  | No        | —                            | Groq API key for cloud STT (primary)           |
| `WHISPER_MODEL_PATH`            | No        | —                            | Path to whisper.cpp GGML model (enables voice) |
| `WHISPER_LANGUAGE`              | No        | `auto`                       | Whisper language code (ISO 639-1 or `auto`)    |
| `WHISPER_THREADS`               | No        | `4`                          | CPU threads for whisper (1–16)                 |

### Runtime Config (Telegram /config)

Admin can change at runtime via `/config <key> <value>`:

| Key                | Type    | Default        | Range/Enum               |
| ------------------ | ------- | -------------- | ------------------------ |
| `system_prompt`    | string  | `""`           | —                        |
| `timeout_ms`       | number  | `0` (disabled) | 0 or 5000–600000         |
| `max_retries`      | number  | `3`            | 0–10                     |
| `retry_delay_ms`   | number  | `1000`         | 100–30000                |
| `skip_permissions` | boolean | `true`         | true/false               |
| `log_level`        | string  | `INFO`         | DEBUG, INFO, WARN, ERROR |
| `max_concurrent`   | number  | `1`            | 1–10                     |
| `collaboration`    | boolean | `true`         | true/false               |
| `max_team_agents`  | number  | `20`           | 2–50                     |

Changes are validated, persisted in SQLite, and applied immediately. They survive restarts.

## Database

- **Location**: `~/.claude-agent/synapse.db` (configurable via `CLAUDE_AGENT_DB_PATH`)
- **Mode**: WAL (write-ahead logging) + foreign keys + 5s busy timeout

### Schema

```sql
sessions          (session_id TEXT PK, chat_id INTEGER, created_at TEXT, updated_at TEXT)
messages          (id INTEGER PK, session_id TEXT FK, timestamp, prompt, response, duration_ms, input_tokens, output_tokens)
attachments       (id INTEGER PK, message_id INTEGER FK, media_type TEXT, file_id TEXT, data BLOB, created_at TEXT)
telegram_sessions (chat_id INTEGER PK, session_id TEXT, updated_at TEXT)
runtime_config    (key TEXT PK, value TEXT, updated_at TEXT)
scheduled_jobs    (id INTEGER PK, chat_id INTEGER, prompt TEXT, schedule_type TEXT, run_at TEXT, interval_ms INTEGER, cron_expr TEXT, created_at TEXT, last_run_at TEXT, active INTEGER DEFAULT 1)
```

### Indexes

`idx_messages_session`, `idx_messages_timestamp`, `idx_messages_session_id`, `idx_sessions_chat_id`, `idx_telegram_sessions_session`, `idx_attachments_message`, `idx_scheduled_jobs_active`, `idx_scheduled_jobs_chat`

## Conventions

- English UI strings in REPL and Telegram bot
- Logs go to stderr (pino) to keep stdout clean for CLI output
- No build step — Bun JIT compiles TypeScript directly
- Claude interactions via `@anthropic-ai/claude-agent-sdk` `query()` API
- External binaries spawned via `Bun.spawn()` (whisper-cli, ffmpeg)
- Tests use temp directories with cleanup — no persistent side effects
- Admin auth via `TELEGRAM_ADMIN_ID` env var
- Pre-commit hooks: typecheck + lint + format check
- CI pipeline: GitHub Actions on push/PR to main
- Consistent type imports: `import type { ... }` enforced by ESLint
