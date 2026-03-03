# CLAUDE.md

"When I report a bug, don't start by trying to fix it. Instead, start by writing a test that reproduces the bug. Then, have subagents try to fix the bug and prove it with a passing test."

## Project Overview

Synapse is a Claude AI agent platform with REPL and Telegram bot interfaces. Uses the `@anthropic-ai/claude-agent-sdk` `query()` API for all Claude interactions. Written in TypeScript, runs on Bun. Persistence via SQLite (bun:sqlite). Runtime configuration via Telegram admin commands. Single agent per chat — simple and focused.

## Tech Stack

- **Runtime**: Bun (no build step, JIT TypeScript)
- **Language**: TypeScript (strict mode, ESNext target)
- **Database**: SQLite via `bun:sqlite` (WAL mode)
- **Telegram**: grammy v1.40+
- **Logging**: pino + pino-pretty (structured, stderr only)
- **Scheduler**: bunqueue (MCP-based job scheduling for all agents)
- **Voice**: Groq API (primary) + whisper-cli local (fallback), whisper-large-v3-turbo
- **Testing**: bun:test (14 files)
- **Linting**: ESLint (typescript-eslint) + Prettier
- **CI/CD**: GitHub Actions + Husky pre-commit hooks
- **Claude Integration**: `@anthropic-ai/claude-agent-sdk` `query()` API (structured messages, inline MCP, AbortController)

## Architecture

```
index.ts / run.ts                  Entry points (REPL / Telegram bot)
        │
        ▼
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
RuntimeConfig  Scheduler  HealthMonitor

Whisper (src/whisper.ts)             Groq API (primary) + whisper-cli local (fallback)
Sandbox (src/sandbox.ts)             Isolated /tmp dirs with safety rules per agent
McpConfig (src/mcp-config.ts)        MCP server configuration (bunqueue for all agents)
```

## Project Structure

```
index.ts                → REPL entry point (125 lines)
run.ts                  → Telegram bot entry point
src/
  agent.ts              → Claude SDK wrapper: query(), retry, timeout, vision, streaming
  health.ts             → Health monitor: DB, Groq, whisper, memory checks
  sandbox.ts            → Sandbox creation, safety rules, agent env caching
  mcp-config.ts         → MCP server configuration (bunqueue for all agents)
  db-core.ts            → Database base class: schema, sessions, messages, attachments
  db.ts                 → Database extends core: Telegram sessions, config, jobs
  config.ts             → Env-based configuration with range validation
  formatter.ts          → Markdown → Telegram HTML converter + smart chunking
  runtime-config.ts     → Runtime configuration manager for Telegram /config
  scheduler.ts          → Job scheduler: bunqueue-powered, once/recurring/delay/cron
  whisper.ts            → Speech-to-text: Groq API primary + local whisper-cli fallback
  history.ts            → Session & message persistence
  repl.ts               → Interactive terminal with slash commands
  repl-commands.ts      → REPL command implementations (pure functions)
  session-store.ts      → Telegram chatId → sessionId mapping with in-memory cache
  types.ts              → All TypeScript interfaces + runtime config types
  logger.ts             → Pino-based structured logging to stderr
  spinner.ts            → Terminal spinner animation
  utils.ts              → Duration formatting helper
  index.ts              → Barrel re-exports
  telegram/
    handlers.ts         → Message handlers: text, photo, document, voice, audio, edited
    commands.ts         → Bot commands: /start, /help, /reset, /stats, /config, etc.
tests/                  → 14 test files
```

## Commands

```bash
bun run index.ts          # Run REPL
bun run run.ts            # Run Telegram bot
bun test                  # Run tests
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
- **Single agent per chat**: One Agent instance per Telegram chat, simple `Map<number, Agent>`
- **Vision**: SDK `AsyncIterable<SDKUserMessage>` with base64 image content blocks
- **Streaming**: SDK `includePartialMessages: true` yields `stream_event` messages with text deltas
- **Retry**: Exponential backoff on transient errors (429, 503, ETIMEDOUT, ECONNRESET, rate_limit, server_error)
- **Timeout**: AbortController + setTimeout, configurable timeout (default: disabled), hard safety cap at 5 minutes
- **MCP servers**: Configured inline via SDK `mcpServers` option (no config file needed)

### Persistence

- **SQLite WAL**: Atomic writes, no corruption on crash
- **Session cleanup**: Old sessions (>90 days) + orphan mappings cleaned at startup
- **Session error auto-retry**: Detects stale sessions and retries with fresh agent
- **Photo attachments**: Stored as BLOBs in `attachments` table, linked to messages (max 20 MB)

### Telegram Bot

- **HTML formatted output**: Markdown → Telegram HTML with smart chunking (4096 char limit) + plain text fallback
- **Edited message support**: Re-processes with `[Edited message]` prefix
- **Per-chat serialization**: Inline promise chain ensures one message at a time per chat
- **DRY execution**: `executeWithRetry()` handles call/history/format/retry
- **Single status message**: Progress updates via `editMessageText` (no spam), deleted before final response
- **Voice-to-text**: Groq API primary (OGG direct, <1 sec) → local whisper-cli fallback
- **Sandbox file delivery**: New files in `output/` directory auto-sent to user
- **Reply-to-original**: Responses reply to the original user message in groups and DMs

### Safety & Isolation

- **Sandbox isolation**: Each Agent runs in `/tmp/synapse-agent-*` with CLAUDE.md safety rules
- **Cross-platform safety rules**: Prevent destructive ops on Linux, macOS, Windows
- **Cached agent env**: `buildAgentEnv()` cached per token
- **Cached SDK base options**: Stable options (cwd, env, permissions, MCP) cached per Agent instance
- **Pre-compiled regex**: Formatter regex compiled once at module level

### Configuration

- **Startup config**: Environment variables with range validation (clamped to safe ranges)
- **Runtime config**: Agent params configurable via Telegram `/config` (admin only, persisted in SQLite)
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
