import type { Bot, Context } from "grammy";
import type { NeoConfig } from "@neo/core";

export function registerCommandHandlers(bot: Bot, config: NeoConfig) {
  bot.command("start", async (ctx: Context) => {
    await ctx.reply(
      "Ciao! Sono Neo, il tuo assistente AI personale.\n\n" +
        "Scrivimi qualsiasi cosa e ti rispondo.\n\n" +
        "Comandi:\n" +
        "/help - Mostra questo messaggio\n" +
        "/status - Stato del sistema\n" +
        "/reset - Nuova conversazione\n" +
        "/agents - Lista agenti disponibili",
    );
  });

  bot.command("help", async (ctx: Context) => {
    await ctx.reply(
      "Sono Neo. Ecco cosa posso fare:\n\n" +
        "Scrivi normalmente e scelgo l'agente giusto.\n" +
        "Oppure usa un comando specifico:\n\n" +
        "/code <messaggio> - Agente sviluppatore\n" +
        "/research <messaggio> - Agente ricercatore\n" +
        "/sysadmin <messaggio> - Agente sysadmin\n" +
        "/data <messaggio> - Agente analisi dati\n" +
        "/home <messaggio> - Agente domotica\n\n" +
        "/status - Stato sistema\n" +
        "/reset - Nuova conversazione",
    );
  });

  bot.command("status", async (ctx: Context) => {
    await ctx.reply(
      "Neo Status:\n" +
        `- Auth: ${config.claude.authMethod}\n` +
        `- Model: ${config.claude.defaultModel}\n` +
        `- Max turns: ${config.claude.maxTurns}\n` +
        `- Docker image: ${config.docker.imageName}`,
    );
  });

  bot.command("agents", async (ctx: Context) => {
    await ctx.reply(
      "Agenti disponibili:\n\n" +
        "general - Assistente generico (default)\n" +
        "coder - Sviluppatore software\n" +
        "researcher - Ricerca web\n" +
        "sysadmin - Amministrazione sistemi\n" +
        "data-analyst - Analisi dati\n" +
        "smart-home - Domotica",
    );
  });

  bot.command("reset", async (ctx: Context) => {
    const session = (ctx as any).session;
    if (session) {
      session.activeSessionId = undefined;
    }
    await ctx.reply("Conversazione resettata. Inizio una nuova sessione.");
  });
}
