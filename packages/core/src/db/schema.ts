import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  chatType: text("chat_type").notNull(), // "private" | "group" | "supergroup"
  chatTitle: text("chat_title"),
  lastSessionId: text("last_session_id"),
  lastActivityAt: text("last_activity_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  role: text("role").notNull(), // "user" | "assistant" | "system"
  content: text("content").notNull(),
  userId: integer("user_id"),
  agentType: text("agent_type"),
  sessionId: text("session_id"),
  costUsd: real("cost_usd"),
  durationMs: integer("duration_ms"),
  numTurns: integer("num_turns"),
  telegramMessageId: integer("telegram_message_id"),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), // Claude Agent SDK session_id
  chatId: integer("chat_id").notNull(),
  agentType: text("agent_type").notNull(),
  status: text("status").notNull(), // "active" | "completed" | "error"
  totalCostUsd: real("total_cost_usd").default(0),
  totalTurns: integer("total_turns").default(0),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id"),
  chatId: integer("chat_id"),
  userId: integer("user_id"),
  eventType: text("event_type").notNull(), // "tool_use" | "permission_grant" | "permission_deny" | "error"
  toolName: text("tool_name"),
  toolInput: text("tool_input"), // JSON, max 10KB
  toolOutput: text("tool_output"), // JSON, max 5KB
  costUsd: real("cost_usd"),
  durationMs: integer("duration_ms"),
  createdAt: text("created_at").notNull(),
});

export const scheduledTasks = sqliteTable("scheduled_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  cronExpression: text("cron_expression"),
  nextRunAt: text("next_run_at"),
  lastRunAt: text("last_run_at"),
  prompt: text("prompt").notNull(),
  agentType: text("agent_type").default("general"),
  status: text("status").notNull(), // "active" | "paused" | "completed" | "failed"
  createdAt: text("created_at").notNull(),
});

export const memories = sqliteTable("memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull(),
  userId: integer("user_id"),
  key: text("key").notNull(),
  value: text("value").notNull(),
  category: text("category").notNull(), // "preference" | "fact" | "context" | "instruction"
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const costTracking = sqliteTable("cost_tracking", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id"),
  chatId: integer("chat_id"),
  model: text("model"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: real("cost_usd"),
  createdAt: text("created_at").notNull(),
});
