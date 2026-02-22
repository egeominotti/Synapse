import "dotenv/config";
import { loadConfig, createDb, createQueries, NeoEventBus, createLogger } from "@neo/core";
import { Orchestrator, ContainerRunner, AgentRouter, ChatQueue, SessionManager } from "@neo/agent";
import { McpRegistry } from "@neo/mcp";
import { createBot } from "@neo/telegram";

const logger = createLogger("neo");

async function main() {
  logger.info("Starting Neo...");

  // 1. Load config
  const config = loadConfig({
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
      allowedUsers: process.env.TELEGRAM_USER_ID
        ? [parseInt(process.env.TELEGRAM_USER_ID, 10)]
        : [],
    },
    claude: {
      authMethod: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "oauth" : "api-key",
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    mcp: {
      enabled: {
        filesystem: true,
        git: true,
        fetch: true,
      },
    },
    docker: {
      imageName: process.env.NEO_DOCKER_IMAGE ?? "neo-agent",
    },
    database: {
      path: process.env.NEO_DB_PATH ?? "./data/neo.db",
    },
  });

  // 2. Init database
  const db = createDb(config.database.path);
  const queries = createQueries(db);
  logger.info({ path: config.database.path }, "Database initialized");

  // 3. Init event bus
  const events = new NeoEventBus();

  events.on("agent:started", (payload) => {
    logger.info({ agent: payload.agentType, chatId: payload.chatId }, "Agent started");
  });

  events.on("agent:completed", (payload) => {
    logger.info(
      {
        agent: payload.agentType,
        cost: payload.costUsd,
        duration: payload.durationMs,
        turns: payload.numTurns,
      },
      "Agent completed",
    );
  });

  events.on("agent:error", (payload) => {
    logger.error({ agent: payload.agentType, error: payload.error }, "Agent error");
  });

  // 4. Init MCP registry
  const mcpRegistry = new McpRegistry(config);
  mcpRegistry.initialize();
  logger.info({ servers: mcpRegistry.getServerNames() }, "MCP registry initialized");

  // 5. Init agent system
  const containerRunner = new ContainerRunner(config, createLogger("container"));
  const router = new AgentRouter();
  const chatQueue = new ChatQueue(config.security.maxConcurrentAgents);
  const sessions = new SessionManager(queries);

  const orchestrator = new Orchestrator(
    config,
    events,
    router,
    sessions,
    containerRunner,
    chatQueue,
    mcpRegistry,
  );

  logger.info("Agent orchestrator initialized");

  // 6. Init Telegram bot
  if (config.telegram.botToken) {
    const bot = createBot(config, events, orchestrator);
    bot.start({
      onStart: () => logger.info("Telegram bot started (polling)"),
    });
    logger.info("Telegram bot initialized");
  } else {
    logger.warn("No TELEGRAM_BOT_TOKEN - bot disabled");
  }

  logger.info("Neo running");
}

// Graceful shutdown
function setupShutdown() {
  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of signals) {
    process.on(signal, () => {
      logger.info({ signal }, "Shutting down...");
      process.exit(0);
    });
  }
}

setupShutdown();
main().catch((err) => {
  logger.fatal(err, "Fatal error");
  process.exit(1);
});
