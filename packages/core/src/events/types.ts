export interface NeoEventMap {
  "message:received": {
    chatId: number;
    userId: number;
    text: string;
    timestamp: Date;
  };
  "message:response": {
    chatId: number;
    text: string;
    agentType: string;
    sessionId: string;
    costUsd: number;
    durationMs: number;
  };
  "agent:started": {
    sessionId: string;
    agentType: string;
    chatId: number;
    prompt: string;
  };
  "agent:completed": {
    sessionId: string;
    agentType: string;
    result: string;
    costUsd: number;
    durationMs: number;
    numTurns: number;
  };
  "agent:error": {
    sessionId: string;
    agentType: string;
    error: string;
  };
  "tool:used": {
    sessionId: string;
    toolName: string;
    input: unknown;
    output: unknown;
    durationMs: number;
  };
  "mcp:status": {
    serverName: string;
    status: "connected" | "failed" | "restarting";
  };
  "permission:request": {
    sessionId: string;
    toolName: string;
    input: unknown;
    chatId: number;
  };
  "cost:update": {
    totalCostUsd: number;
    sessionCostUsd: number;
    sessionId: string;
  };
  "queue:status": {
    chatId: number;
    pending: number;
    processing: boolean;
  };
}
