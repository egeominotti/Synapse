import { Bot, session } from "grammy";
import type { NeoConfig, NeoEventBus } from "@neo/core";
import type { Orchestrator } from "@neo/agent";
import { authMiddleware } from "./middleware/auth.js";
import { registerCommandHandlers } from "./handlers/command.js";
import { registerMessageHandler } from "./handlers/message.js";

export interface NeoSessionData {
  activeSessionId?: string;
}

export function createBot(
  config: NeoConfig,
  events: NeoEventBus,
  orchestrator: Orchestrator,
) {
  const bot = new Bot(config.telegram.botToken);

  // Session middleware
  bot.use(session<NeoSessionData, any>({
    initial: () => ({}),
  }));

  // Auth middleware - whitelist users/groups
  bot.use(authMiddleware(config.telegram.allowedUsers, config.telegram.allowedGroups));

  // Command handlers
  registerCommandHandlers(bot, config, events);

  // Message handler - main logic
  registerMessageHandler(bot, events, orchestrator);

  return bot;
}
