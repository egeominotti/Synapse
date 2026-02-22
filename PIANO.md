# Neo - Personal AI Agent System

## Context

Costruire un sistema di agenti AI personale che migliora OpenClaw e NanoClaw. NanoClaw spawna un container Docker per ogni messaggio ma ha solo WhatsApp, zero UI, e MCP limitato. Neo mantiene l'isolamento Docker come NanoClaw, ma usa Telegram, aggiunge un sistema multi-agente con routing intelligente, e MCP ricchi out-of-the-box.

**Stack**: TypeScript, Node.js, Claude Agent SDK, grammY (Telegram), Docker (isolamento agenti), SQLite (Drizzle ORM)
**Auth**: Claude Pro/Max via `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN)

---

## Architettura

```
Telegram ──→ grammY Bot ──→ Orchestrator ──→ Container Runner ──→ Docker Container
                                 │                                      │
                            Chat Queue                          Claude Agent SDK + Claude Code
                            (per-chat)                          MCP Servers (in-container)
                                 │
                            Agent Router ──→ General / Coder / Researcher / Sysadmin / SmartHome / DataAnalyst
                                 │
                            Event Bus ──→ Logging + Audit
                                 │
                              SQLite (conversations, sessions, audit, tasks, memories)
```

**Architettura Docker**: Il processo host (Node.js) gestisce Telegram, routing, coda. Per ogni query, spawna un container Docker isolato con Claude Agent SDK + Claude Code dentro. Simile a NanoClaw ma con multi-agente e MCP ricchi.

**Differenze chiave vs NanoClaw**:
- Multi-agente con router a 3 livelli (comando esplicito → regex → LLM fallback)
- 9+ MCP servers pre-configurati (vs 1 in NanoClaw)
- Telegram (vs WhatsApp)
- Inline keyboard per approvazioni tool
- Secrets via stdin (come NanoClaw) - mai su disco

---

## Struttura Monorepo

```
neo/
├── neo.config.ts                    # Config unificata (Zod-validated)
├── .env                             # Secrets (gitignored)
├── turbo.json                       # Turborepo pipeline
├── CLAUDE.md                        # Istruzioni progetto per Claude
│
├── container/
│   ├── Dockerfile                   # Node 22 + Claude Code CLI + Chromium
│   └── agent-runner/
│       ├── package.json
│       └── src/
│           ├── index.ts             # Entry point: legge stdin, esegue query(), scrive stdout
│           ├── ipc.ts               # Polling IPC filesystem-based (JSON files)
│           └── hooks.ts             # Audit hook + bash sanitization (strip secrets)
│
├── packages/
│   ├── core/                        # @neo/core - DB, eventi, config, tipi, logging
│   │   └── src/
│   │       ├── index.ts             # Barrel export
│   │       ├── config.ts            # Schema Zod + loader
│   │       ├── db/
│   │       │   ├── index.ts         # init DB + migrazioni
│   │       │   ├── schema.ts        # 7 tabelle Drizzle
│   │       │   └── queries.ts       # Query helpers tipizzate
│   │       ├── events/
│   │       │   ├── bus.ts           # EventEmitter tipizzato
│   │       │   └── types.ts         # NeoEventMap (tutti gli eventi)
│   │       ├── logger.ts            # Pino structured logging
│   │       └── secrets.ts           # Gestione secrets
│   │
│   ├── agent/                       # @neo/agent - Orchestrazione Claude
│   │   └── src/
│   │       ├── index.ts
│   │       ├── orchestrator.ts      # CUORE: prompt → container-runner → risposta
│   │       ├── container-runner.ts  # Spawna container Docker, passa secrets via stdin
│   │       ├── router.ts            # Routing 3-tier
│   │       ├── queue.ts             # Coda per-chat (max N concurrent)
│   │       ├── session-manager.ts   # Persistenza sessioni Claude
│   │       ├── agents/
│   │       │   ├── index.ts         # Registry agenti
│   │       │   ├── definitions.ts   # 6 AgentConfig completi
│   │       │   ├── general.ts       # Agente generale (ha tutti i subagenti)
│   │       │   ├── coder.ts         # Agente sviluppatore
│   │       │   ├── researcher.ts    # Agente ricercatore
│   │       │   ├── sysadmin.ts      # Agente sysadmin
│   │       │   ├── smart-home.ts    # Agente domotica
│   │       │   └── data-analyst.ts  # Agente analisi dati
│   │       ├── hooks/
│   │       │   ├── audit.ts         # Log ogni tool call in audit_log
│   │       │   ├── notification.ts  # Notifiche Telegram per eventi importanti
│   │       │   ├── permission.ts    # Enforcement permessi PreToolUse
│   │       │   └── cost-tracking.ts # Tracking costi per sessione
│   │       └── permissions/
│   │           ├── index.ts         # canUseTool implementation
│   │           └── policies.ts      # Policy per tipo agente
│   │
│   ├── mcp/                         # @neo/mcp - Config MCP servers (passati al container)
│   │   └── src/
│   │       ├── index.ts
│   │       ├── registry.ts          # Genera config MCP per ogni agente
│   │       └── configs/
│   │           ├── index.ts         # Re-export tutte le factory
│   │           ├── filesystem.ts    # @modelcontextprotocol/server-filesystem
│   │           ├── git.ts           # @modelcontextprotocol/server-git
│   │           ├── postgres.ts      # @modelcontextprotocol/server-postgres
│   │           ├── sqlite.ts        # @modelcontextprotocol/server-sqlite
│   │           ├── puppeteer.ts     # @modelcontextprotocol/server-puppeteer
│   │           ├── fetch.ts         # @modelcontextprotocol/server-fetch
│   │           ├── github.ts        # GitHub MCP
│   │           ├── docker.ts        # Docker MCP
│   │           └── home-assistant.ts # Home Assistant MCP
│   │
│   └── telegram/                    # @neo/telegram - Bot Telegram
│       └── src/
│           ├── index.ts
│           ├── bot.ts               # grammY setup + middleware stack
│           ├── handlers/
│           │   ├── index.ts
│           │   ├── message.ts       # Testo → orchestrator → risposta MarkdownV2
│           │   ├── command.ts       # /start, /help, /status, /agents, /reset
│           │   ├── callback.ts      # Inline keyboard callback
│           │   ├── file.ts          # Upload/download file
│           │   └── group.ts         # Gestione gruppi
│           ├── middleware/
│           │   ├── auth.ts          # Whitelist utenti/gruppi
│           │   ├── rate-limit.ts    # Rate limiting
│           │   ├── logging.ts       # Emit eventi
│           │   └── typing.ts        # Typing indicator automatico
│           ├── formatters/
│           │   ├── markdown.ts      # Escape MarkdownV2 per output AI
│           │   ├── code.ts          # Code block formatting
│           │   └── truncate.ts      # Split messaggi > 4096 char
│           ├── keyboards/
│           │   ├── approval.ts      # Inline keyboard approvazione tool
│           │   ├── agent-select.ts  # Selezione agente
│           │   └── task-actions.ts  # Gestione task
│           └── session.ts           # SQLite session storage per grammY
│
├── apps/
│   └── neo/                         # Entry point principale
│       └── src/
│           ├── index.ts             # Bootstrap: wira tutti i moduli, avvia
│           └── shutdown.ts          # Graceful shutdown + cleanup containers
│
└── data/                            # Runtime (gitignored)
    ├── neo.db                       # SQLite database
    ├── ipc/                         # IPC files per container (JSON)
    └── logs/                        # Log strutturati
