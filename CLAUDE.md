# CLAUDE.md

## Project Overview

Neo is a Claude AI agent platform with REPL and Telegram bot interfaces. It wraps the Claude Code CLI via process spawning (no SDK). Written in TypeScript, runs on Bun. Persistence via SQLite (bun:sqlite). Runtime configuration via Telegram admin commands.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode, ESNext target)
- **Database**: SQLite via `bun:sqlite` (WAL mode)
- **Telegram**: grammy v1.40+
- **Scheduler**: croner (zero-dep cron library with second-level precision)
- **Voice**: whisper.cpp via `whisper-cli` (optional, local speech-to-text)
- **Testing**: bun:test (283 tests, 17 files)
- **Linting**: ESLint (typescript-eslint) + Prettier
- **CI/CD**: GitHub Actions + Husky pre-commit hooks
- **Claude Integration**: Direct CLI spawning via `Bun.spawn()`

## Architecture

```
index.ts / run.ts               Entry points
        │
        ▼
    Agent (src/agent.ts)         Spawns `claude` CLI, retry + timeout
        │
   ┌────┴────┐
   ▼         ▼
History   SessionStore           Persistence layer
   │         │
   ▼         ▼
Database (src/db.ts)             SQLite — sessions, messages, attachments, telegram_sessions, runtime_config, scheduled_jobs
        ▲
   ┌────┼────────┐
   ▼    ▼        ▼
RuntimeConfig  ChatQueue  Scheduler   Config + queue + croner-based job scheduler

Whisper (src/whisper.ts)         Optional: voice → text via whisper-cli
AgentIdentity (src/agent-identity.ts)   Matrix-themed visual identity for agents
```

## Project Structure

```
index.ts             → REPL entry point
run.ts               → Telegram bot entry point (init, caches, scheduler, startup)
src/
  agent.ts           → Claude CLI wrapper (spawn, retry, timeout, vision)
  agent-identity.ts  → Matrix-themed agent identity generator (names, codes, emojis)
  sandbox.ts         → Sandbox creation, safety rules, file listing, spawn env
  db-core.ts         → Database base class (schema, sessions, messages, attachments, cleanup)
  db.ts              → Database extends DatabaseCore (Telegram sessions, config, jobs)
  chat-queue.ts      → Per-chat serial message queue (prevents race conditions)
  config.ts          → Env-based configuration with range validation
  formatter.ts       → Markdown → Telegram HTML converter + smart chunking
  runtime-config.ts  → Runtime configuration manager (Telegram /config)
  scheduler.ts       → Job scheduler (croner-powered, once/recurring/delay/cron)
  whisper.ts         → Optional voice-to-text via whisper-cli (local whisper.cpp)
  history.ts         → Session & message persistence (SQLite-backed)
  repl.ts            → Interactive terminal with slash commands
  repl-commands.ts   → REPL command implementations (pure functions)
  session-store.ts   → Telegram chatId → sessionId mapping (SQLite-backed)
  types.ts           → All TypeScript interfaces + runtime config types
  logger.ts          → Structured logging to stderr
  spinner.ts         → Terminal spinner animation
  utils.ts           → Duration formatting helper
  index.ts           → Barrel re-exports
  telegram/
    handlers.ts      → Message handlers (text, photo, document, voice, audio, edited)
    commands.ts      → Bot commands (/start, /help, /reset, /stats, /config, etc.)
tests/
  db.test.ts              → Database CRUD, schema, stats, cleanup (25 tests)
  history.test.ts         → HistoryManager (15 tests)
  session-store.test.ts   → SessionStore (10 tests)
  agent.test.ts           → Parsing, retry logic, args (28 tests)
  agent-identity.test.ts  → Identity generation, formatting, orchestrator (9 tests)
  config.test.ts          → Config loading + range validation (5 tests)
  runtime-config.test.ts  → RuntimeConfig get/set/reset/validation (24 tests)
  formatter.test.ts       → Markdown→HTML conversion + chunking (29 tests)
  chat-queue.test.ts      → Serial queue ordering + concurrency (5 tests)
  scheduler.test.ts       → parseSchedule, toCronExpr, DB CRUD, Scheduler + croner (40 tests)
  handlers.test.ts        → Free-text schedule parsing (16 tests)
  whisper.test.ts         → Whisper output parsing (7 tests)
  sandbox.test.ts         → MIME types, spawn env, sandbox creation, file listing (20 tests)
  repl-commands.test.ts   → parseImageArgs, writeMeta, printBanner, printStats (13 tests)
  utils.test.ts           → formatDuration (3 tests)
  logger.test.ts          → Logger levels and output (9 tests)
```

## Commands

```bash
# Run REPL
bun run index.ts

# Run Telegram bot
bun run run.ts

# Run tests
bun test

# Type check
bun run typecheck

# Lint
bun run lint

# Format
bun run format

# Check formatting
bun run format:check

# Install deps
bun install
```

## Key Patterns

