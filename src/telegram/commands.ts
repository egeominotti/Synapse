/**
 * Telegram bot slash commands: /start, /help, /reset, /stats, /ping,
 * /export, /schedule, /jobs, /job, /config.
 */

import { InputFile, type Bot } from "grammy"
import { parseSchedule } from "../scheduler"
import { logger } from "../logger"
import type { RuntimeConfigKey } from "../types"
import type { TelegramDeps } from "./handlers"

export function registerCommands(bot: Bot, deps: TelegramDeps): void {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "👋 Ciao! Sono il tuo agente Claude.\n\n" +
        "Scrivimi qualcosa o mandami una foto.\n\n" +
        "/help — comandi disponibili\n" +
        "/reset — nuova conversazione\n" +
        "/stats — statistiche sessione"
    )
  })

  bot.command("help", async (ctx) => {
    const lines = [
      "📋 *Comandi disponibili:*\n",
      "/start — messaggio di benvenuto",
      "/reset — resetta la conversazione",
      "/stats — statistiche sessione corrente",
      "/export — esporta conversazione come file",
      "/schedule — programma un job schedulato",
      "/jobs — lista job attivi",
      "/ping — stato del bot",
    ]
    if (deps.isAdmin(ctx.chat.id)) {
      lines.push("/prompt — cambia il comportamento del bot (admin)")
      lines.push("/config — configurazione runtime (admin)")
    }
    lines.push(
      "",
      "💬 Scrivi qualsiasi messaggio per parlare con Claude.",
      "📷 Manda una foto (con o senza didascalia) per analisi visiva.",
      "✏️ Modifica un messaggio per reinviarlo a Claude."
    )
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
  })

  bot.command("reset", async (ctx) => {
    const chatId = ctx.chat.id
    const agent = deps.agents.get(chatId)
    if (agent) {
      agent.abort() // Kill any running process to unblock the queue
      agent.cleanup()
    }
    deps.agents.delete(chatId)
    deps.histories.delete(chatId)
    await deps.store.delete(chatId)
    logger.info("Session reset", { chatId })
    await ctx.reply("🔄 Sessione resettata. Puoi iniziare una nuova conversazione.")
  })

  bot.command("stats", async (ctx) => {
    const chatId = ctx.chat.id
    const agent = deps.agents.get(chatId)
    const savedSid = deps.store.get(chatId)
    const sid = agent?.getSessionId() ?? savedSid

    const lines = [
      `📊 *Sessione corrente:*\n`,
      `Session ID: \`${sid ? sid.slice(0, 16) + "..." : "nessuna"}\``,
      `Persistenza: ${savedSid ? "✅ salvata in DB" : "⏳ non ancora salvata"}`,
    ]

    if (sid) {
      const stats = deps.db.getSessionStats(sid)
      if (stats) {
        const avgMs = Math.round(stats.totalDurationMs / stats.totalMessages)
        const totalTok = stats.totalInputTokens + stats.totalOutputTokens
        lines.push("")
        lines.push(`Messaggi: *${stats.totalMessages}*`)
        lines.push(`Durata media: *${(avgMs / 1000).toFixed(1)}s*`)
        if (totalTok > 0) {
          lines.push(
            `Token: *${totalTok.toLocaleString("it-IT")}* (${stats.totalInputTokens.toLocaleString("it-IT")} in / ${stats.totalOutputTokens.toLocaleString("it-IT")} out)`
          )
        }
        const attachments = deps.db.getAttachmentsBySession(sid)
        if (attachments.length > 0) {
          lines.push(`Foto: *${attachments.length}*`)
        }
      }
    }

    // Global stats (all sessions)
    const global = deps.db.getAllStats()
    if (global) {
      const avgMs = Math.round(global.totalDurationMs / global.totalMessages)
      const totalTok = global.totalInputTokens + global.totalOutputTokens
      lines.push("")
      lines.push(`📈 *Storico totale:*\n`)
      lines.push(`Sessioni: *${global.totalSessions}*`)
      lines.push(`Messaggi: *${global.totalMessages}*`)
      lines.push(`Durata media: *${(avgMs / 1000).toFixed(1)}s*`)
      if (totalTok > 0) {
        lines.push(
          `Token: *${totalTok.toLocaleString("it-IT")}* (${global.totalInputTokens.toLocaleString("it-IT")} in / ${global.totalOutputTokens.toLocaleString("it-IT")} out)`
        )
      }
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
  })

  bot.command("ping", async (ctx) => {
    const uptimeMs = Date.now() - deps.botStartedAt
    const uptimeSec = Math.floor(uptimeMs / 1000)
    const h = Math.floor(uptimeSec / 3600)
    const m = Math.floor((uptimeSec % 3600) / 60)
    const s = uptimeSec % 60
    const uptime = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`

    const lines = [
      "🏓 *Pong!*\n",
      `Uptime: *${uptime}*`,
      `Agenti attivi: *${deps.agents.size}*`,
      `Sessioni Telegram: *${deps.store.size}*`,
      `Coda messaggi: *${deps.chatQueue.size}*`,
      `DB: ✅ operativo`,
    ]

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
  })

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  bot.command("export", async (ctx) => {
    const chatId = ctx.chat.id
    const agent = deps.agents.get(chatId)
    const savedSid = deps.store.get(chatId)
    const sid = agent?.getSessionId() ?? savedSid

    if (!sid) {
      await ctx.reply("📭 Nessuna sessione da esportare. Inizia una conversazione prima.")
      return
    }

    const messages = deps.db.getMessages(sid)
    if (messages.length === 0) {
      await ctx.reply("📭 Sessione vuota, niente da esportare.")
      return
    }

    const lines: string[] = [`# Sessione ${sid.slice(0, 16)}`, ""]
    for (const msg of messages) {
      const date = new Date(msg.timestamp).toLocaleString("it-IT", { timeZone: "Europe/Rome" })
      lines.push(`## 👤 Utente — ${date}`)
      lines.push("", msg.prompt, "")
      lines.push(`## 🤖 Claude — ${(msg.duration_ms / 1000).toFixed(1)}s`)
      lines.push("", msg.response, "")
      lines.push("---", "")
    }

    const content = lines.join("\n")
    const filename = `sessione-${sid.slice(0, 8)}.md`
    const buffer = Buffer.from(content)

    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption: `📄 ${messages.length} messaggi esportati`,
    })
  })

  // -------------------------------------------------------------------------
  // Schedule
  // -------------------------------------------------------------------------

  bot.command("schedule", async (ctx) => {
    const text = ctx.message?.text ?? ""
    const args = text.replace(/^\/schedule\s*/, "").trim()

    if (!args) {
      await ctx.reply(
        "⏰ *Uso:*\n\n" +
          "`/schedule at 18:00 <prompt>` — una volta\n" +
          "`/schedule every 09:00 <prompt>` — ogni giorno\n" +
          "`/schedule every 30s <prompt>` — ogni 30 secondi\n" +
          "`/schedule every 5m <prompt>` — ogni 5 minuti\n" +
          "`/schedule in 30m <prompt>` — dopo un delay\n\n" +
          "Esempi:\n" +
          "`/schedule at 18:00 Ricordami di chiamare Mario`\n" +
          "`/schedule every 09:00 Buongiorno! Programmi per oggi?`\n" +
          "`/schedule every 1m Controlla lo stato del sistema`\n" +
          "`/schedule in 2h Controlla lo stato del deploy`",
        { parse_mode: "Markdown" }
      )
      return
    }

    const exprMatch = args.match(
      /^((?:at|every|alle|ogni)\s+\d{1,2}:\d{2}|(?:every|ogni)\s+\d+\s*(?:s|m|h|sec|min|ore|ora|minuti|secondi)|in\s+\d+\s*(?:s|m|h|sec|min|ore|ora|minuti|secondi))\s+(.+)$/i
    )
    if (!exprMatch) {
      await ctx.reply(
        "❌ Formato non valido.\n\nUsa: `/schedule at 18:00 <prompt>`, `/schedule every 30s <prompt>`, `/schedule in 5m <prompt>`",
        { parse_mode: "Markdown" }
      )
      return
    }

    const scheduleExpr = exprMatch[1]
    const prompt = exprMatch[2]

    try {
      const spec = parseSchedule(scheduleExpr)
      const jobId = deps.scheduler.createJob(ctx.chat.id, prompt, spec)
      const runAtStr = spec.runAt.toLocaleString("it-IT", { timeZone: "Europe/Rome" })
      const typeLabel =
        spec.type === "recurring" ? "🔄 Ricorrente" : spec.type === "delay" ? "⏳ Delay" : "📌 Una volta"

      await ctx.reply(
        `✅ Job #${jobId} creato\n\n` +
          `${typeLabel}\n` +
          `Prossima esecuzione: *${runAtStr}*\n` +
          `Prompt: _${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}_`,
        { parse_mode: "Markdown" }
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`❌ ${msg}`)
    }
  })

  bot.command("jobs", async (ctx) => {
    const jobs = deps.db.getJobsByChat(ctx.chat.id)

    if (jobs.length === 0) {
      await ctx.reply("📭 Nessun job attivo. Usa /schedule per crearne uno.")
      return
    }

    const lines = [`⏰ *Job attivi (${jobs.length}):*\n`]
    for (const job of jobs) {
      const runAt = new Date(job.run_at).toLocaleString("it-IT", { timeZone: "Europe/Rome" })
      const typeEmoji = job.schedule_type === "recurring" ? "🔄" : job.schedule_type === "delay" ? "⏳" : "📌"
      const promptPreview = job.prompt.slice(0, 60) + (job.prompt.length > 60 ? "..." : "")
      lines.push(`${typeEmoji} *#${job.id}* — ${runAt}`)
      lines.push(`  _${promptPreview}_\n`)
    }

    lines.push("Usa `/job delete <id>` per eliminare un job.")
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
  })

  bot.command("job", async (ctx) => {
    const text = ctx.message?.text ?? ""
    const args = text.replace(/^\/job\s*/, "").trim()

    // /job clear — delete all jobs for this chat
    if (args === "clear") {
      const count = deps.db.deleteAllJobs(ctx.chat.id)
      if (count > 0) {
        await ctx.reply(`✅ ${count} job eliminati.`)
      } else {
        await ctx.reply("📭 Nessun job da eliminare.")
      }
      return
    }

    const deleteMatch = args.match(/^delete\s+(\d+)$/)
    if (!deleteMatch) {
      await ctx.reply("Uso:\n`/job delete <id>` — elimina un job\n`/job clear` — elimina tutti i job", {
        parse_mode: "Markdown",
      })
      return
    }

    const jobId = parseInt(deleteMatch[1], 10)
    const deleted = deps.db.deleteJob(jobId, ctx.chat.id)

    if (deleted) {
      await ctx.reply(`✅ Job #${jobId} eliminato.`)
    } else {
      await ctx.reply(`❌ Job #${jobId} non trovato o non appartiene a questa chat.`)
    }
  })

  // -------------------------------------------------------------------------
  // Prompt (change bot behavior)
  // -------------------------------------------------------------------------

  bot.command("prompt", async (ctx) => {
    const chatId = ctx.chat.id

    if (!deps.isAdmin(chatId)) {
      await ctx.reply("🔒 Non autorizzato. Solo l'admin puo' cambiare il comportamento.")
      return
    }

    const text = ctx.message?.text ?? ""
    const args = text.replace(/^\/prompt\s*/, "").trim()
    const rc = deps.runtimeConfig

    // Show current prompt
    if (!args) {
      const current = rc.get("system_prompt")
      if (current) {
        await ctx.reply(`🧠 *Prompt attuale:*\n\n_${current}_\n\n_Usa /prompt reset per tornare al default_`, {
          parse_mode: "Markdown",
        })
      } else {
        await ctx.reply("🧠 Nessun prompt personalizzato impostato.\n\nUsa `/prompt <testo>` per impostarne uno.", {
          parse_mode: "Markdown",
        })
      }
      return
    }

    // Reset prompt
    if (args === "reset") {
      rc.reset("system_prompt")

      // Reset session so default takes effect immediately
      const oldAgent = deps.agents.get(chatId)
      if (oldAgent) oldAgent.cleanup()
      deps.agents.delete(chatId)
      deps.histories.delete(chatId)
      await deps.store.delete(chatId)

      await ctx.reply("✅ Prompt rimosso e sessione resettata.\n\nIl bot torna al comportamento predefinito.")
      return
    }

    // Set new prompt
    try {
      const { oldValue } = rc.set("system_prompt", args)

      // Reset session so new prompt takes effect immediately
      const oldAgent = deps.agents.get(chatId)
      if (oldAgent) oldAgent.cleanup()
      deps.agents.delete(chatId)
      deps.histories.delete(chatId)
      await deps.store.delete(chatId)

      const changed = oldValue ? `\n\n_Precedente: ${oldValue.slice(0, 100)}${oldValue.length > 100 ? "..." : ""}_` : ""
      await ctx.reply(`✅ Prompt aggiornato e sessione resettata.${changed}\n\n🧠 _${args}_`, {
        parse_mode: "Markdown",
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`❌ Errore: ${msg}`)
    }
  })

  // -------------------------------------------------------------------------
  // Config (admin only)
  // -------------------------------------------------------------------------

  bot.command("config", async (ctx) => {
    const chatId = ctx.chat.id

    if (!deps.isAdmin(chatId)) {
      await ctx.reply("🔒 Non autorizzato. Solo l'admin puo' configurare il bot.")
      return
    }

    const text = ctx.message?.text ?? ""
    const args = text.replace(/^\/config\s*/, "").trim()
    const rc = deps.runtimeConfig

    if (!args) {
      const all = rc.getAll()
      const lines = ["⚙️ *Configurazione corrente:*\n"]
      for (const item of all) {
        const modified = item.value !== item.defaultValue ? " ✏️" : ""
        lines.push(`\`${item.key}\` = \`${item.value || '""'}\`${modified}`)
        lines.push(`  _${item.description}_\n`)
      }
      lines.push("_Usa /config <key> <value> per modificare_")
      lines.push("_Usa /config reset per ripristinare i default_")
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
      return
    }

    if (args === "reset") {
      rc.resetAll()
      await ctx.reply("✅ Configurazione ripristinata ai default.")
      return
    }

    if (args.startsWith("reset ")) {
      const key = args.slice(6).trim()
      if (!rc.isValidKey(key)) {
        const keys = rc
          .getAllDefinitions()
          .map((d) => d.key)
          .join(", ")
        await ctx.reply(`❌ Chiave sconosciuta: \`${key}\`\n\nChiavi valide: ${keys}`, { parse_mode: "Markdown" })
        return
      }
      const { oldValue, defaultValue } = rc.reset(key as RuntimeConfigKey)
      await ctx.reply(`✅ \`${key}\` ripristinato\n\n\`${oldValue}\` → \`${defaultValue}\``, {
        parse_mode: "Markdown",
      })
      return
    }

    const parts = args.split(/\s+/)
    const key = parts[0]

    if (!rc.isValidKey(key)) {
      const keys = rc
        .getAllDefinitions()
        .map((d) => d.key)
        .join(", ")
      await ctx.reply(`❌ Chiave sconosciuta: \`${key}\`\n\nChiavi valide: ${keys}`, { parse_mode: "Markdown" })
      return
    }

    if (parts.length === 1) {
      const def = rc.getDefinition(key as RuntimeConfigKey)!
      const current = rc.get(key as RuntimeConfigKey)
      const modified = current !== def.defaultValue ? " ✏️" : ""
      const lines = [
        `⚙️ \`${key}\`${modified}\n`,
        `Valore: \`${current || '""'}\``,
        `Default: \`${def.defaultValue || '""'}\``,
        `Tipo: ${def.type}`,
        `_${def.description}_`,
      ]
      if (def.min !== undefined) lines.push(`Min: ${def.min}`)
      if (def.max !== undefined) lines.push(`Max: ${def.max}`)
      if (def.enum) lines.push(`Valori: ${def.enum.join(", ")}`)
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
      return
    }

    const value = parts.slice(1).join(" ")
    try {
      const { oldValue, newValue } = rc.set(key as RuntimeConfigKey, value)
      await ctx.reply(`✅ \`${key}\` aggiornato\n\n\`${oldValue || '""'}\` → \`${newValue || '""'}\``, {
        parse_mode: "Markdown",
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`❌ Errore: ${msg}`, { parse_mode: "Markdown" })
    }
  })
}
