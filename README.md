# Neo

AI agent powered by Claude Code CLI with two interfaces: interactive REPL and Telegram bot.

## Features

- **REPL** — Terminal interface with slash commands, multiline input, vision support, session persistence
- **Telegram Bot** — Multi-user bot with per-chat sessions, photo analysis, auto-restart
- **Session Management** — Conversations persist to disk and resume across restarts
- **Vision** — Send images via `/image` (REPL) or photo messages (Telegram)
- **Retry & Timeout** — Exponential backoff on transient errors, configurable timeout
- **Docker Isolation** — Optional containerized execution with resource limits

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
| `CLAUDE_AGENT_HISTORY_DIR` | No | `~/.claude-agent/history` | Session storage path |
| `CLAUDE_AGENT_LOG_LEVEL` | No | `INFO` | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` |
| `CLAUDE_AGENT_SKIP_PERMISSIONS` | No | `1` | Skip CLI permission prompts |
| `CLAUDE_AGENT_DOCKER` | No | `0` | Run in Docker containers |
| `CLAUDE_AGENT_DOCKER_IMAGE` | No | `claude-agent:latest` | Docker image name |
| `CLAUDE_TELEGRAM_SESSION_FILE` | No | `~/.claude-agent/telegram-sessions.json` | Bot session file |

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

## Architecture

```
index.ts           REPL entry point
telegram.ts        Telegram bot entry point
src/
  agent.ts         Claude CLI wrapper (spawn, retry, timeout, vision)
  config.ts        Environment-based configuration
  history.ts       Session persistence (per-session JSON files)
  repl.ts          Interactive terminal with slash commands
  session-store.ts Telegram chatId → sessionId mapping
  types.ts         TypeScript interfaces
  logger.ts        Structured logging to stderr
  spinner.ts       Terminal spinner animation
  utils.ts         Duration formatting
  index.ts         Public re-exports
```

The agent spawns `claude` CLI as a subprocess for each request, parsing JSON responses and extracting session IDs for conversation continuity. No external Claude SDK — direct CLI integration.

## Production

`init.sh` can configure auto-restart:

- **macOS**: launchd service at `~/Library/LaunchAgents/com.claude-agent.telegram.plist`
- **Linux**: systemd user service at `~/.config/systemd/user/claude-agent-telegram.service`

## License

Private project.
