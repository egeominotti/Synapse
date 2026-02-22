# CLAUDE.md

## Project Overview

Neo is a Claude AI agent platform with REPL and Telegram bot interfaces. It wraps the Claude Code CLI via process spawning (no SDK). Written in TypeScript, runs on Bun. Persistence via SQLite (bun:sqlite).

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode, ESNext target)
- **Database**: SQLite via `bun:sqlite` (WAL mode)
- **Telegram**: grammy v1.40+
- **Testing**: bun:test (93 tests)
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
Database (src/db.ts)             SQLite — sessions, messages, telegram_sessions
```

## Project Structure

```
index.ts             → REPL entry point
telegram.ts          → Telegram bot entry point
src/
  agent.ts           → Claude CLI wrapper (spawn, retry, timeout, vision)
  config.ts          → Env-based configuration
  db.ts              → SQLite database layer (bun:sqlite, WAL mode)
  history.ts         → Session & message persistence (SQLite-backed)
  repl.ts            → Interactive terminal with slash commands
  session-store.ts   → Telegram chatId → sessionId mapping (SQLite-backed)
  types.ts           → All TypeScript interfaces
  logger.ts          → Structured logging to stderr
  spinner.ts         → Terminal spinner animation
  utils.ts           → Duration formatting helper
  index.ts           → Barrel re-exports
tests/
  db.test.ts         → Database CRUD, schema, stats (22 tests)
  history.test.ts    → HistoryManager (15 tests)
  session-store.test.ts → SessionStore (10 tests)
  agent.test.ts      → Parsing, retry logic, args (22 tests)
  config.test.ts     → Config loading (2 tests)
  utils.test.ts      → formatDuration (3 tests)
  logger.test.ts     → Logger levels and output (9 tests)
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

## Configuration

All config via environment variables loaded in `src/config.ts`. Required: `CLAUDE_CODE_OAUTH_TOKEN`. For Telegram bot: also `TELEGRAM_BOT_TOKEN`.

## Data Storage

- **SQLite database**: `~/.claude-agent/neo.db` (configurable via `CLAUDE_AGENT_DB_PATH`)
- Tables: `sessions`, `messages`, `telegram_sessions`
- WAL mode enabled for concurrent reads + atomic writes
- Stats computed via SQL aggregates (single source of truth)
- Indexes: `idx_messages_session`, `idx_messages_timestamp`

## Database Schema

```sql
sessions          (session_id TEXT PK, created_at TEXT, updated_at TEXT)
messages          (id INTEGER PK, session_id TEXT FK, timestamp, prompt, response, duration_ms, input_tokens, output_tokens)
telegram_sessions (chat_id INTEGER PK, session_id TEXT, updated_at TEXT)
```

## Conventions

- Italian UI strings in REPL and Telegram bot
- Logs go to stderr to keep stdout clean
- No build step — Bun JIT compiles TypeScript directly
- Single `grammy` dependency, everything else is Bun-native
- Tests use temp directories with cleanup — no persistent side effects
