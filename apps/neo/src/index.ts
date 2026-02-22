import "dotenv/config";
import { loadConfig, createDb, createQueries, NeoEventBus, createLogger } from "@neo/core";

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

  // Log all events in dev
  events.on("agent:completed", (payload) => {
    logger.info({
      agent: payload.agentType,
      cost: payload.costUsd,
      duration: payload.durationMs,
      turns: payload.numTurns,
    }, "Agent completed");
  });

  events.on("agent:error", (payload) => {
    logger.error({ agent: payload.agentType, error: payload.error }, "Agent error");
  });

  logger.info("Neo running");

  // TODO: Fase 2 - Init agent orchestrator + container runner
  // TODO: Fase 3 - Init telegram bot
  // TODO: Fase 4 - Init MCP registry
}

// Graceful shutdown
function setupShutdown() {
  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of signals) {
    process.on(signal, () => {
      logger.info({ signal }, "Shutting down...");
      // TODO: cleanup containers, close DB, stop bot
      process.exit(0);
    });
  }
}

setupShutdown();
main().catch((err) => {
  logger.fatal(err, "Fatal error");
  process.exit(1);
});