```

---

## Componenti Core - Dettagli Tecnici

### 1. Orchestrator (`packages/agent/src/orchestrator.ts`)

Il cuore del sistema. Riceve un messaggio, lo instrada all'agente giusto, spawna un container Docker, e ritorna la risposta.

```typescript
export interface QueryRequest {
  chatId: number;
  userId: number;
  text: string;
  replyToSessionId?: string;
}

export interface QueryResponse {
  text: string;
  sessionId: string;
  agentType: string;
  costUsd: number;
  durationMs: number;
}

export class Orchestrator {
  constructor(
    private config: NeoConfig,
    private events: NeoEventBus,
    private router: AgentRouter,
    private sessions: SessionManager,
    private mcpRegistry: McpServerRegistry,
    private containerRunner: ContainerRunner,
    private chatQueue: ChatQueue,
  ) {}

  async handleMessage(request: QueryRequest): Promise<QueryResponse> {
    return this.chatQueue.enqueue(request.chatId, () =>
      this.executeQuery(request)
    );
  }

  private async executeQuery(request: QueryRequest): Promise<QueryResponse> {
    const routing = await this.router.route(request);
    const sessionId = request.replyToSessionId
      ?? await this.sessions.getActiveSession(request.chatId);

    // Costruisci payload per il container
    const containerPayload = {
      prompt: request.text,
      systemPrompt: routing.systemPrompt,
      agents: routing.agents,
      allowedTools: routing.allowedTools,
      mcpServers: this.mcpRegistry.getConfigsForAgent(routing.primaryAgent),
      maxTurns: this.config.claude.maxTurns,
      model: routing.model ?? this.config.claude.defaultModel,
      sessionId,
      secrets: this.buildSecrets(),  // passati via stdin, mai su disco
    };

    // Spawna container e attendi risposta
    const result = await this.containerRunner.run(containerPayload);

    await this.sessions.saveSession(request.chatId, result.sessionId);
    this.events.emit("agent:completed", {
      sessionId: result.sessionId,
      agentType: routing.primaryAgent,
      result: result.text,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
    });

    return { text: result.text, sessionId: result.sessionId, agentType: routing.primaryAgent, costUsd: result.costUsd, durationMs: result.durationMs };
  }

