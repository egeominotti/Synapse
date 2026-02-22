import type { Bot, Context } from "grammy";
import type { NeoEventBus } from "@neo/core";
import type { Orchestrator } from "@neo/agent";
import { formatMarkdownV2, splitMessage } from "../formatters/markdown.js";

export function registerMessageHandler(bot: Bot, events: NeoEventBus, orchestrator: Orchestrator) {
  bot.on("message:text", async (ctx: Context) => {
    const text = ctx.message?.text;
    if (!text || text.startsWith("/")) return;

    const chatId = ctx.chat!.id;
    const userId = ctx.from!.id;

    events.emit("message:received", {
      chatId,
      userId,
      text,
      timestamp: new Date(),
    });

    // Typing indicator every 4 seconds
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);
    // Send first typing immediately
    ctx.replyWithChatAction("typing").catch(() => {});

    try {
      const session = (ctx as any).session;
      const response = await orchestrator.handleMessage({
        chatId,
        userId,
        text,
        replyToSessionId: session?.activeSessionId,
      });

      // Save session for continuity
      if (session) {
        session.activeSessionId = response.sessionId;
      }

      events.emit("message:response", {
        chatId,
        text: response.text,
        agentType: response.agentType,
        sessionId: response.sessionId,
        costUsd: response.costUsd,
        durationMs: response.durationMs,
      });

      // Format and send response, split if > 4096 chars
      const chunks = splitMessage(response.text, 4000);
      for (const chunk of chunks) {
        try {
          const formatted = formatMarkdownV2(chunk);
          await ctx.reply(formatted, { parse_mode: "MarkdownV2" });
        } catch {
          // If MarkdownV2 fails, send as plain text
          await ctx.reply(chunk);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      events.emit("agent:error", {
        sessionId: "",
        agentType: "unknown",
        error: errorMsg,
      });
      await ctx.reply(`Errore: ${errorMsg.slice(0, 200)}`);
    } finally {
      clearInterval(typingInterval);
    }
  });
}
