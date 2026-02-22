# Neo

AI agent powered by Claude Code CLI with two interfaces: interactive REPL and Telegram bot.

## Features

- **REPL** — Terminal interface with slash commands, multiline input, vision support
- **Telegram Bot** — Multi-user bot with per-chat sessions, photo analysis, auto-restart
- **SQLite Persistence** — Sessions, messages, and stats in a single atomic database
- **Vision** — Send images via `/image` (REPL) or photo messages (Telegram)
- **Retry & Timeout** — Exponential backoff on transient errors, configurable timeout
- **Docker Isolation** — Optional containerized execution with resource limits
- **Test Suite** — 93 tests covering all modules (bun:test)

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed globally
- Anthropic OAuth token

## Quick Setup

```bash
bash init.sh
```

The script installs dependencies, authenticates with Anthropic, configures environment variables, and optionally sets up auto-restart (launchd/systemd).

## Manual Setup

```bash
bun install
cp .env.example .env  # edit with your tokens
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes | — | Claude CLI auth token |
| `TELEGRAM_BOT_TOKEN` | Bot only | — | Telegram bot token from @BotFather |
| `CLAUDE_AGENT_SYSTEM_PROMPT` | No | `""` | Custom agent persona/instructions |
| `CLAUDE_AGENT_TIMEOUT_MS` | No | `120000` | Max response time (ms) |
| `CLAUDE_AGENT_MAX_RETRIES` | No | `3` | Retry attempts on transient errors |
| `CLAUDE_AGENT_RETRY_DELAY_MS` | No | `1000` | Initial retry backoff (ms) |
| `CLAUDE_AGENT_DB_PATH` | No | `~/.claude-agent/neo.db` | SQLite database path |
| `CLAUDE_AGENT_LOG_LEVEL` | No | `INFO` | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` |
| `CLAUDE_AGENT_SKIP_PERMISSIONS` | No | `1` | Skip CLI permission prompts |
| `CLAUDE_AGENT_DOCKER` | No | `0` | Run in Docker containers |
| `CLAUDE_AGENT_DOCKER_IMAGE` | No | `claude-agent:latest` | Docker image name |

## Usage

### REPL

```bash
bun run index.ts
```

#### Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/image <path> [prompt]` | Analyze an image |
| `/history` | Show last 5 exchanges |
| `/sessions` | List saved sessions |
| `/load <session_id>` | Resume a session |
| `/stats` | Session statistics |
| `/reset` | Start fresh conversation |
| `/exit` | Quit |

### Telegram Bot

```bash
bun run telegram.ts
```

#### Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Available commands |
| `/reset` | Clear session |
| `/stats` | Session statistics |

Send photos with optional captions for vision analysis.

### Tests

```bash
bun test
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Entry Points                         │
│                                                          │
│   index.ts (REPL)              telegram.ts (Bot)         │
│       │                             │                    │
│       ▼                             ▼                    │
│   ┌───────┐                    ┌─────────┐              │
│   │ Repl  │                    │ grammy  │              │
│   │       │                    │  Bot    │              │
│   └───┬───┘                    └────┬────┘              │
│       │                             │                    │
│       ▼                             ▼                    │
│   ┌────────────────────────────────────┐                │
│   │            Agent                    │                │
│   │  Bun.spawn("claude --print ...")    │                │
│   │  Retry + Timeout + JSON parsing     │                │
│   └──────────────┬─────────────────────┘                │
│                  │                                       │
│       ┌──────────┴──────────┐                           │
│       ▼                     ▼                            │
│  ┌──────────┐       ┌──────────────┐                    │
│  │ History  │       │ SessionStore │                    │
│  │ Manager  │       │  (Telegram)  │                    │
│  └────┬─────┘       └──────┬───────┘                    │
│       │                    │                             │
│       ▼                    ▼                             │
│  ┌─────────────────────────────────┐                    │
│  │         Database (SQLite)        │                    │
│  │  sessions │ messages │ telegram  │                    │
│  │           neo.db (WAL mode)      │                    │
│  └─────────────────────────────────┘                    │
│                                                          │
│  ┌──────────┐  ┌────────┐  ┌─────────┐  ┌───────┐     │
│  │  Config  │  │ Logger │  │ Spinner │  │ Utils │     │
│  └──────────┘  └────────┘  └─────────┘  └───────┘     │
└─────────────────────────────────────────────────────────┘
```

### File Structure

```
index.ts             REPL entry point — wires Agent + HistoryManager + Repl
telegram.ts          Telegram bot — per-chat agents, photo support, session restore
src/
  agent.ts           Claude CLI wrapper (spawn, retry, timeout, JSON/stream parsing)
  config.ts          Environment-based configuration with defaults
  db.ts              SQLite layer (bun:sqlite, WAL mode, schema, CRUD)
  history.ts         Session & message persistence (SQLite-backed)
  repl.ts            Interactive terminal with 8 slash commands
  session-store.ts   Telegram chatId → sessionId mapping (SQLite-backed)
  types.ts           All TypeScript interfaces (AgentConfig, SessionFile, etc.)
  logger.ts          Structured logging to stderr (4 levels, session context)
  spinner.ts         Braille terminal spinner animation
  utils.ts           Duration formatting helper
  index.ts           Barrel re-exports
tests/
  db.test.ts         22 tests — schema, CRUD, stats, Telegram sessions
  history.test.ts    15 tests — init, addMessage, loadSession, stats
  session-store.test.ts  10 tests — load, get, set, delete, persistence
  agent.test.ts      22 tests — parseResponse, TimeoutError, buildArgs
  config.test.ts     2 tests — defaults, custom env vars
  utils.test.ts      3 tests — formatDuration
  logger.test.ts     9 tests — levels, filtering, session ID
```

### Data Flow

```
User input (REPL or Telegram)
    │
    ▼
Agent.call(prompt)
    │
    ├─ Bun.spawn("claude --print --output-format json --resume <sid> ...")
    ├─ Race with timeout → kill on exceed
    ├─ Parse JSON response → extract text + session_id + token usage
    └─ Retry on transient errors (429, 503, ECONNRESET) with exponential backoff
    │
    ▼
HistoryManager.addMessage()  /  SessionStore.set()
    │
    ▼
Database (SQLite) → INSERT into messages / telegram_sessions
```

### Database Schema

```sql
sessions         (session_id PK, created_at, updated_at)
messages         (id PK, session_id FK, timestamp, prompt, response, duration_ms, input_tokens, output_tokens)
telegram_sessions (chat_id PK, session_id, updated_at)
```

Stats are computed via SQL aggregates — no denormalized tables.

## Production

`init.sh` can configure auto-restart:

- **macOS**: launchd service at `~/Library/LaunchAgents/com.claude-agent.telegram.plist`
- **Linux**: systemd user service at `~/.config/systemd/user/claude-agent-telegram.service`

## License

Private project.
