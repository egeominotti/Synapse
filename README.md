<p align="center">
  <img src="docs/logo.svg" alt="Synapse" width="600"/>
</p>

<p align="center">
  <strong>A lightweight alternative to Clawdbot / OpenClaw that runs in containers for security.</strong><br/>
  Connects to Telegram, has memory, scheduled jobs, and runs directly on Anthropic's Agents SDK.<br/>
  <strong>Requires <a href="https://bun.sh">Bun</a> runtime.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000" alt="Bun"/>
  <img src="https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=fff" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/database-SQLite-003b57?logo=sqlite&logoColor=fff" alt="SQLite"/>
  <img src="https://img.shields.io/badge/bot-Telegram-26a5e4?logo=telegram&logoColor=fff" alt="Telegram"/>
  <img src="https://img.shields.io/badge/AI-Claude-d4a574?logo=anthropic&logoColor=fff" alt="Claude"/>
  <a href="https://github.com/egeominotti/bunqueue"><img src="https://img.shields.io/badge/scheduler-bunqueue-ff6b35" alt="bunqueue"/></a>
  <img src="https://img.shields.io/badge/tests-346_passed-brightgreen" alt="Tests"/>
</p>

---

## Features

- **Telegram bot** — multi-chat, voice messages, photos, documents, edited messages
- **Persistent memory** — SQLite WAL, conversations resume across restarts
- **Persistent message queue** — bunqueue-backed queue, messages survive crashes
- **Scheduled jobs** — cron, interval, delay, one-shot via [bunqueue](https://github.com/egeominotti/bunqueue) MCP integration
- **Sandbox isolation** — each agent runs in `/tmp/synapse-agent-*` with safety rules
- **Auto-team** — master decomposes complex tasks, workers execute in parallel
- **Voice-to-text** — Groq API (primary) + local whisper-cli fallback
- **Health monitoring** — DB, Groq, whisper checks every 30s with Telegram alerts
- **Runtime config** — all parameters configurable live via `/config` (admin only)
- **Vision** — photo and document analysis via base64 streaming

## Quick Start

> **Bun is required.** Install it from [bun.sh](https://bun.sh) — Node.js is not supported.

### 1. Install dependencies

```bash
bun install
```

### 2. Get your Claude Code OAuth token

Synapse uses the `@anthropic-ai/claude-agent-sdk` which requires a Claude Code OAuth token:

```bash
# If you haven't installed Claude Code yet:
npm install -g @anthropic-ai/claude-code

# Generate your OAuth token:
claude setup-token
```

This will open a browser for authentication and output a token. Copy it — you'll need it in the next step.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your tokens:

```env
CLAUDE_CODE_OAUTH_TOKEN=<your-token-from-step-2>
TELEGRAM_BOT_TOKEN=<token-from-@BotFather>
TELEGRAM_ADMIN_ID=<your-telegram-chat-id>

# Optional: voice transcription
GROQ_API_KEY=<your-groq-api-key>
```

### 4. Run

```bash
bun run run.ts
```

## Environment Variables

| Variable                      | Required | Default                      | Description                 |
| ----------------------------- | -------- | ---------------------------- | --------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`     | Yes      | —                            | OAuth token for Claude CLI  |
| `TELEGRAM_BOT_TOKEN`          | Yes      | —                            | Telegram bot token          |
| `TELEGRAM_ADMIN_ID`           | No       | —                            | Admin chat ID for `/config` |
| `GROQ_API_KEY`                | No       | —                            | Groq API key for cloud STT  |
| `CLAUDE_AGENT_MAX_CONCURRENT` | No       | `1`                          | Concurrent agents per chat  |
| `CLAUDE_AGENT_DB_PATH`        | No       | `~/.claude-agent/synapse.db` | SQLite database path        |

See [`.env.example`](.env.example) for the full list.

## Telegram Commands

| Command                     | Description                        |
| --------------------------- | ---------------------------------- |
| `/start`                    | Welcome message                    |
| `/help`                     | List all commands                  |
| `/reset`                    | Clear session and start fresh      |
| `/stats`                    | Session and global statistics      |
| `/ping`                     | Bot uptime and status              |
| `/export`                   | Export conversation as Markdown    |
| `/schedule <expr> <prompt>` | Create a scheduled job             |
| `/jobs`                     | List active scheduled jobs         |
| `/prompt <text>`            | Set system prompt (admin)          |
| `/config [key] [value]`     | View/modify runtime config (admin) |

## Architecture

```
Telegram
    │
    ▼
MessageQueue ─── bunqueue (persistent, crash-resilient)
    │
    ▼ (per-chat Semaphore ordering)
AgentPool ─── Master (resume) + N-1 Workers (fresh memory)
    │
Agent ─── @anthropic-ai/claude-agent-sdk query() API
    │
 ┌──┴──┐
 ▼     ▼
History SessionStore ──► SQLite (WAL)
                          ▲
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        RuntimeConfig  Scheduler  HealthMonitor
                      (bunqueue)
```

## Tech Stack

| Component | Technology                                                |
| --------- | --------------------------------------------------------- |
| Runtime   | Bun                                                       |
| Language  | TypeScript (strict)                                       |
| Database  | SQLite via bun:sqlite (WAL)                               |
| Telegram  | grammy                                                    |
| Scheduler | [bunqueue](https://github.com/egeominotti/bunqueue) (MCP) |
| Voice     | Groq API + whisper.cpp                                    |
| Logging   | pino                                                      |
| Testing   | bun:test (346 tests)                                      |
| CI/CD     | GitHub Actions + Husky                                    |

## Development

```bash
bun test              # 346 tests
bun run typecheck     # TypeScript strict check
bun run lint          # ESLint
bun run format        # Prettier
```

## License

Private project.