  private buildSecrets(): Record<string, string> {
    const secrets: Record<string, string> = {};
    if (this.config.claude.authMethod === "oauth" && this.config.claude.oauthToken) {
      secrets.CLAUDE_CODE_OAUTH_TOKEN = this.config.claude.oauthToken;
    } else if (this.config.claude.apiKey) {
      secrets.ANTHROPIC_API_KEY = this.config.claude.apiKey;
    }
    return secrets;
  }
}
```

### 1b. Container Runner (`packages/agent/src/container-runner.ts`)

Spawna un container Docker per ogni query. Passa secrets via stdin, legge output da stdout.

```typescript
import { spawn } from "child_process";

const SENTINEL_START = "---NEO-RESULT-START---";
const SENTINEL_END = "---NEO-RESULT-END---";

export class ContainerRunner {
  constructor(private config: NeoConfig) {}

  async run(payload: ContainerPayload): Promise<ContainerResult> {
    const args = [
      "run", "--rm", "-i",
      "--name", `neo-${Date.now()}`,
      // Volume mounts
      "-v", `${this.config.workspacePath}:/workspace:rw`,
      "-v", `${this.config.ipcPath}:/ipc:rw`,
      // Resource limits
      "--memory", "2g",
      "--cpus", "2",
      // Image
      "neo-agent",
    ];

    const proc = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });

    // Passa payload (inclusi secrets) via stdin - mai su disco
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();

    // Leggi stdout e cerca sentinel markers
    let stdout = "";
    for await (const chunk of proc.stdout) {
      stdout += chunk.toString();
    }

    // Parse risultato tra i sentinel markers
    const startIdx = stdout.indexOf(SENTINEL_START);
    const endIdx = stdout.indexOf(SENTINEL_END);
    if (startIdx === -1 || endIdx === -1) throw new Error("Container output malformed");

    const resultJson = stdout.slice(startIdx + SENTINEL_START.length, endIdx);
    return JSON.parse(resultJson);
  }
}
```

### 1c. Agent Runner (dentro il container) (`container/agent-runner/src/index.ts`)

Gira dentro il container Docker. Legge il payload da stdin, esegue `query()` dell'Agent SDK, scrive il risultato su stdout.

```typescript
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

const SENTINEL_START = "---NEO-RESULT-START---";
const SENTINEL_END = "---NEO-RESULT-END---";

async function main() {
  // 1. Leggi payload da stdin
  const input = await readStdin();
  const payload = JSON.parse(input);

  // 2. Imposta secrets come env vars (solo in-memory, container e' effimero)
  for (const [key, value] of Object.entries(payload.secrets)) {
    process.env[key] = value as string;
  }

  // 3. Costruisci Options per Agent SDK
  const options: Options = {
    systemPrompt: payload.systemPrompt,
    agents: payload.agents,
    allowedTools: payload.allowedTools,
    mcpServers: payload.mcpServers,
    maxTurns: payload.maxTurns,
    model: payload.model,
    permissionMode: "default",
    env: payload.secrets,
    hooks: {
      PostToolUse: [sanitizeBashHook(Object.values(payload.secrets))],
    },
    ...(payload.sessionId ? { resume: payload.sessionId } : {}),
  };

  // 4. Esegui query
  let resultText = "";
  let sessionId = "";
  let costUsd = 0;
  let durationMs = 0;
  let numTurns = 0;

  for await (const message of query({ prompt: payload.prompt, options })) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    }
    if (message.type === "result") {
      resultText = message.result ?? "";
      costUsd = message.total_cost_usd;
      durationMs = message.duration_ms;
      numTurns = message.num_turns;
    }
  }

  // 5. Scrivi risultato su stdout con sentinel markers
  const result = { text: resultText, sessionId, costUsd, durationMs, numTurns };
  process.stdout.write(SENTINEL_START + JSON.stringify(result) + SENTINEL_END);
}

