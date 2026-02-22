# Neo

AI agent powered by Claude Code CLI with two interfaces: interactive REPL and Telegram bot.

## Features

- **REPL** — Terminal interface with slash commands, multiline input, vision support
- **Telegram Bot** — Multi-user bot with per-chat sessions, photo analysis, LRU agent eviction
- **Voice Transcription** — Local speech-to-text via whisper.cpp large-v3 (boosted, auto language, flash-attn)
- **HTML Formatted Output** — Claude's Markdown converted to Telegram HTML with smart chunking
- **MCP Servers** — Memory, Sequential Thinking, Fetch, Filesystem, Git, SQLite, Everything
- **Runtime Config** — Change all agent parameters live from Telegram (`/config`), admin-only
- **SQLite Persistence** — Sessions, messages, attachments, config in a single atomic database
- **Vision** — Send images via `/image` (REPL) or photo messages (Telegram), photos persisted as BLOBs
- **Message Queue** — Per-chat serial queue prevents race conditions on Claude sessions
- **Edit Support** — Edit a sent message to re-process it through Claude
- **Session Export** — `/export` downloads the full conversation as a Markdown file
- **Retry** — Exponential backoff on transient errors, optional configurable timeout
- **Docker Isolation** — Optional containerized execution with resource limits
- **Sandbox Isolation** — Each Agent runs in `/tmp/neo-agent-*` with cross-platform safety rules
- **Conversation Memory** — Recent messages injected as context when starting new sessions
- **Test Suite** — 283 tests across 17 files (bun:test)
- **CI/CD** — GitHub Actions pipeline + Husky pre-commit hooks (typecheck, lint, format)

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed globally
- Anthropic OAuth token

### Optional

- **whisper-cpp + ffmpeg** — for voice message transcription (`brew install whisper-cpp ffmpeg`)
- **Docker** — for containerized agent execution

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

