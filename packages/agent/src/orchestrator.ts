import type { NeoConfig, NeoEventBus, NeoQueries } from "@neo/core";
import type { ContainerRunner, ContainerPayload, ContainerResult } from "./container-runner.js";
import type { AgentRouter, RoutingDecision } from "./router.js";
import type { ChatQueue } from "./queue.js";
import type { SessionManager } from "./session-manager.js";

export interface QueryRequest {
  chatId: number;
  userId: number;
  text: string;
  replyToSessionId?: string;
}

export interface QueryResponse {
  text: string;
  sessionId: string;
  agentType: string;
  costUsd: number;
  durationMs: number;
}

export class Orchestrator {
  constructor(
    private config: NeoConfig,
    private events: NeoEventBus,
    private router: AgentRouter,
    private sessions: SessionManager,
    private containerRunner: ContainerRunner,
    private chatQueue: ChatQueue,
  ) {}

  async handleMessage(request: QueryRequest): Promise<QueryResponse> {
    return this.chatQueue.enqueue(request.chatId, () =>
      this.executeQuery(request)
    );
  }

  private async executeQuery(request: QueryRequest): Promise<QueryResponse> {
    const routing = await this.router.route(request);
    const sessionId = request.replyToSessionId
      ?? await this.sessions.getActiveSession(request.chatId);

    this.events.emit("agent:started", {
      sessionId: sessionId ?? "",
      agentType: routing.primaryAgent,
      chatId: request.chatId,
      prompt: request.text,
    });

    const containerPayload: ContainerPayload = {
      prompt: request.text,
      systemPrompt: routing.systemPrompt,
      allowedTools: routing.allowedTools,
      mcpServers: {},
      maxTurns: this.config.claude.maxTurns,
      model: routing.model ?? this.config.claude.defaultModel,
      sessionId: sessionId ?? undefined,
      secrets: this.buildSecrets(),
    };

    const result = await this.containerRunner.run(containerPayload);

    await this.sessions.saveSession(request.chatId, result.sessionId, routing.primaryAgent);

    this.events.emit("agent:completed", {
      sessionId: result.sessionId,
      agentType: routing.primaryAgent,
      result: result.text,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
    });

    return {
      text: result.text,
      sessionId: result.sessionId,
      agentType: routing.primaryAgent,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    };
  }

  private buildSecrets(): Record<string, string> {
    const secrets: Record<string, string> = {};
    if (this.config.claude.authMethod === "oauth" && this.config.claude.oauthToken) {
      secrets.CLAUDE_CODE_OAUTH_TOKEN = this.config.claude.oauthToken;
    } else if (this.config.claude.apiKey) {
      secrets.ANTHROPIC_API_KEY = this.config.claude.apiKey;
    }
    return secrets;
  }
}