// Hook che strippa secrets dall'output dei comandi bash
function sanitizeBashHook(secrets: string[]) {
  return async (event: any) => {
    if (event.tool_name === "Bash" && event.output) {
      let output = event.output;
      for (const secret of secrets) {
        output = output.replaceAll(secret, "[REDACTED]");
      }
      event.output = output;
    }
  };
}

main().catch(console.error);
```

### 2. Agent Router (`packages/agent/src/router.ts`)

3 livelli di routing, dal piu' specifico al piu' generico:

```typescript
export class AgentRouter {
  private patterns = [
    { regex: /\b(code|bug|fix|refactor|implement|test|deploy|git|commit|pr)\b/i, agentKey: "coder", priority: 10 },
    { regex: /\b(server|docker|container|nginx|ssh|process|port|systemctl)\b/i, agentKey: "sysadmin", priority: 9 },
    { regex: /\b(light|thermostat|temperature|lock|camera|sensor|home|room)\b/i, agentKey: "smart-home", priority: 9 },
    { regex: /\b(search|find|research|look up|what is|latest|news)\b/i, agentKey: "researcher", priority: 8 },
    { regex: /\b(query|database|sql|table|analyze|data|csv|report)\b/i, agentKey: "data-analyst", priority: 8 },
  ];

  async route(request: QueryRequest): Promise<RoutingDecision> {
    // Tier 1: Comando esplicito (/code, /research, etc.)
    const cmdMatch = request.text.match(/^\/(\w+)\s/);
    if (cmdMatch && agentRegistry[cmdMatch[1]]) return this.buildDecision(cmdMatch[1]);

    // Tier 2: Pattern matching con priorita'
    let best: { agentKey: string; priority: number } | null = null;
    for (const p of this.patterns) {
      if (p.regex.test(request.text) && (!best || p.priority > best.priority)) {
        best = { agentKey: p.agentKey, priority: p.priority };
      }
    }
    if (best) return this.buildDecision(best.agentKey);

    // Tier 3: Agente "general" con tutti i subagenti (Claude decide)
    return this.buildDecision("general");
  }
}
```

### 3. Agent Definitions (`packages/agent/src/agents/definitions.ts`)

```typescript
export const agentRegistry: Record<string, AgentConfig> = {
  general: {
    systemPrompt: `You are Neo, a personal AI assistant. You have specialized sub-agents:
- coder: code, debugging, git
- researcher: web search, information
- sysadmin: servers, Docker, deployments
- smart-home: home automation (Home Assistant)
- data-analyst: SQL, data analysis
Delegate to specialists via the Task tool when appropriate.`,
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Task"],
    subagents: {
      coder: {
        description: "Expert software engineer for coding tasks",
        prompt: "You are an expert software engineer...",
        tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        model: "sonnet",
      },
      researcher: {
        description: "Research specialist for finding information",
        prompt: "You are a research specialist...",
        tools: ["WebSearch", "WebFetch", "Read", "Write"],
        model: "sonnet",
      },
      sysadmin: {
        description: "System administrator for infrastructure",
        prompt: "You are a senior system administrator...",
        tools: ["Bash", "Read", "Write", "Edit"],
        model: "sonnet",
      },
      "smart-home": {
        description: "Home automation controller via Home Assistant",
        prompt: "You are a home automation specialist...",
        tools: ["Read"],
        model: "haiku",
      },
      "data-analyst": {
        description: "Data analyst for SQL and data exploration",
        prompt: "You are a data analyst...",
        tools: ["Read", "Write", "Bash"],
        model: "sonnet",
      },
    },
  },
  // + versioni standalone per selezione esplicita via /command
  coder: { /* ... */ },
  researcher: { /* ... */ },
  sysadmin: { /* ... */ },
  "smart-home": { /* ... */ },
  "data-analyst": { /* ... */ },
};
```

### 4. MCP Registry (`packages/mcp/src/registry.ts`)

3 categorie di server MCP:

```typescript
export class McpServerRegistry {
  async initialize(): Promise<void> {
    // A) In-process SDK servers (sempre attivi, zero latency)
    this.servers.set("neo", createNeoToolsServer(this.config, this.events));
    this.servers.set("memory", createMemoryServer(this.config));
    this.servers.set("scheduler", createSchedulerServer(this.config, this.events));

    // B) Ufficiali stdio (condizionali, da neo.config.ts)
    // filesystem, git, postgres, sqlite, puppeteer, fetch

    // C) Community (condizionali)
    // github, docker, home-assistant
  }

