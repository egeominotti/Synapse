/**
 * Telegram bot slash commands: /start, /help, /reset, /stats, /ping,
 * /export, /schedule, /jobs, /job, /config.
 */

import { InputFile, type Bot } from "grammy"
import { logger } from "../logger"
import type { RuntimeConfigKey } from "../types"
import type { TelegramDeps } from "./handlers"

/** Build reply_parameters so every response quotes the original message (essential in groups). */
function replyParams(ctx: { msg?: { message_id: number } }) {
  const mid = ctx.msg?.message_id
  return mid ? { reply_parameters: { message_id: mid } } : {}
}

export function registerCommands(bot: Bot, deps: TelegramDeps): void {
  bot.command("start", async (ctx) => {
    const lines = [
      "👋 Hello! I'm <b>Synapse</b>, your Claude agent.\n",
      "Here's what I can do:\n",
      "💬 Text — write me anything",
      "📷 Photos — send a photo for visual analysis",
      "📎 Documents — upload a file for analysis",
      "✏️ Edit — edit a sent message to resend it",
    ]
    if (deps.whisperConfig) {
      lines.push("🎙 Voice — send a voice message and I'll transcribe + respond")
    }
    lines.push("", "/help — all commands  ·  /reset — new conversation")
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", ...replyParams(ctx) })
  })

  bot.command("help", async (ctx) => {
    const lines = [
      "📋 *Available commands:*\n",
      "/start — welcome message",
      "/reset — reset the conversation",
      "/stats — current session statistics",
      "/export — export conversation as file",
      "/ping — bot status",
      "/memory — view persistent memory",
    ]
    if (deps.isAdmin(ctx.chat.id)) {
      lines.push("/prompt — change bot behavior (admin)")
      lines.push("/config — runtime configuration (admin)")
    }
    lines.push(
      "",
      "💬 Write any message to talk with Claude.",
      "📷 Send a photo (with or without caption) for visual analysis.",
      "📎 Upload documents for analysis.",
      "✏️ Edit a message to resend it to Claude."
    )
    if (deps.whisperConfig) {
      lines.push("🎙 Send a voice or audio message for transcription + response.")
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", ...replyParams(ctx) })
  })

  bot.command("reset", async (ctx) => {
    const chatId = ctx.chat.id
    const agent = deps.agents.get(chatId)
    if (agent) agent.cleanup()
    deps.agents.delete(chatId)
    deps.histories.delete(chatId)
    await deps.store.delete(chatId)
    logger.info("Session reset", { chatId })
    await ctx.reply("🔄 Session reset. You can start a new conversation.", replyParams(ctx))
  })

  bot.command("stats", async (ctx) => {
    const chatId = ctx.chat.id
    const agent = deps.agents.get(chatId)
    const savedSid = deps.store.get(chatId)
    const sid = agent?.getSessionId() ?? savedSid

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

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", ...replyParams(ctx) })
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
      `Active agents: *${deps.agents.size}*`,
      `Telegram sessions: *${deps.store.size}*`,
      `DB: ✅ operational`,
    ]

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", ...replyParams(ctx) })
  })

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------

  bot.command("memory", async (ctx) => {
    const chatId = ctx.chat.id
    const text = ctx.message?.text ?? ""
    const args = text.replace(/^\/memory\s*/, "").trim()

    if (args === "reset") {
      if (!deps.isAdmin(chatId)) {
        await ctx.reply("🔒 Only admin can reset memory.", replyParams(ctx))
        return
      }
      deps.db.deleteChatMemory(chatId)
      await ctx.reply("🧹 Chat memory cleared.", replyParams(ctx))
      return
    }

    const memory = deps.db.getChatMemory(chatId)
    if (!memory) {
      await ctx.reply("🧠 No memory stored yet. I'll start remembering as we chat.", replyParams(ctx))
      return
    }

    const lines = [
      "🧠 *Chat memory:*\n",
      memory.length > 3000 ? memory.slice(0, 3000) + "\n\n_(truncated)_" : memory,
      `\n_${memory.length} chars · /memory reset to clear_`,
    ]
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", ...replyParams(ctx) })
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
      await ctx.reply("📭 No session to export. Start a conversation first.", replyParams(ctx))
      return
    }

    const messages = deps.db.getMessages(sid)
    if (messages.length === 0) {
      await ctx.reply("📭 Empty session, nothing to export.", replyParams(ctx))
      return
    }

    const lines: string[] = [`# Session ${sid.slice(0, 16)}`, ""]
    for (const msg of messages) {
      const date = new Date(msg.timestamp).toLocaleString("en-US", { timeZone: "Europe/Rome" })
      lines.push(`## 👤 User — ${date}`)
      lines.push("", msg.prompt, "")
      lines.push(`## ◉ Synapse — ${(msg.duration_ms / 1000).toFixed(1)}s`)
      lines.push("", msg.response, "")
      lines.push("---", "")
    }

    const content = lines.join("\n")
    const filename = `session-${sid.slice(0, 8)}.md`
    const buffer = Buffer.from(content)

    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption: `📄 ${messages.length} messages exported`,
      ...replyParams(ctx),
    })
  })

  // -------------------------------------------------------------------------
  // Prompt (change bot behavior)
  // -------------------------------------------------------------------------

  bot.command("prompt", async (ctx) => {
    const chatId = ctx.chat.id

    if (!deps.isAdmin(chatId)) {
      await ctx.reply("🔒 Unauthorized. Only admin can change behavior.", replyParams(ctx))
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
          ...replyParams(ctx),
        })
      } else {
        await ctx.reply("🧠 No custom prompt set.\n\nUse `/prompt <text>` to set one.", {
          parse_mode: "Markdown",
          ...replyParams(ctx),
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

      await ctx.reply("✅ Prompt removed and session reset.\n\nThe bot returns to default behavior.", replyParams(ctx))
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

      const changed = oldValue ? `\n\n_Previous: ${oldValue.slice(0, 100)}${oldValue.length > 100 ? "..." : ""}_` : ""
      await ctx.reply(`✅ Prompt updated and session reset.${changed}\n\n🧠 _${args}_`, {
        parse_mode: "Markdown",
        ...replyParams(ctx),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`❌ Error: ${msg}`, replyParams(ctx))
    }
  })

  // -------------------------------------------------------------------------
  // Config (admin only)
  // -------------------------------------------------------------------------

  bot.command("config", async (ctx) => {
    const chatId = ctx.chat.id

    if (!deps.isAdmin(chatId)) {
      await ctx.reply("🔒 Unauthorized. Only admin can configure the bot.", replyParams(ctx))
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
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", ...replyParams(ctx) })
      return
    }

    if (args === "reset") {
      rc.resetAll()
      await ctx.reply("✅ Configuration restored to defaults.", replyParams(ctx))
      return
    }

    if (args.startsWith("reset ")) {
      const key = args.slice(6).trim()
      if (!rc.isValidKey(key)) {
        const keys = rc
          .getAllDefinitions()
          .map((d) => d.key)
          .join(", ")
        await ctx.reply(`❌ Unknown key: \`${key}\`\n\nValid keys: ${keys}`, {
          parse_mode: "Markdown",
          ...replyParams(ctx),
        })
        return
      }
      const { oldValue, defaultValue } = rc.reset(key as RuntimeConfigKey)
      await ctx.reply(`✅ \`${key}\` restored\n\n\`${oldValue}\` → \`${defaultValue}\``, {
        parse_mode: "Markdown",
        ...replyParams(ctx),
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
      await ctx.reply(`❌ Unknown key: \`${key}\`\n\nValid keys: ${keys}`, {
        parse_mode: "Markdown",
        ...replyParams(ctx),
      })
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
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", ...replyParams(ctx) })
      return
    }

    const value = parts.slice(1).join(" ")
    try {
      const { oldValue, newValue } = rc.set(key as RuntimeConfigKey, value)
      await ctx.reply(`✅ \`${key}\` updated\n\n\`${oldValue || '""'}\` → \`${newValue || '""'}\``, {
        parse_mode: "Markdown",
        ...replyParams(ctx),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`❌ Error: ${msg}`, { parse_mode: "Markdown", ...replyParams(ctx) })
    }
  })
}
