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

## MCP Servers (64 available)

Configured via `@neo/mcp` registry, passed to containers at runtime. Enable any combination in config.

### Filesystem & Files
| Server | Package | Description |
|--------|---------|-------------|
| `filesystem` | `@modelcontextprotocol/server-filesystem` | File read/write access with scoped paths |

### Version Control
| Server | Package | Description |
|--------|---------|-------------|
| `git` | `@modelcontextprotocol/server-git` | Git operations |
| `github` | `@modelcontextprotocol/server-github` | GitHub API (requires `GITHUB_TOKEN`) |
| `gitlab` | `@dubuqingfeng/gitlab-mcp-server` | GitLab repos, MRs, pipelines (requires `GITLAB_TOKEN`) |

### Web & HTTP
| Server | Package | Description |
|--------|---------|-------------|
| `fetch` | `@anthropic-ai/mcp-server-fetch` | HTTP/HTTPS requests |
| `firecrawl` | `firecrawl-mcp` | Advanced web scraping & crawling (requires `FIRECRAWL_API_KEY`) |

### Web Search
| Server | Package | Description |
|--------|---------|-------------|
| `brave-search` | `@brave/brave-search-mcp-server` | Brave web/news/image search (requires `BRAVE_API_KEY`) |
| `tavily` | `tavily-mcp` | AI-optimized search, extract & crawl (requires `TAVILY_API_KEY`) |
| `exa` | `exa-mcp-server` | Neural/semantic web search (requires `EXA_API_KEY`) |
| `perplexity` | `@nicepkg/mcp-server-perplexity` | AI-powered search with reasoning (requires `PERPLEXITY_API_KEY`) |

### Thinking & Memory
| Server | Package | Description |
|--------|---------|-------------|
| `memory` | `@modelcontextprotocol/server-memory` | Persistent knowledge graph memory |
| `sequential-thinking` | `@modelcontextprotocol/server-sequential-thinking` | Structured multi-step reasoning |

### Browser Automation
| Server | Package | Description |
|--------|---------|-------------|
| `puppeteer` | `@modelcontextprotocol/server-puppeteer` | Chromium browser automation |
| `playwright` | `@playwright/mcp` | Microsoft Playwright - accessibility-based automation |
| `browserbase` | `@browserbasehq/mcp` | Cloud-hosted browser sessions at scale |

### Databases: SQL
| Server | Package | Description |
|--------|---------|-------------|
| `sqlite` | `@modelcontextprotocol/server-sqlite` | SQLite queries |
| `postgres` | `@modelcontextprotocol/server-postgres` | PostgreSQL queries |
| `mysql` | `@benborla29/mcp-server-mysql` | MySQL queries |

### Databases: NoSQL
| Server | Package | Description |
|--------|---------|-------------|
| `mongodb` | `mongodb-mcp-server` | MongoDB CRUD, aggregation, vector search |
| `redis` | `@redis/mcp` | Redis data, Pub/Sub, JSON, vector search |
| `elasticsearch` | `@elastic/mcp-server-elasticsearch` | Elasticsearch search & indexing |

### Databases: Graph
| Server | Package | Description |
|--------|---------|-------------|
| `neo4j` | `@neo4j/mcp-neo4j` | Neo4j graph queries & knowledge graphs |

### Databases: Vector
| Server | Package | Description |
|--------|---------|-------------|
| `qdrant` | `mcp-server-qdrant` | Qdrant vector search |
| `chromadb` | `chroma-mcp` | ChromaDB semantic document search |
| `pinecone` | `mcp-pinecone` | Pinecone vector search |
| `milvus` | `mcp-server-milvus` | Milvus/Zilliz vector database |
| `weaviate` | `mcp-server-weaviate` | Weaviate vector operations |

### Containers & Orchestration
| Server | Package | Description |
|--------|---------|-------------|
| `docker` | `@modelcontextprotocol/server-docker` | Docker container management |
| `kubernetes` | `mcp-server-kubernetes` | K8s pods, deployments, services, logs |

### Cloud Providers
| Server | Package | Description |
|--------|---------|-------------|
| `aws` | `@awslabs/mcp` | AWS - S3, Lambda, DynamoDB, CloudWatch, 60+ tools |
| `cloudflare` | `mcp-server-cloudflare` | CDN, DNS, Workers, R2, KV |

### Infrastructure as Code
| Server | Package | Description |
|--------|---------|-------------|
| `terraform` | `terraform-mcp-server` | HashiCorp Terraform plan/apply |

### Monitoring & Observability
| Server | Package | Description |
|--------|---------|-------------|
| `grafana` | `mcp-grafana` | Prometheus/Loki queries, dashboards, alerts |
| `sentry` | `@sentry/mcp-server` | Error tracking, stack traces, issues |
| `prometheus` | `mcp-server-prometheus` | PromQL queries, alerting rules |

### Code Quality & Development
| Server | Package | Description |
|--------|---------|-------------|
| `eslint` | `@eslint/mcp` | Lint code, rule explanations, auto-fix |
| `semgrep` | `semgrep-mcp` | Static analysis security scanning (5000+ rules) |
| `context7` | `@upstash/context7-mcp` | Up-to-date library docs in LLM context |

### Deployment Platforms
| Server | Package | Description |
|--------|---------|-------------|
| `vercel` | `mcp-server-vercel` | Vercel deployments & project management |
| `netlify` | `@netlify/mcp` | Netlify site management & deploys |