  getActiveConfigs(): Record<string, McpServerConfig> {
    // Ritorna tutti i server attivi nel formato richiesto dal SDK
  }
}
```

### 5. Custom MCP Tools (`packages/mcp/src/servers/neo-tools.ts`)

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

export function createNeoToolsServer(config, events) {
  return createSdkMcpServer({
    name: "neo",
    version: "1.0.0",
    tools: [
      tool("send_telegram_message", "Send a message to a Telegram chat",
        { chatId: z.number(), text: z.string() },
        async (args) => { events.emit("message:response", { chatId: args.chatId, text: args.text, ... }); }),

      tool("set_reminder", "Set a reminder for the user",
        { message: z.string(), cronExpression: z.string().optional(), delayMinutes: z.number().optional() },
        async (args) => { /* crea task schedulato */ }),

      tool("get_conversation_history", "Get recent messages from a chat",
        { chatId: z.number(), limit: z.number().default(20) },
        async (args) => { /* query SQLite messages */ }),

      tool("get_user_preferences", "Get stored user preferences",
        { userId: z.number() },
        async (args) => { /* query SQLite memories */ }),
    ],
  });
}
```

### 6. Telegram Bot (`packages/telegram/src/bot.ts`)

```typescript
import { Bot, session } from "grammy";

export function createBot(config, events, orchestrator) {
  const bot = new Bot(config.telegram.botToken);

  // Middleware stack
  bot.use(session({ initial: () => ({ pendingApprovals: [] }), storage: new SQLiteSessionStorage(config.database.path) }));
  bot.use(authMiddleware(config.telegram.allowedUsers, config.telegram.allowedGroups));
  bot.use(loggingMiddleware(events));

  // Handlers
  registerCommandHandlers(bot, config, events, orchestrator);
  registerMessageHandler(bot, events, orchestrator);
  registerCallbackHandler(bot, events, orchestrator);
  registerFileHandler(bot, events, orchestrator);

  return bot;
}
```

### 7. Message Handler (`packages/telegram/src/handlers/message.ts`)

```typescript
export function registerMessageHandler(bot, events, orchestrator) {
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;

    // Typing indicator ogni 4s
    const typingInterval = setInterval(() => ctx.replyWithChatAction("typing"), 4000);

    try {
      const response = await orchestrator.handleMessage({
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        text: ctx.message.text,
        replyToSessionId: ctx.session.activeSessionId,
      });

      ctx.session.activeSessionId = response.sessionId;

      // Format e split per limite 4096 char Telegram
      const formatted = formatMarkdownV2(response.text);
      const chunks = splitMessage(formatted, 4000);
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: "MarkdownV2" });
      }
    } finally {
      clearInterval(typingInterval);
    }
  });
}
```

### 8. Event Bus (`packages/core/src/events/bus.ts`)

```typescript
export interface NeoEventMap {
  "message:received":    { chatId: number; userId: number; text: string; timestamp: Date };
  "message:response":    { chatId: number; text: string; agentType: string; sessionId: string; costUsd: number; durationMs: number };
  "agent:started":       { sessionId: string; agentType: string; chatId: number; prompt: string };
  "agent:completed":     { sessionId: string; agentType: string; result: string; costUsd: number; durationMs: number; numTurns: number };
  "agent:error":         { sessionId: string; agentType: string; error: string };
  "agent:stream":        { sessionId: string; chunk: string };
  "tool:used":           { sessionId: string; toolName: string; input: unknown; output: unknown; durationMs: number };
  "mcp:status":          { serverName: string; status: "connected" | "failed" | "restarting" };
  "permission:request":  { sessionId: string; toolName: string; input: unknown; chatId: number };
  "cost:update":         { totalCostUsd: number; sessionCostUsd: number; sessionId: string };
  "queue:status":        { chatId: number; pending: number; processing: boolean };
}
```

