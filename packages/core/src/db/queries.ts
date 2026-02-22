import { eq, desc } from "drizzle-orm";
import type { NeoDb } from "./index.js";
import * as schema from "./schema.js";

export function createQueries(db: NeoDb) {
  return {
    // Conversations
    getOrCreateConversation(chatId: number, chatType: string, chatTitle?: string) {
      const existing = db.select().from(schema.conversations)
        .where(eq(schema.conversations.chatId, chatId))
        .get();
      if (existing) return existing;

      const now = new Date().toISOString();
      return db.insert(schema.conversations).values({
        chatId,
        chatType,
        chatTitle: chatTitle ?? null,
        lastActivityAt: now,
        createdAt: now,
      }).returning().get();
    },

    updateConversationActivity(chatId: number, sessionId: string) {
      db.update(schema.conversations)
        .set({ lastSessionId: sessionId, lastActivityAt: new Date().toISOString() })
        .where(eq(schema.conversations.chatId, chatId))
        .run();
    },

    // Messages
    saveMessage(data: {
      conversationId: number;
      role: string;
      content: string;
      userId?: number;
      agentType?: string;
      sessionId?: string;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
      telegramMessageId?: number;
    }) {
      return db.insert(schema.messages).values({
        ...data,
        userId: data.userId ?? null,
        agentType: data.agentType ?? null,
        sessionId: data.sessionId ?? null,
        costUsd: data.costUsd ?? null,
        durationMs: data.durationMs ?? null,
        numTurns: data.numTurns ?? null,
        telegramMessageId: data.telegramMessageId ?? null,
        createdAt: new Date().toISOString(),
      }).returning().get();
    },

    getRecentMessages(conversationId: number, limit = 20) {
      return db.select().from(schema.messages)
        .where(eq(schema.messages.conversationId, conversationId))
        .orderBy(desc(schema.messages.id))
        .limit(limit)
        .all()
        .reverse();
    },

    // Sessions
    saveSession(data: { id: string; chatId: number; agentType: string }) {
      const now = new Date().toISOString();
      const existing = db.select().from(schema.sessions)
        .where(eq(schema.sessions.id, data.id))
        .get();

      if (existing) {
        db.update(schema.sessions)
          .set({ lastUsedAt: now })
          .where(eq(schema.sessions.id, data.id))
          .run();
        return existing;
      }

      return db.insert(schema.sessions).values({
        ...data,
        status: "active",
        createdAt: now,
        lastUsedAt: now,
      }).returning().get();
    },

    getActiveSession(chatId: number) {
      return db.select().from(schema.sessions)
        .where(eq(schema.sessions.chatId, chatId))
        .orderBy(desc(schema.sessions.lastUsedAt))
        .limit(1)
        .get();
    },

    // Audit
    logAudit(data: {
      sessionId?: string;
      chatId?: number;
      userId?: number;
      eventType: string;
      toolName?: string;
      toolInput?: unknown;
      toolOutput?: unknown;
      costUsd?: number;
      durationMs?: number;
    }) {
      return db.insert(schema.auditLog).values({
        sessionId: data.sessionId ?? null,
        chatId: data.chatId ?? null,
        userId: data.userId ?? null,
        eventType: data.eventType,
        toolName: data.toolName ?? null,
        toolInput: data.toolInput ? JSON.stringify(data.toolInput).slice(0, 10240) : null,
        toolOutput: data.toolOutput ? JSON.stringify(data.toolOutput).slice(0, 5120) : null,
        costUsd: data.costUsd ?? null,
        durationMs: data.durationMs ?? null,
        createdAt: new Date().toISOString(),
      }).returning().get();
    },
  };
}

export type NeoQueries = ReturnType<typeof createQueries>;