### Security
| Server | Package | Description |
|--------|---------|-------------|
| `snyk` | `snyk-mcp` | Dependency vulnerability scanning |
| `nmap` | `nmap-mcp-server` | Network reconnaissance & port scanning |

### Communication: Chat & Messaging
| Server | Package | Description |
|--------|---------|-------------|
| `slack` | `@modelcontextprotocol/server-slack` | Slack messages, channels, search |
| `discord` | `mcp-discord` | Discord server interaction |
| `twitter` | `@barresider/x-mcp` | X/Twitter post, search, manage account |
| `whatsapp` | `whatsapp-mcp` | WhatsApp messaging |

### Communication: Email
| Server | Package | Description |
|--------|---------|-------------|
| `email` | `email-mcp` | IMAP/SMTP - 42 tools, multi-account, AI triage, scheduling |

### Communication: Apple Ecosystem
| Server | Package | Description |
|--------|---------|-------------|
| `imessage` | `mac-messages-mcp` | iMessage read/send, contacts, group chats, attachments |

### Productivity & Notes
| Server | Package | Description |
|--------|---------|-------------|
| `notion` | `notion-mcp` | Notion pages, databases, tasks |
| `google-workspace` | `mcp-google-workspace` | Gmail + Google Calendar |
| `google-calendar` | `mcp-server-google-calendar` | Google Calendar events |
| `linear` | Remote MCP via `mcp-remote` | Linear issue tracking, cycles, projects |
| `todoist` | `todoist-mcp-server` | Natural language task management |
| `obsidian` | `obsidian-mcp` | Obsidian vault read/write/search |
| `trello` | `mcp-server-trello` | Trello boards, lists, cards |
| `jira` | `mcp-server-jira` | Jira issues, sprints, projects |

### Smart Home & IoT
| Server | Package | Description |
|--------|---------|-------------|
| `home-assistant` | `homeassistant-mcp` | Home automation (requires `HA_TOKEN`) |

### Data Analysis & Code Execution
| Server | Package | Description |
|--------|---------|-------------|
| `jupyter` | `jupyter-mcp-server` | Execute code in Jupyter, persistent state |
| `e2b` | `@e2b/mcp-server` | Sandboxed Python/JS execution in cloud |

### Academic Research
| Server | Package | Description |
|--------|---------|-------------|
| `paper-search` | `paper-search-mcp` | Search arXiv, PubMed, Google Scholar, Semantic Scholar |
| `arxiv` | `arxiv-mcp-server` | arXiv paper search & analysis |

### Social Media & Content
| Server | Package | Description |
|--------|---------|-------------|
| `hacker-news` | `mcp-hacker-news` | HN top stories, comments, search |
| `reddit` | `mcp-reddit` | Reddit posts, comments, subreddits |
| `youtube-transcript` | `mcp-server-youtube-transcript` | Extract YouTube video transcripts |

### macOS Native
| Server | Package | Description |
|--------|---------|-------------|
| `apple-shortcuts` | `mcp-server-apple-shortcuts` | Trigger Apple Shortcuts automations |
| `apple-reminders` | `mcp-server-apple-reminders` | Apple Reminders access |
| `apple-notes` | `apple-notes-mcp` | Apple Notes search & create |
| `apple-health` | `apple-health-mcp-server` | Apple Health data (steps, heart rate, sleep) |

### Maps & Location
| Server | Package | Description |
|--------|---------|-------------|
| `google-maps` | `@googlemaps/code-assist-mcp` | Location search, directions, geocoding |

### Utilities
| Server | Package | Description |
|--------|---------|-------------|
| `time` | `@modelcontextprotocol/server-time` | Time & timezone conversion |

### Image & Media Generation
| Server | Package | Description |
|--------|---------|-------------|
| `stability-ai` | `mcp-server-stability-ai` | Stability AI image generation & editing |
| `dall-e` | `mcp-server-dall-e` | DALL-E 3 image generation |

### Workflow Automation
| Server | Package | Description |
|--------|---------|-------------|
| `n8n` | `n8n-mcp` | n8n workflow builder (1236 automation nodes) |

### Data Aggregators
| Server | Package | Description |
|--------|---------|-------------|
| `anyquery` | `anyquery-mcp` | SQL queries across 40+ apps (Notion, Airtable, GitHub...) |

### File Conversion
| Server | Package | Description |
|--------|---------|-------------|
| `markitdown` | `mcp-server-markitdown` | Convert documents to Markdown |
| `pandoc` | `mcp-server-pandoc` | Universal document conversion |

### Cloud Storage
| Server | Package | Description |
|--------|---------|-------------|
| `s3` | `mcp-server-s3` | AWS S3 bucket operations |
| `google-drive` | `@anthropic-ai/mcp-server-google-drive` | Google Drive file access |

### CI/CD
| Server | Package | Description |
|--------|---------|-------------|
| `github-actions` | `mcp-server-github-actions` | GitHub Actions workflow management |

### CMS
| Server | Package | Description |
|--------|---------|-------------|
| `wordpress` | `mcp-server-wordpress` | WordPress content management |

### Package Managers
| Server | Package | Description |
|--------|---------|-------------|
| `npm` | `mcp-server-npm` | npm package search & info |

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