---

## Database Schema (SQLite + Drizzle ORM)

### conversations
| Colonna | Tipo | Note |
|---------|------|------|
| id | INTEGER PK | autoincrement |
| chat_id | INTEGER | Telegram chat ID |
| chat_type | TEXT | "private" / "group" / "supergroup" |
| chat_title | TEXT | nullable |
| last_session_id | TEXT | ultima sessione Claude |
| last_activity_at | TEXT | ISO 8601 |
| created_at | TEXT | ISO 8601 |

### messages
| Colonna | Tipo | Note |
|---------|------|------|
| id | INTEGER PK | autoincrement |
| conversation_id | INTEGER FK | → conversations.id |
| role | TEXT | "user" / "assistant" / "system" |
| content | TEXT | testo del messaggio |
| user_id | INTEGER | Telegram user ID |
| agent_type | TEXT | "general", "coder", etc. |
| session_id | TEXT | Claude session_id |
| cost_usd | REAL | costo della risposta |
| duration_ms | INTEGER | tempo di risposta |
| num_turns | INTEGER | turni agente |
| telegram_message_id | INTEGER | |
| created_at | TEXT | ISO 8601 |

### sessions
| Colonna | Tipo | Note |
|---------|------|------|
| id | TEXT PK | Claude Agent SDK session_id |
| chat_id | INTEGER | |
| agent_type | TEXT | |
| status | TEXT | "active" / "completed" / "error" |
| total_cost_usd | REAL | |
| total_turns | INTEGER | |
| created_at | TEXT | |
| last_used_at | TEXT | |

### audit_log
| Colonna | Tipo | Note |
|---------|------|------|
| id | INTEGER PK | |
| session_id | TEXT | |
| chat_id | INTEGER | |
| user_id | INTEGER | |
| event_type | TEXT | "tool_use" / "permission_grant" / "permission_deny" / "error" |
| tool_name | TEXT | |
| tool_input | TEXT | JSON, max 10KB |
| tool_output | TEXT | JSON, max 5KB |
| cost_usd | REAL | |
| duration_ms | INTEGER | |
| created_at | TEXT | |

### scheduled_tasks
| Colonna | Tipo | Note |
|---------|------|------|
| id | INTEGER PK | |
| chat_id | INTEGER | |
| name | TEXT | |
| description | TEXT | |
| cron_expression | TEXT | nullable per one-shot |
| next_run_at | TEXT | |
| last_run_at | TEXT | |
| prompt | TEXT | messaggio da mandare all'agente |
| agent_type | TEXT | default "general" |
| status | TEXT | "active" / "paused" / "completed" / "failed" |
| created_at | TEXT | |

### memories
| Colonna | Tipo | Note |
|---------|------|------|
| id | INTEGER PK | |
| chat_id | INTEGER | |
| user_id | INTEGER | |
| key | TEXT | |
| value | TEXT | |
| category | TEXT | "preference" / "fact" / "context" / "instruction" |
| created_at | TEXT | |
| updated_at | TEXT | |

### cost_tracking
| Colonna | Tipo | Note |
|---------|------|------|
| id | INTEGER PK | |
| session_id | TEXT | |
| chat_id | INTEGER | |
| model | TEXT | |
| input_tokens | INTEGER | |
| output_tokens | INTEGER | |
| cost_usd | REAL | |
| created_at | TEXT | |

---

## Sicurezza (5 Layer)

### Layer 1: Telegram Auth
```typescript
// Solo utenti nella whitelist possono interagire
if (!allowedUsers.includes(userId)) return; // reject silenzioso
```

### Layer 2: Claude Auth
- `CLAUDE_CODE_OAUTH_TOKEN` passato via stdin al container, mai su disco
- Mai in log, mai in variabili d'ambiente del processo host

### Layer 3: Docker Isolation
- Container isolati (`--rm`), rimossi dopo ogni query
- Volume mount limitati (solo workspace e ipc)
- Resource limits (memory, CPU)

### Layer 4: Bash Sanitization
- Hook nel container che strippa secrets dall'output dei comandi bash
- Previene leak accidentali di token nei log

### Layer 5: Tool Permissions
```typescript
canUseTool: async (toolName, input) => {
  if (denyList.has(toolName)) return { behavior: "deny", message: "Blocked by policy" };
  if (safeTools.has(toolName)) return { behavior: "allow" };  // Read, Glob, Grep, WebSearch
  // Write/Edit/Bash: allow + audit log
  // mcp__*: allow (gia' scoped dal server)
  return { behavior: "allow" };
}
```