| Variable                        | Required | Default                  | Description                                           |
| ------------------------------- | -------- | ------------------------ | ----------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`       | Yes      | —                        | Claude CLI auth token                                 |
| `TELEGRAM_BOT_TOKEN`            | Bot only | —                        | Telegram bot token from @BotFather                    |
| `TELEGRAM_ADMIN_ID`             | No       | —                        | Telegram chat ID for admin access (`/config`)         |
| `CLAUDE_AGENT_SYSTEM_PROMPT`    | No       | `""`                     | Custom agent persona/instructions                     |
| `CLAUDE_AGENT_TIMEOUT_MS`       | No       | `0` (disabled)           | Max response time (ms), 0 = no timeout                |
| `CLAUDE_AGENT_MAX_RETRIES`      | No       | `3`                      | Retry attempts on transient errors                    |
| `CLAUDE_AGENT_RETRY_DELAY_MS`   | No       | `1000`                   | Initial retry backoff (ms)                            |
| `CLAUDE_AGENT_DB_PATH`          | No       | `~/.claude-agent/neo.db` | SQLite database path                                  |
| `CLAUDE_AGENT_LOG_LEVEL`        | No       | `INFO`                   | `DEBUG` \| `INFO` \| `WARN` \| `ERROR`                |
| `CLAUDE_AGENT_SKIP_PERMISSIONS` | No       | `1`                      | Skip CLI permission prompts                           |
| `CLAUDE_AGENT_DOCKER`           | No       | `0`                      | Run in Docker containers                              |
| `CLAUDE_AGENT_DOCKER_IMAGE`     | No       | `claude-agent:latest`    | Docker image name                                     |
| `WHISPER_MODEL_PATH`            | No       | —                        | Path to ggml model file (enables voice transcription) |
| `WHISPER_LANGUAGE`              | No       | `auto`                   | Whisper language (`auto` for detection, or ISO 639-1) |
| `WHISPER_THREADS`               | No       | `4`                      | CPU threads for whisper (1–16)                        |

## Usage

### REPL

```bash
bun run index.ts
```

#### Slash Commands

| Command                  | Description              |
| ------------------------ | ------------------------ |
| `/help`                  | Show available commands  |
| `/image <path> [prompt]` | Analyze an image         |
| `/history`               | Show last 5 exchanges    |
| `/sessions`              | List saved sessions      |
| `/load <session_id>`     | Resume a session         |
| `/stats`                 | Session statistics       |
| `/reset`                 | Start fresh conversation |
| `/exit`                  | Quit                     |

### Telegram Bot

```bash
bun run run.ts
```

#### Bot Commands

| Command   | Description                        |
| --------- | ---------------------------------- |
| `/start`  | Welcome message                    |
| `/help`   | Available commands                 |
| `/reset`  | Clear session                      |
| `/stats`  | Session statistics                 |
| `/export` | Download conversation as file      |
| `/ping`   | Bot health check                   |
| `/config` | Runtime configuration (admin only) |

Send photos with optional captions for vision analysis.
Send voice messages for automatic transcription via whisper.
Edit a sent message to re-send it to Claude.

#### Voice Transcription

When `WHISPER_MODEL_PATH` is set and `whisper-cli` + `ffmpeg` are installed:

1. Send a voice message or audio file on Telegram
2. The bot shows the transcription: `"text"`
3. The transcription is sent to Claude as a prompt
4. Claude's response is sent back

Setup:

```bash
brew install whisper-cpp ffmpeg
curl -L -o ~/.claude-agent/ggml-large.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
# Set WHISPER_MODEL_PATH=~/.claude-agent/ggml-large.bin in .env
```

Boosted parameters: beam-size 8, best-of 8, flash-attn, auto language detection.

#### Runtime Configuration (Admin Only)

Set `TELEGRAM_ADMIN_ID` to your Telegram chat ID. Then use:

```
/config                     Show all current settings
/config <key>               Show single setting with details
/config <key> <value>       Change a setting (validated)
/config reset               Restore all defaults
/config reset <key>         Restore single default
```

**Configurable parameters:**

| Key                | Type    | Default               | Range                 |
| ------------------ | ------- | --------------------- | --------------------- |
| `system_prompt`    | string  | `""`                  | —                     |
| `timeout_ms`       | number  | `0` (disabled)        | 0–600000              |
| `max_retries`      | number  | `3`                   | 0–10                  |
| `retry_delay_ms`   | number  | `1000`                | 100–30000             |
| `skip_permissions` | boolean | `true`                | —                     |
| `log_level`        | string  | `INFO`                | DEBUG/INFO/WARN/ERROR |
| `docker`           | boolean | `false`               | —                     |
| `docker_image`     | string  | `claude-agent:latest` | —                     |

Changes are validated, persisted in SQLite, and applied immediately. They survive bot restarts.

### Development

```bash
bun test              # Run 283 tests
bun run typecheck     # TypeScript check
bun run lint          # ESLint
bun run format:check  # Prettier check
bun run format        # Auto-format
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Entry Points                            │
│                                                              │
│   index.ts (REPL)               run.ts (Bot)                │
│       │                              │                       │
│       ▼                              ▼                       │
│   ┌───────┐                     ┌─────────┐                 │
│   │ Repl  │                     │ grammy  │                 │
│   │       │                     │  Bot    │                 │
│   └───┬───┘                     └────┬────┘                 │
│       │                              │                       │
│       ▼                              ▼                       │
│   ┌─────────────────────────────────────┐                   │
│   │             Agent                    │                   │
│   │  Bun.spawn("claude --print ...")     │                   │
│   │  Retry + Timeout + JSON parsing      │                   │
│   └───────────────┬─────────────────────┘                   │
│                   │                                          │
│       ┌───────────┼───────────┐                             │
│       ▼           ▼           ▼                              │
│  ┌──────────┐ ┌────────────┐ ┌───────────────┐             │
│  │ History  │ │ Session    │ │ Runtime       │             │
│  │ Manager  │ │ Store      │ │ Config        │             │
│  └────┬─────┘ └─────┬──────┘ └──────┬────────┘             │
│       │              │               │                       │
│       ▼              ▼               ▼                       │
│  ┌────────────────────────────────────────────┐             │
│  │            Database (SQLite)                │             │
│  │  sessions │ messages │ attachments          │             │
│  │  telegram │ config   │ jobs │ neo.db (WAL)  │             │
│  └────────────────────────────────────────────┘             │
│                                                              │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌────────┐     │
│  │ ChatQueue │ │ Formatter │ │ Scheduler │ │ Logger │     │
│  └───────────┘ └───────────┘ └───────────┘ └────────┘     │
│  ┌─────────┐ ┌────────┐                                    │
│  │ Whisper │ │ Memory │                                    │
│  └─────────┘ └────────┘                                    │
└──────────────────────────────────────────────────────────────┘
```

### File Structure

```
index.ts             REPL entry point
run.ts               Telegram bot entry point (init, caches, whisper, startup)
src/
  agent.ts           Claude CLI wrapper (spawn, retry, timeout, vision)
  sandbox.ts         Sandbox creation, safety rules, file listing, spawn env
  db-core.ts         Database base class (schema, sessions, messages, attachments, cleanup)
  db.ts              Database extends DatabaseCore (Telegram sessions, config, jobs)
  chat-queue.ts      Per-chat serial message queue
  config.ts          Environment-based configuration with range validation
  formatter.ts       Markdown → Telegram HTML converter + smart chunking
  memory.ts          Conversation memory builder for session context
  mcp-config.ts      MCP server configuration generator
  runtime-config.ts  Runtime config manager (validate, persist, apply via /config)
  scheduler.ts       Job scheduler (croner-based, SQLite-backed)
  history.ts         Session & message persistence (SQLite-backed)
  whisper.ts         Speech-to-text via whisper-cli + ffmpeg
  repl.ts            Interactive terminal with slash commands
  repl-commands.ts   REPL command implementations (pure functions)
  session-store.ts   Telegram chatId → sessionId mapping (SQLite-backed)
  types.ts           All TypeScript interfaces
  logger.ts          Structured logging to stderr
  spinner.ts         Terminal spinner animation
  utils.ts           Duration formatting helper
  index.ts           Barrel re-exports
  telegram/
    handlers.ts      Message handlers with DRY executeWithRetry pattern
    commands.ts      Bot commands (/start, /help, /reset, /stats, /config, etc.)
