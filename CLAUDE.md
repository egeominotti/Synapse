# CLAUDE.md

## Project Overview

Neo is a Claude AI agent platform with REPL and Telegram bot interfaces. It wraps the Claude Code CLI via process spawning (no SDK). Written in TypeScript, runs on Bun.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode, ESNext target)
- **Telegram**: grammy v1.40+
- **Claude Integration**: Direct CLI spawning via `Bun.spawn()`

## Project Structure

```
index.ts           → REPL entry point
telegram.ts        → Telegram bot entry point
src/agent.ts       → Claude CLI wrapper (core logic)
src/config.ts      → Env-based configuration
src/history.ts     → Session persistence to disk
src/repl.ts        → Interactive terminal interface
src/session-store.ts → Telegram session mapping
src/types.ts       → All TypeScript interfaces
src/logger.ts      → Structured logging (stderr)
src/spinner.ts     → Terminal spinner
src/utils.ts       → Duration formatting helper
src/index.ts       → Public API re-exports
```

## Commands

```bash
# Run REPL
bun run index.ts

# Run Telegram bot
bun run telegram.ts

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
- **Graceful shutdown**: Signal handlers (SIGINT/SIGTERM) flush history before exit

## Configuration

All config via environment variables loaded in `src/config.ts`. Required: `CLAUDE_CODE_OAUTH_TOKEN`. For Telegram bot: also `TELEGRAM_BOT_TOKEN`.

## Data Storage

- REPL sessions: `~/.claude-agent/history/{sessionId}.json`
- Telegram sessions: `~/.claude-agent/telegram-sessions.json`

## Conventions

- Italian UI strings in REPL and Telegram bot
- Logs go to stderr to keep stdout clean
- No build step — Bun JIT compiles TypeScript directly
- Single `grammy` dependency, everything else is Bun-native