---

## Configurazione (`neo.config.ts`)

```typescript
const config: NeoConfig = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
    allowedUsers: [parseInt(process.env.TELEGRAM_USER_ID!, 10)],
    allowedGroups: [],
    pollingMode: true,
  },
  claude: {
    authMethod: "oauth",
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    defaultModel: "sonnet",
    maxBudgetUsd: 5.0,
    maxTurns: 25,
  },
  mcp: {
    enabled: {
      filesystem: true, git: true, postgres: false, sqlite: true,
      puppeteer: false, fetch: true, github: true, docker: false,
      "home-assistant": false,
    },
    configs: {
      filesystem: { allowedPaths: ["~/Documents", "~/Projects"] },
      github: { token: process.env.GITHUB_TOKEN },
    },
  },
  docker: {
    imageName: "neo-agent",
    memoryLimit: "2g",
    cpuLimit: "2",
    workspacePath: "/workspace",
  },
  database: { path: "./data/neo.db" },
  security: { auditLog: true, maxConcurrentAgents: 3, toolDenyList: [] },
};
```

---

## Dipendenze

```
@neo/core:          drizzle-orm, better-sqlite3, zod, pino
@neo/agent:         zod (container runner usa child_process nativo)
@neo/mcp:           zod
@neo/telegram:      grammy
container/agent-runner: @anthropic-ai/claude-agent-sdk (dentro Docker)
apps/neo:           all @neo/*, dotenv

Tooling: turbo, typescript, Docker
```

---

## Fasi di Implementazione

### Fase 1: Foundation
- Setup Turborepo monorepo con workspace
- `@neo/core`: config Zod, schema Drizzle + migrazioni, event bus, logger
- `apps/neo`: bootstrap base
- **Test**: app si avvia, crea DB, logga "Neo running"

### Fase 2: Docker + Agent Core
- `container/Dockerfile`: Node 22 + `@anthropic-ai/claude-code` + Chromium
- `container/agent-runner`: entry point che legge stdin, esegue `query()`, scrive stdout
- `@neo/agent`: container-runner (spawna Docker), orchestrator, router, queue, session manager
- Solo agente "general" (no subagenti)
- **Test**: `orchestrator.handleMessage()` spawna container → ritorna risposta Claude

### Fase 3: Telegram
- `@neo/telegram`: grammY bot, auth, message handler, MarkdownV2 formatter
- **Test**: mandi messaggio su Telegram → container → risposta Claude

### Fase 4: MCP
- `@neo/mcp`: registry config, factory per server esterni
- Config MCP passata al container via stdin
- Aggiungere uno alla volta: filesystem → git → fetch → github
- **Test**: agente nel container usa tool MCP (es. legge file, cerca web)

### Fase 5: Multi-Agent
- 6 agenti nel registry + router regex completo + subagenti per "general"
- **Test**: `/code fix bug` → coder, "che tempo fa?" → general, "cerca TypeScript 6" → researcher

### Fase 6: Polish
- Inline keyboard per approvazioni tool su Telegram
- Scheduler MCP + task runner (cron)
- Memory MCP persistente
- Rate limiting
- IPC filesystem per comunicazione bidirezionale host ↔ container

---

## Come Testare End-to-End

```bash
# 1. Setup
cp .env.example .env
# Compila .env con TELEGRAM_BOT_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, etc.
npm install
npm run build

# 2. Build Docker image
docker build -t neo-agent ./container

# 3. Avvia
npm run dev

# 4. Test Telegram
# Manda "ciao" → container spawna → risposta conversazionale
# Manda "cerca le ultime news su TypeScript 6" → researcher + WebSearch
# Manda "/code scrivi fibonacci in Rust" → coder + Write
# Manda "accendi la luce del salotto" → smart-home + MCP home-assistant

# 5. Verifica Docker
# Durante una query: docker ps → container neo-XXXX attivo
# Dopo la query: container rimosso (--rm)

# 6. Test Session Continuity
# Manda "parlami di React" → risposta
# Manda "e quali sono i suoi limiti?" → Claude ricorda il contesto (resume sessione)

# 7. Verifica Audit
# sqlite3 data/neo.db "SELECT * FROM audit_log ORDER BY id DESC LIMIT 10"
```
