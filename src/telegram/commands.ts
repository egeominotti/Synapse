/**
 * Telegram bot slash commands: /start, /help, /reset, /stats, /ping,
 * /export, /schedule, /jobs, /job, /config.
 */

import { InputFile, type Bot } from "grammy"
import { parseSchedule } from "../scheduler"
import { generateIdentity } from "../agent-identity"
import { logger } from "../logger"
import type { RuntimeConfigKey } from "../types"
import type { TelegramDeps } from "./handlers"

export function registerCommands(bot: Bot, deps: TelegramDeps): void {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "👋 Hello! I'm your Claude agent.\n\n" +
        "Write me something or send me a photo.\n\n" +
        "/help — available commands\n" +
        "/reset — new conversation\n" +
        "/stats — session statistics"
    )
  })

  bot.command("help", async (ctx) => {
    const lines = [
      "📋 *Available commands:*\n",
      "/start — welcome message",
      "/reset — reset the conversation",
      "/stats — current session statistics",
      "/export — export conversation as file",
      "/schedule — schedule a job",
      "/jobs — list active jobs",
      "/ping — bot status",
    ]
    if (deps.isAdmin(ctx.chat.id)) {
      lines.push("/prompt — change bot behavior (admin)")
      lines.push("/config — runtime configuration (admin)")
    }
    lines.push(
      "",
      "💬 Write any message to talk with Claude.",
      "📷 Send a photo (with or without caption) for visual analysis.",
      "✏️ Edit a message to resend it to Claude."
    )
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
  })

  bot.command("reset", async (ctx) => {
    const chatId = ctx.chat.id
    const pool = deps.agentPools.get(chatId)
    if (pool) pool.cleanup()
    deps.agentPools.delete(chatId)
    deps.histories.delete(chatId)
    await deps.store.delete(chatId)
    logger.info("Session reset", { chatId })
    await ctx.reply("🔄 Session reset. You can start a new conversation.")
  })

  bot.command("stats", async (ctx) => {
    const chatId = ctx.chat.id
    const pool = deps.agentPools.get(chatId)
    const savedSid = deps.store.get(chatId)
    const sid = pool?.getPrimary().getSessionId() ?? savedSid

    const lines = [
      `📊 *Current session:*\n`,
      `Session ID: \`${sid ? sid.slice(0, 16) + "..." : "none"}\``,
      `Persistence: ${savedSid ? "✅ saved in DB" : "⏳ not yet saved"}`,
    ]

    if (sid) {
      const stats = deps.db.getSessionStats(sid)
      if (stats) {
        const avgMs = Math.round(stats.totalDurationMs / stats.totalMessages)
        const totalTok = stats.totalInputTokens + stats.totalOutputTokens
        lines.push("")
        lines.push(`Messages: *${stats.totalMessages}*`)
        lines.push(`Average duration: *${(avgMs / 1000).toFixed(1)}s*`)
        if (totalTok > 0) {
          lines.push(
            `Tokens: *${totalTok.toLocaleString("en-US")}* (${stats.totalInputTokens.toLocaleString("en-US")} in / ${stats.totalOutputTokens.toLocaleString("en-US")} out)`
          )
        }
        const attachments = deps.db.getAttachmentsBySession(sid)
        if (attachments.length > 0) {
          lines.push(`Photos: *${attachments.length}*`)
        }
      }
    }

    // Global stats (all sessions)
    const global = deps.db.getAllStats()
    if (global) {
      const avgMs = Math.round(global.totalDurationMs / global.totalMessages)
      const totalTok = global.totalInputTokens + global.totalOutputTokens
      lines.push("")
      lines.push(`📈 *Total history:*\n`)
      lines.push(`Sessions: *${global.totalSessions}*`)
      lines.push(`Messages: *${global.totalMessages}*`)
      lines.push(`Average duration: *${(avgMs / 1000).toFixed(1)}s*`)
      if (totalTok > 0) {
        lines.push(
          `Tokens: *${totalTok.toLocaleString("en-US")}* (${global.totalInputTokens.toLocaleString("en-US")} in / ${global.totalOutputTokens.toLocaleString("en-US")} out)`
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
      `Active agents: *${deps.agentPools.size}*`,
      `Telegram sessions: *${deps.store.size}*`,
      `Message queue: *${deps.chatQueue.size}*`,
      `DB: ✅ operational`,
    ]

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
  })

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  bot.command("export", async (ctx) => {
    const chatId = ctx.chat.id
    const pool = deps.agentPools.get(chatId)
    const savedSid = deps.store.get(chatId)
    const sid = pool?.getPrimary().getSessionId() ?? savedSid

    if (!sid) {
      await ctx.reply("📭 No session to export. Start a conversation first.")
      return
    }

    const messages = deps.db.getMessages(sid)
    if (messages.length === 0) {
      await ctx.reply("📭 Empty session, nothing to export.")
      return
    }

    const lines: string[] = [`# Session ${sid.slice(0, 16)}`, ""]
    for (const msg of messages) {
      const date = new Date(msg.timestamp).toLocaleString("en-US", { timeZone: "Europe/Rome" })
      lines.push(`## 👤 User — ${date}`)
      lines.push("", msg.prompt, "")
      lines.push(`## 🤖 Claude — ${(msg.duration_ms / 1000).toFixed(1)}s`)
      lines.push("", msg.response, "")
      lines.push("---", "")
    }

    const content = lines.join("\n")
    const filename = `session-${sid.slice(0, 8)}.md`
    const buffer = Buffer.from(content)

    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption: `📄 ${messages.length} messages exported`,
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
        "⏰ *Usage:*\n\n" +
          "`/schedule at 18:00 <prompt>` — once\n" +
          "`/schedule every 09:00 <prompt>` — every day\n" +
          "`/schedule every 30s <prompt>` — every 30 seconds\n" +
          "`/schedule every 5m <prompt>` — every 5 minutes\n" +
          "`/schedule in 30m <prompt>` — after a delay\n" +
          "`/schedule cron */5 * * * * <prompt>` — raw cron\n\n" +
          "Examples:\n" +
          "`/schedule at 18:00 Remind me to call Mario`\n" +
          "`/schedule every 09:00 Good morning! Plans for today?`\n" +
          "`/schedule every 1m Check system status`\n" +
          "`/schedule in 2h Check deploy status`\n" +
          "`/schedule cron 0 0 9 * * * Good morning!`",
        { parse_mode: "Markdown" }
      )
      return
    }

    // Raw cron: /schedule cron <expr> <prompt>
    // Cron can have 5 or 6 fields, so we need a special parser
    const cronMatch = args.match(/^cron\s+(.+)$/i)
    const timeExprMatch = args.match(
      /^((?:at|every)\s+\d{1,2}:\d{2}|every\s+\d+\s*(?:s|m|h|sec|min)|in\s+\d+\s*(?:s|m|h|sec|min))\s+(.+)$/i
    )

    let scheduleExpr: string
    let prompt: string

    if (cronMatch) {
      // Extract cron fields from the rest — find where the prompt starts
      // Cron fields are: sec min hour dom month dow (5 or 6 fields)
      const cronParts = cronMatch[1].trim().split(/\s+/)
      // Try 6 fields first, then 5
      for (const fieldCount of [6, 5]) {
        if (cronParts.length > fieldCount) {
          const testExpr = cronParts.slice(0, fieldCount).join(" ")
          const testPrompt = cronParts.slice(fieldCount).join(" ")
          if (testPrompt) {
            try {
              parseSchedule(`cron ${testExpr}`)
              scheduleExpr = `cron ${testExpr}`
              prompt = testPrompt
              break
            } catch {
              continue
            }
          }
        }
      }
      // @ts-expect-error — scheduleExpr/prompt set in loop
      if (!scheduleExpr || !prompt) {
        await ctx.reply(
          "❌ Invalid cron format.\n\nUsage: `/schedule cron <5-6 fields> <prompt>`\nExample: `/schedule cron 0 0 9 * * * Good morning!`",
          { parse_mode: "Markdown" }
        )
        return
      }
    } else if (timeExprMatch) {
      scheduleExpr = timeExprMatch[1]
      prompt = timeExprMatch[2]
    } else {
      await ctx.reply(
        "❌ Invalid format.\n\nUsage: `/schedule at 18:00 <prompt>`, `/schedule every 30s <prompt>`, `/schedule in 5m <prompt>`, `/schedule cron <expr> <prompt>`",
        { parse_mode: "Markdown" }
      )
      return
    }

    try {
      const spec = parseSchedule(scheduleExpr)
      const jobId = deps.scheduler.createJob(ctx.chat.id, prompt, spec)
      const identity = generateIdentity(jobId)
      const runAtStr = spec.runAt.toLocaleString("en-US", { timeZone: "Europe/Rome" })
      const typeLabel =
        spec.type === "cron"
          ? "⚙️ Cron"
          : spec.type === "recurring"
            ? "🔄 Recurring"
            : spec.type === "delay"
              ? "⏳ Delay"
              : "📌 Once"
      const cronInfo = spec.cronExpr ? `\nCron: \`${spec.cronExpr}\`` : ""

      await ctx.reply(
        `✅ Job #${jobId} created\n\n` +
          `${identity.emoji} *${identity.name}* · ${identity.code}\n` +
          `${typeLabel}${cronInfo}\n` +
          `Next execution: *${runAtStr}*\n` +
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
      await ctx.reply("📭 No active jobs. Use /schedule to create one.")
      return
    }

    const lines = [`⏰ *Active jobs (${jobs.length}):*\n`]
    for (const job of jobs) {
      const identity = generateIdentity(job.id)
      const runAt = new Date(job.run_at).toLocaleString("en-US", { timeZone: "Europe/Rome" })
      const typeEmoji =
        job.schedule_type === "cron"
          ? "⚙️"
          : job.schedule_type === "recurring"
            ? "🔄"
            : job.schedule_type === "delay"
              ? "⏳"
              : "📌"
      const promptPreview = job.prompt.slice(0, 60) + (job.prompt.length > 60 ? "..." : "")
      const cronInfo = job.cron_expr ? ` · \`${job.cron_expr}\`` : ""
      lines.push(`${identity.emoji} *#${job.id}* ${identity.name} · ${identity.code}`)
      lines.push(`  ${typeEmoji} ${runAt}${cronInfo}`)
      lines.push(`  _${promptPreview}_\n`)
    }

    lines.push("Use `/job delete <id>` or `/job clear` to delete.")
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
  })

  bot.command("job", async (ctx) => {
    const text = ctx.message?.text ?? ""
    const args = text.replace(/^\/job\s*/, "").trim()

    // /job clear — stop all Cron instances + delete all jobs for this chat
    if (args === "clear") {
      const count = deps.scheduler.cancelAllJobs(ctx.chat.id)
      if (count > 0) {
        await ctx.reply(`✅ ${count} jobs deleted and Cron stopped.`)
      } else {
        await ctx.reply("📭 No jobs to delete.")
      }
      return
    }

    const deleteMatch = args.match(/^delete\s+(\d+)$/)
    if (!deleteMatch) {
      await ctx.reply("Usage:\n`/job delete <id>` — delete a job\n`/job clear` — delete all jobs", {
        parse_mode: "Markdown",
      })
      return
    }

    const jobId = parseInt(deleteMatch[1], 10)
    const deleted = deps.scheduler.cancelJob(jobId, ctx.chat.id)

    if (deleted) {
      await ctx.reply(`✅ Job #${jobId} deleted and Cron stopped.`)
    } else {
      await ctx.reply(`❌ Job #${jobId} not found or does not belong to this chat.`)
    }
  })

  // -------------------------------------------------------------------------
  // Prompt (change bot behavior)
  // -------------------------------------------------------------------------

  bot.command("prompt", async (ctx) => {
    const chatId = ctx.chat.id

    if (!deps.isAdmin(chatId)) {
      await ctx.reply("🔒 Unauthorized. Only admin can change behavior.")
      return
    }

    const text = ctx.message?.text ?? ""
    const args = text.replace(/^\/prompt\s*/, "").trim()
    const rc = deps.runtimeConfig

    // Show current prompt
    if (!args) {
      const current = rc.get("system_prompt")
      if (current) {
        await ctx.reply(`🧠 *Current prompt:*\n\n_${current}_\n\n_Use /prompt reset to restore default_`, {
          parse_mode: "Markdown",
        })
      } else {
        await ctx.reply("🧠 No custom prompt set.\n\nUse `/prompt <text>` to set one.", {
          parse_mode: "Markdown",
        })
      }
      return
    }

    // Reset prompt
    if (args === "reset") {
      rc.reset("system_prompt")

      // Reset session so default takes effect immediately
      const oldPool = deps.agentPools.get(chatId)
      if (oldPool) oldPool.cleanup()
      deps.agentPools.delete(chatId)
      deps.histories.delete(chatId)
      await deps.store.delete(chatId)

      await ctx.reply("✅ Prompt removed and session reset.\n\nThe bot returns to default behavior.")
      return
    }

    // Set new prompt
    try {
      const { oldValue } = rc.set("system_prompt", args)

      // Reset session so new prompt takes effect immediately
      const oldPool = deps.agentPools.get(chatId)
      if (oldPool) oldPool.cleanup()
      deps.agentPools.delete(chatId)
      deps.histories.delete(chatId)
      await deps.store.delete(chatId)

      const changed = oldValue ? `\n\n_Previous: ${oldValue.slice(0, 100)}${oldValue.length > 100 ? "..." : ""}_` : ""
      await ctx.reply(`✅ Prompt updated and session reset.${changed}\n\n🧠 _${args}_`, {
        parse_mode: "Markdown",
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`❌ Error: ${msg}`)
    }
  })

  // -------------------------------------------------------------------------
  // Config (admin only)
  // -------------------------------------------------------------------------

  bot.command("config", async (ctx) => {
    const chatId = ctx.chat.id

    if (!deps.isAdmin(chatId)) {
      await ctx.reply("🔒 Unauthorized. Only admin can configure the bot.")
      return
    }

    const text = ctx.message?.text ?? ""
    const args = text.replace(/^\/config\s*/, "").trim()
    const rc = deps.runtimeConfig

    if (!args) {
      const all = rc.getAll()
      const lines = ["⚙️ *Current configuration:*\n"]
      for (const item of all) {
        const modified = item.value !== item.defaultValue ? " ✏️" : ""
        lines.push(`\`${item.key}\` = \`${item.value || '""'}\`${modified}`)
        lines.push(`  _${item.description}_\n`)
      }
      lines.push("_Use /config <key> <value> to modify_")
      lines.push("_Use /config reset to restore defaults_")
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
      return
    }

    if (args === "reset") {
      rc.resetAll()
      await ctx.reply("✅ Configuration restored to defaults.")
      return
    }

    if (args.startsWith("reset ")) {
      const key = args.slice(6).trim()
      if (!rc.isValidKey(key)) {
        const keys = rc
          .getAllDefinitions()
          .map((d) => d.key)
          .join(", ")
        await ctx.reply(`❌ Unknown key: \`${key}\`\n\nValid keys: ${keys}`, { parse_mode: "Markdown" })
        return
      }
      const { oldValue, defaultValue } = rc.reset(key as RuntimeConfigKey)
      await ctx.reply(`✅ \`${key}\` restored\n\n\`${oldValue}\` → \`${defaultValue}\``, {
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
      await ctx.reply(`❌ Unknown key: \`${key}\`\n\nValid keys: ${keys}`, { parse_mode: "Markdown" })
      return
    }

    if (parts.length === 1) {
      const def = rc.getDefinition(key as RuntimeConfigKey)!
      const current = rc.get(key as RuntimeConfigKey)
      const modified = current !== def.defaultValue ? " ✏️" : ""
      const lines = [
        `⚙️ \`${key}\`${modified}\n`,
        `Value: \`${current || '""'}\``,
        `Default: \`${def.defaultValue || '""'}\``,
        `Type: ${def.type}`,
        `_${def.description}_`,
      ]
      if (def.min !== undefined) lines.push(`Min: ${def.min}`)
      if (def.max !== undefined) lines.push(`Max: ${def.max}`)
      if (def.enum) lines.push(`Values: ${def.enum.join(", ")}`)
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
      return
    }

    const value = parts.slice(1).join(" ")
    try {
      const { oldValue, newValue } = rc.set(key as RuntimeConfigKey, value)
      await ctx.reply(`✅ \`${key}\` updated\n\n\`${oldValue || '""'}\` → \`${newValue || '""'}\``, {
        parse_mode: "Markdown",
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`❌ Error: ${msg}`, { parse_mode: "Markdown" })
    }
  })
}
