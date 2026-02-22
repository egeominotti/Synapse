# CLAUDE.md - Project Instructions for Claude

## Project Overview

Neo is a personal AI agent system: a TypeScript monorepo that orchestrates Claude agents via Telegram. Each user query spawns an isolated Docker container running the Claude Agent SDK with MCP servers and scoped tools. The host process handles Telegram, routing, queuing, and persistence.

## Tech Stack

- **TypeScript 5.8** (strict mode, ES2022 target, NodeNext modules)
- **Node.js 22** runtime
- **Turborepo** monorepo with npm workspaces
- **grammY** for Telegram bot
- **Drizzle ORM** + **better-sqlite3** for persistence
- **Zod** for config/schema validation
- **Pino** for structured logging
- **Docker** for agent container isolation
- **Claude Agent SDK** (inside containers)

## Monorepo Layout

```
apps/neo/src/index.ts              # Bootstrap entry point
packages/core/src/                 # @neo/core: config, db, events, logger
packages/agent/src/                # @neo/agent: orchestrator, router, container-runner, queue, sessions
packages/agent/src/agents/         # Agent definitions (general, coder, researcher, sysadmin, smart-home, data-analyst)
packages/mcp/src/                  # @neo/mcp: MCP server registry and config factories
packages/telegram/src/             # @neo/telegram: bot, handlers, auth middleware, formatters
container/agent-runner/src/        # Runs inside Docker: reads stdin, calls Agent SDK, writes stdout
container/Dockerfile               # Node 22-slim + Claude Code CLI + Chromium
data/                              # Runtime: neo.db, ipc/, logs/ (gitignored)
```

## Key Architecture Concepts

- **Orchestrator** (`packages/agent/src/orchestrator.ts`): The hub. Routes messages -> spawns containers -> returns responses.
- **AgentRouter** (`packages/agent/src/router.ts`): 3-tier routing: explicit `/command` -> regex pattern matching -> general fallback.
- **ContainerRunner** (`packages/agent/src/container-runner.ts`): Spawns Docker containers, passes payload via stdin (secrets never on disk), parses stdout with sentinel markers (`---NEO-RESULT-START---` / `---NEO-RESULT-END---`).
- **ChatQueue** (`packages/agent/src/queue.ts`): Per-chat concurrency queue, max N concurrent agents.
- **SessionManager** (`packages/agent/src/session-manager.ts`): Persists Claude session IDs in SQLite for conversation continuity.
- **McpRegistry** (`packages/mcp/src/registry.ts`): Dynamically initializes MCP server configs based on feature flags.
- **NeoEventBus** (`packages/core/src/events/bus.ts`): Typed EventEmitter for loose coupling (message:received, agent:completed, tool:used, etc.).

## Build & Run

```bash
npm run build          # Turborepo: builds all packages (respects dependency graph)
npm run dev            # Dev mode with tsx watch (@neo/app)
npm run typecheck      # tsc --noEmit across all packages
npm run lint           # ESLint
npm run lint:fix       # ESLint --fix
npm run format         # Prettier --write
npm run format:check   # Prettier --check
npm run clean          # Remove all dist/
```

## Code Style

- **Formatter**: Prettier (100 char width, 2-space indent, double quotes, trailing commas, semicolons)
- **Linter**: ESLint + typescript-eslint + eslint-config-prettier
- **Rules**:
  - `@typescript-eslint/no-unused-vars`: error (prefix unused args with `_`)
  - `@typescript-eslint/no-explicit-any`: warn
  - `@typescript-eslint/consistent-type-imports`: error (use `import type` for type-only imports)
  - `no-console`: warn (console.error and console.warn allowed)
- **Pre-commit**: Husky + lint-staged auto-runs ESLint fix + Prettier on staged `.ts/.tsx` files
- **Ignores**: `dist/`, `node_modules/`, `data/`

## Database

SQLite via Drizzle ORM at `data/neo.db`. Schema in `packages/core/src/db/schema.ts`. 7 tables:
- `conversations`, `messages`, `sessions`, `audit_log`, `scheduled_tasks`, `memories`, `cost_tracking`

Query helpers in `packages/core/src/db/queries.ts`. WAL mode enabled.

## Config

Zod-validated config in `packages/core/src/config.ts` (`NeoConfigSchema`). Sections: `telegram`, `claude`, `mcp`, `docker`, `database`, `security`. Loaded from environment variables.

## Patterns to Follow

- Use **factory functions** for creating instances (`createBot()`, `createDb()`, `createLogger()`, `createQueries()`)
- Use **Zod** for all config and external data validation
- Use **barrel exports** (`index.ts`) in each package
- Use **typed events** via `NeoEventBus` for cross-module communication
- Prefix unused parameters with `_`
- Use `import type` for type-only imports
- Keep packages loosely coupled; `@neo/core` is the only shared dependency
- All workspace packages extend `tsconfig.base.json`
- Each package has `build`, `dev`, `clean`, `typecheck` scripts

## Security Model

1. Secrets passed to containers via stdin only, never written to disk
2. Docker containers are ephemeral (`--rm`), resource-limited
3. Per-agent tool allowlists (defined in `packages/agent/src/agents/definitions.ts`)
4. Telegram whitelist auth middleware
5. Audit logging of all tool usage in SQLite

## File Naming

- Source files: `kebab-case.ts`
- Packages: `@neo/<name>`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE` for sentinels and env vars

## Dependencies Between Packages

```
@neo/app -> @neo/core, @neo/agent, @neo/mcp, @neo/telegram
@neo/agent -> @neo/core
@neo/mcp -> @neo/core
@neo/telegram -> @neo/core, @neo/agent
agent-runner -> @anthropic-ai/claude-agent-sdk (standalone, runs in Docker)
```