tests/               283 tests across 17 files
```

### Data Flow

```
User input (REPL or Telegram)
    │
    ▼
ChatQueue.enqueue(chatId)       ← serializes per chat
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
    ├─ INSERT into messages (returns message_id)
    ├─ INSERT into attachments (if photo, with BLOB + file_id)
    ▼
Formatter.formatForTelegram()   ← Markdown → HTML + smart chunk
    │
    ▼
ctx.reply(chunk, { parse_mode: "HTML" })
```

#### Voice Flow

```
Telegram voice/audio message
    │
    ▼
Download OGG → sandbox
    │
    ▼
ffmpeg: OGG Opus → WAV 16kHz mono
    │
    ▼
whisper-cli → timestamped text
    │
    ▼
parseWhisperOutput → clean text
    │
    ▼
Agent.call("[vocale] <text>")
```

### Database Schema

```sql
sessions          (session_id PK, created_at, updated_at)
messages          (id PK, session_id FK, timestamp, prompt, response, duration_ms, input_tokens, output_tokens)
attachments       (id PK, message_id FK, media_type, file_id, data BLOB, created_at)
telegram_sessions (chat_id PK, session_id, updated_at)
runtime_config    (key PK, value, updated_at)
scheduled_jobs    (id PK, chat_id, prompt, schedule_type, cron_expr, run_at, interval_ms, created_at, last_run_at, active)
```

**Indexes:** `idx_messages_session`, `idx_messages_timestamp`, `idx_messages_session_id`, `idx_telegram_sessions_session`, `idx_attachments_message`, `idx_scheduled_jobs_active`, `idx_scheduled_jobs_chat`

Stats are computed via SQL aggregates — no denormalized tables.

## Production

`init.sh` can configure auto-restart:

- **macOS**: launchd service at `~/Library/LaunchAgents/com.claude-agent.telegram.plist`
- **Linux**: systemd user service at `~/.config/systemd/user/claude-agent-telegram.service`

## License

Private project.
