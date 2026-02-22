import type { NeoQueries } from "@neo/core";

export class SessionManager {
  constructor(private queries: NeoQueries) {}

  async getActiveSession(chatId: number): Promise<string | null> {
    const session = this.queries.getActiveSession(chatId);
    return session?.id ?? null;
  }

  async saveSession(chatId: number, sessionId: string, agentType: string): Promise<void> {
    this.queries.saveSession({ id: sessionId, chatId, agentType });
  }
}
