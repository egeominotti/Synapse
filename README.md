# Neo - Personal AI Agent System

A multi-agent AI orchestration platform that routes Telegram messages to specialized Claude agents running in isolated Docker containers. Each query spawns an ephemeral container with the Claude Agent SDK, MCP servers, and scoped tool access -- secrets never touch disk.

## Architecture

```
Telegram --> grammy Bot --> Orchestrator --> Container Runner --> Docker Container
                                |                                      |
                           Chat Queue                          Claude Agent SDK
                           (per-chat)                          MCP Servers (in-container)
                                |
                           Agent Router --> General / Coder / Researcher / Sysadmin / SmartHome / DataAnalyst
                                |
                           Event Bus --> Logging + Audit
                                |
                             SQLite (conversations, sessions, audit, cost, memories)
```

**Key differentiators**: 3-tier intelligent routing (explicit command -> regex pattern -> general fallback), 9+ pre-configured MCP servers, Docker isolation with secrets via stdin, per-chat concurrency queue, session persistence for multi-turn conversations.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript 5.8 (strict mode) |
| Runtime | Node.js 22 |
| AI | Claude Agent SDK, Claude Code CLI |
| Bot | grammY (Telegram) |
| Database | SQLite + Drizzle ORM |
| Build | Turborepo (monorepo) |
| Isolation | Docker (ephemeral containers) |
| Validation | Zod |
| Logging | Pino (structured) |

## Monorepo Structure

```
neo/
├── apps/neo/                    # Main entry point (bootstrap)
├── packages/
│   ├── core/                    # @neo/core - Config, DB, events, logger
│   ├── agent/                   # @neo/agent - Orchestrator, router, container runner
│   ├── mcp/                     # @neo/mcp - MCP server registry & configs
│   └── telegram/                # @neo/telegram - grammY bot, handlers, auth
├── container/
│   ├── Dockerfile               # Node 22 + Claude Code CLI + Chromium
│   └── agent-runner/            # In-container entry: stdin -> Agent SDK -> stdout
└── data/                        # Runtime (gitignored): SQLite DB, IPC, logs
```

## Agents

| Agent | Trigger | Tools | Model |
|-------|---------|-------|-------|
| **General** | Default fallback | All + Task (delegates to sub-agents) | configurable |
| **Coder** | `/code`, code/bug/fix/git keywords | Read, Write, Edit, Bash, Glob, Grep | sonnet |
| **Researcher** | `/research`, search/news keywords | WebSearch, WebFetch, Read, Write | sonnet |
| **Sysadmin** | `/sysadmin`, server/docker/ssh keywords | Bash, Read, Write, Edit | sonnet |
| **Smart Home** | `/home`, light/thermostat keywords | Read (+ Home Assistant MCP) | haiku |
| **Data Analyst** | `/data`, sql/query/csv keywords | Read, Write, Bash | sonnet |

## MCP Servers

Configured via `@neo/mcp` registry, passed to containers at runtime:

- **filesystem** - File read/write access
- **git** - Git operations
- **fetch** - HTTP/HTTPS requests
- **github** - GitHub API (requires `GITHUB_TOKEN`)
- **sqlite** - SQLite database queries
- **postgres** - PostgreSQL queries
- **puppeteer** - Browser automation (Chromium)
- **docker** - Container management
- **home-assistant** - Smart home control (requires `HA_TOKEN`)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in: TELEGRAM_BOT_TOKEN, CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY), TELEGRAM_USER_ID

# 3. Build
npm run build

# 4. Build Docker image
docker build -t neo-agent ./container

# 5. Start
npm run dev
```

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | List available commands |
| `/status` | System status (auth, model, Docker image) |
| `/agents` | List available agents |
| `/reset` | Clear session, start new conversation |

## Environment Variables

```bash
# Required
TELEGRAM_BOT_TOKEN=           # From @BotFather
TELEGRAM_USER_ID=             # Your Telegram user ID (auth whitelist)

# Claude auth (one of these)
CLAUDE_CODE_OAUTH_TOKEN=      # Pro/Max subscription (via `claude setup-token`)
ANTHROPIC_API_KEY=            # Pay-per-token

# Optional
GITHUB_TOKEN=                 # For GitHub MCP server
NEO_DOCKER_IMAGE=neo-agent    # Docker image name
NEO_DB_PATH=./data/neo.db     # Database path
LOG_LEVEL=info                # Pino log level
```

## Development

```bash
npm run build            # Build all packages (Turborepo)
npm run dev              # Run in watch mode
npm run typecheck        # TypeScript check (no emit)
npm run lint             # ESLint
npm run lint:fix         # ESLint with auto-fix
npm run format           # Prettier format all
npm run format:check     # Prettier check only
npm run clean            # Remove all dist/
```

Pre-commit hooks (Husky + lint-staged) auto-run ESLint and Prettier on staged files.

## Security

1. **Telegram Auth** - Whitelist-based user/group validation, silent rejection
2. **Secrets via stdin** - API keys passed to containers through stdin, never written to disk
3. **Docker isolation** - Ephemeral containers (`--rm`), resource-limited (2GB RAM, 2 CPUs)
4. **Bash sanitization** - Post-execution hook strips secrets from tool output
5. **Tool permissions** - Per-agent allowlists, configurable deny list

## Database

SQLite with Drizzle ORM, 7 tables:

- **conversations** - Chat metadata, last session tracking
- **messages** - Full conversation history with cost/duration
- **sessions** - Claude Agent SDK session persistence
- **audit_log** - Tool usage audit trail
- **scheduled_tasks** - Cron-based task scheduler
- **memories** - User preferences and context
- **cost_tracking** - Per-session token/cost analytics

## How It Works

1. User sends a Telegram message
2. Auth middleware validates against whitelist
3. `AgentRouter` determines the best agent (3-tier: command -> pattern -> general)
4. `ChatQueue` ensures sequential processing per chat
5. `ContainerRunner` spawns an ephemeral Docker container
6. Payload (prompt, system prompt, tools, MCP configs, secrets) sent via stdin
7. Inside the container, `agent-runner` calls Claude Agent SDK `query()`
8. Result extracted from stdout via sentinel markers
9. Session saved for conversation continuity
10. Response formatted as MarkdownV2 and sent back via Telegram