- **No Claude SDK**: Agent spawns `claude` CLI with `--print --output-format json` flags
- **Session continuity**: `--resume <sessionId>` flag resumes conversations
- **Vision**: Uses `--input-format stream-json` with base64 image data via stdin
- **Voice-to-text**: Optional whisper.cpp — OGG Opus → ffmpeg → WAV → whisper-cli → text
- **Retry**: Exponential backoff on transient errors (429, 503, connection resets)
- **Timeout**: Optional process timeout (default: disabled), kills on exceed
- **Concurrent I/O**: Reads stdout/stderr in parallel to prevent deadlock
- **Graceful shutdown**: Signal handlers (SIGINT/SIGTERM) close DB before exit
- **Atomic persistence**: SQLite WAL mode — no corrupted files on crash
- **Photo attachments**: Telegram photos stored as BLOBs in `attachments` table, linked to messages
- **LRU agent eviction**: Telegram bot caps agents at 500, cleans up sandbox on eviction
- **Per-chat message queue**: Serial queue per chat prevents race conditions on Claude sessions
- **HTML formatted output**: Markdown → Telegram HTML conversion with smart chunking and fallback
- **Edited message support**: Re-processes edited messages through Claude with `[Messaggio modificato]` prefix
- **Runtime config**: All agent params configurable via Telegram `/config` (admin only)
- **Job scheduler**: croner-powered with per-job Cron instances, supports once/recurring/delay/cron
- **Agent identity**: Matrix-themed names + color emojis distinguish orchestrator from job agents
- **Sandbox isolation**: Each Agent runs in a temp directory (`/tmp/neo-agent-*`) with CLAUDE.md safety rules
- **Cross-platform safety rules**: Comprehensive rules prevent destructive operations on Linux, macOS, Windows
- **Cached spawn env**: `buildSpawnEnv()` cached per token to avoid per-call overhead
- **Config range validation**: Env vars clamped to safe ranges (timeout 0–600s, retries 0–10)
- **Photo size check**: Downloads checked against Content-Length before buffering (max 20 MB)
- **Session cleanup**: Old sessions (>90 days) and orphan mappings cleaned at startup (batch DELETE with CASCADE)
- **Session error auto-retry**: Detects stale sessions ("No conversation found", "invalid session") and retries with fresh session
- **DRY handlers**: `executeWithRetry()` pattern handles snapshot/call/history/format/retry in one place
- **Modular telegram**: Commands and handlers split into `src/telegram/` for <350 lines per file
- **Pre-compiled regex**: Formatter regex patterns compiled once at module level, not per call
- **Sandbox cleanup**: `Agent.cleanup()` removes temp directories on LRU eviction

## Configuration

### Startup (Environment Variables)

All config via environment variables loaded in `src/config.ts`. Required: `CLAUDE_CODE_OAUTH_TOKEN`. For Telegram bot: also `TELEGRAM_BOT_TOKEN`.

| Variable                  | Required  | Default | Description                                    |
| ------------------------- | --------- | ------- | ---------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes       | —       | OAuth token for Claude CLI                     |
| `TELEGRAM_BOT_TOKEN`      | Yes (bot) | —       | Telegram bot token                             |
| `TELEGRAM_ADMIN_ID`       | No        | —       | Admin chat ID for privileged commands          |
| `WHISPER_MODEL_PATH`      | No        | —       | Path to whisper.cpp GGML model (enables voice) |
| `WHISPER_LANGUAGE`        | No        | `it`    | Whisper language code (ISO 639-1)              |
| `WHISPER_THREADS`         | No        | `4`     | CPU threads for whisper transcription          |

### Runtime (Telegram /config)

Admin can change these at runtime via `/config <key> <value>`:

| Key                | Type    | Default               | Range/Enum               |
| ------------------ | ------- | --------------------- | ------------------------ |
| `system_prompt`    | string  | `""`                  | —                        |
| `timeout_ms`       | number  | `0` (disabled)        | 0–600000                 |
| `max_retries`      | number  | `3`                   | 0–10                     |
| `retry_delay_ms`   | number  | `1000`                | 100–30000                |
| `skip_permissions` | boolean | `true`                | true/false               |
| `log_level`        | string  | `INFO`                | DEBUG, INFO, WARN, ERROR |
| `docker`           | boolean | `false`               | true/false               |
| `docker_image`     | string  | `claude-agent:latest` | —                        |

Changes are validated, persisted in SQLite, and applied immediately. They survive restarts.

## Data Storage

- **SQLite database**: `~/.claude-agent/neo.db` (configurable via `CLAUDE_AGENT_DB_PATH`)
- Tables: `sessions`, `messages`, `attachments`, `telegram_sessions`, `runtime_config`, `scheduled_jobs`
- WAL mode enabled for concurrent reads + atomic writes
- Stats computed via SQL aggregates (single source of truth)
- Indexes: `idx_messages_session`, `idx_messages_timestamp`, `idx_messages_session_id`, `idx_telegram_sessions_session`, `idx_attachments_message`, `idx_scheduled_jobs_active`, `idx_scheduled_jobs_chat`

## Database Schema

```sql
sessions          (session_id TEXT PK, chat_id INTEGER, created_at TEXT, updated_at TEXT)
messages          (id INTEGER PK, session_id TEXT FK, timestamp, prompt, response, duration_ms, input_tokens, output_tokens)
attachments       (id INTEGER PK, message_id INTEGER FK, media_type TEXT, file_id TEXT, data BLOB, created_at TEXT)
telegram_sessions (chat_id INTEGER PK, session_id TEXT, updated_at TEXT)
runtime_config    (key TEXT PK, value TEXT, updated_at TEXT)
scheduled_jobs    (id INTEGER PK, chat_id INTEGER, prompt TEXT, schedule_type TEXT, run_at TEXT, interval_ms INTEGER, cron_expr TEXT, created_at TEXT, last_run_at TEXT, active INTEGER)
```

## Conventions

- Italian UI strings in REPL and Telegram bot
- Logs go to stderr to keep stdout clean
- No build step — Bun JIT compiles TypeScript directly
- External binaries spawned via `Bun.spawn()` (claude CLI, whisper-cli)
- Tests use temp directories with cleanup — no persistent side effects
- Admin auth via `TELEGRAM_ADMIN_ID` env var
- Pre-commit hooks: typecheck + lint + format check
- CI pipeline: GitHub Actions on push/PR to main
