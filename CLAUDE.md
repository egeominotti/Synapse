# CLAUDE.md

## Project Overview

Neo is a Claude AI agent platform with REPL and Telegram bot interfaces. It wraps the Claude Code CLI via process spawning (no SDK). Written in TypeScript, runs on Bun. Persistence via SQLite (bun:sqlite). Runtime configuration via Telegram admin commands.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode, ESNext target)
- **Database**: SQLite via `bun:sqlite` (WAL mode)
- **Telegram**: grammy v1.40+
- **Testing**: bun:test (114 tests)
- **Claude Integration**: Direct CLI spawning via `Bun.spawn()`

## Architecture

```
index.ts / telegram.ts          Entry points
        │
        ▼
    Agent (src/agent.ts)         Spawns `claude` CLI, retry + timeout
        │
   ┌────┴────┐
   ▼         ▼
History   SessionStore           Persistence layer
   │         │
   ▼         ▼
Database (src/db.ts)             SQLite — sessions, messages, attachments, telegram_sessions, runtime_config
        ▲
        │
RuntimeConfig (src/runtime-config.ts)   Config manager — validates, persists, applies at runtime
```

## Project Structure

```
index.ts             → REPL entry point
telegram.ts          → Telegram bot entry point (+ /config admin command)
src/
  agent.ts           → Claude CLI wrapper (spawn, retry, timeout, vision)
  config.ts          → Env-based configuration (startup defaults)
  runtime-config.ts  → Runtime configuration manager (Telegram /config)
  db.ts              → SQLite database layer (bun:sqlite, WAL mode)
  history.ts         → Session & message persistence (SQLite-backed)
  repl.ts            → Interactive terminal with slash commands
  session-store.ts   → Telegram chatId → sessionId mapping (SQLite-backed)
  types.ts           → All TypeScript interfaces + runtime config types
  logger.ts          → Structured logging to stderr
  spinner.ts         → Terminal spinner animation
  utils.ts           → Duration formatting helper
  index.ts           → Barrel re-exports
tests/
  db.test.ts              → Database CRUD, schema, stats (22 tests)
  history.test.ts         → HistoryManager (15 tests)
  session-store.test.ts   → SessionStore (10 tests)
  agent.test.ts           → Parsing, retry logic, args (22 tests)
  config.test.ts          → Config loading (2 tests)
  runtime-config.test.ts  → RuntimeConfig get/set/reset/validation (21 tests)
  utils.test.ts           → formatDuration (3 tests)
  logger.test.ts          → Logger levels and output (9 tests)
```

## Commands

```bash
# Run REPL
bun run index.ts

# Run Telegram bot
bun run telegram.ts

# Run tests
bun test

# Type check
bunx tsc --noEmit

# Install deps
bun install
```

## Key Patterns

- **No Claude SDK**: Agent spawns `claude` CLI with `--print --output-format json` flags
- **Session continuity**: `--resume <sessionId>` flag resumes conversations
- **Vision**: Uses `--input-format stream-json` with base64 image data via stdin
- **Retry**: Exponential backoff on transient errors (429, 503, connection resets)
- **Timeout**: Races process execution against configurable timeout, kills on exceed
- **Concurrent I/O**: Reads stdout/stderr in parallel to prevent deadlock
- **Graceful shutdown**: Signal handlers (SIGINT/SIGTERM) close DB before exit
- **Atomic persistence**: SQLite WAL mode — no corrupted files on crash
- **Photo attachments**: Telegram photos stored as BLOBs in `attachments` table, linked to messages
- **LRU agent eviction**: Telegram bot caps agents at 500 to prevent memory leaks
- **Runtime config**: All agent params configurable via Telegram `/config` (admin only)
- **Cached spawn env**: `buildSpawnEnv()` cached per token to avoid per-call overhead

## Configuration

### Startup (Environment Variables)

All config via environment variables loaded in `src/config.ts`. Required: `CLAUDE_CODE_OAUTH_TOKEN`. For Telegram bot: also `TELEGRAM_BOT_TOKEN`.

### Runtime (Telegram /config)

Admin can change these at runtime via `/config <key> <value>`:

| Key                | Type    | Default               | Range/Enum               |
| ------------------ | ------- | --------------------- | ------------------------ |
| `system_prompt`    | string  | `""`                  | —                        |
| `timeout_ms`       | number  | `120000`              | 5000–600000              |
| `max_retries`      | number  | `3`                   | 0–10                     |
| `retry_delay_ms`   | number  | `1000`                | 100–30000                |
| `skip_permissions` | boolean | `true`                | true/false               |
| `log_level`        | string  | `INFO`                | DEBUG, INFO, WARN, ERROR |
| `docker`           | boolean | `false`               | true/false               |
| `docker_image`     | string  | `claude-agent:latest` | —                        |

Changes are validated, persisted in SQLite, and applied immediately. They survive restarts.

## Data Storage

- **SQLite database**: `~/.claude-agent/neo.db` (configurable via `CLAUDE_AGENT_DB_PATH`)
- Tables: `sessions`, `messages`, `telegram_sessions`, `runtime_config`, `attachments`
- WAL mode enabled for concurrent reads + atomic writes
- Stats computed via SQL aggregates (single source of truth)
- Indexes: `idx_messages_session`, `idx_messages_timestamp`, `idx_messages_session_id`, `idx_telegram_sessions_session`, `idx_attachments_message`

## Database Schema

```sql
sessions          (session_id TEXT PK, created_at TEXT, updated_at TEXT)
messages          (id INTEGER PK, session_id TEXT FK, timestamp, prompt, response, duration_ms, input_tokens, output_tokens)
attachments       (id INTEGER PK, message_id INTEGER FK, media_type TEXT, file_id TEXT, data BLOB, created_at TEXT)
telegram_sessions (chat_id INTEGER PK, session_id TEXT, updated_at TEXT)
runtime_config    (key TEXT PK, value TEXT, updated_at TEXT)
```

## Conventions

- Italian UI strings in REPL and Telegram bot
- Logs go to stderr to keep stdout clean
- No build step — Bun JIT compiles TypeScript directly
- Single `grammy` dependency, everything else is Bun-native
- Tests use temp directories with cleanup — no persistent side effects
- Admin auth via `TELEGRAM_ADMIN_ID` env var
