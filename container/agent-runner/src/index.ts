import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback } from "./hooks.js";
import { createSanitizeBashHook, createAuditHook } from "./hooks.js";

const SENTINEL_START = "---NEO-RESULT-START---";
const SENTINEL_END = "---NEO-RESULT-END---";

interface AgentPayload {
  prompt: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  maxTurns: number;
  model: string;
  sessionId?: string;
  secrets: Record<string, string>;
  agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: "sonnet" | "opus" | "haiku" | "inherit" }>;
}

interface AgentResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const input = await readStdin();
  const payload: AgentPayload = JSON.parse(input);

  // Set secrets as env vars (in-memory only, container is ephemeral)
  const secretValues: string[] = [];
  for (const [key, value] of Object.entries(payload.secrets)) {
    process.env[key] = value;
    secretValues.push(value);
  }

  // Build hooks
  const sanitizeHook = createSanitizeBashHook(secretValues);
  const auditHook = createAuditHook();

  // Build options for Agent SDK
  const options = {
    systemPrompt: payload.systemPrompt,
    allowedTools: payload.allowedTools,
    mcpServers: payload.mcpServers,
    maxTurns: payload.maxTurns,
    model: payload.model,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    env: payload.secrets,
    cwd: "/workspace",
    hooks: {
      PostToolUse: [
        { hooks: [sanitizeHook, auditHook] },
      ],
    },
    ...(payload.sessionId ? { resume: payload.sessionId } : {}),
    ...(payload.agents ? { agents: payload.agents } : {}),
  };

  // Execute query
  let resultText = "";
  let sessionId = "";
  let costUsd = 0;
  let durationMs = 0;
  let numTurns = 0;

  for await (const message of query({ prompt: payload.prompt, options })) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    }
    if (message.type === "result") {
      if (message.subtype === "success") {
        resultText = message.result;
      } else {
        resultText = `[Error: ${message.subtype}] ${(message as any).errors?.join(", ") ?? "Unknown error"}`;
      }
      costUsd = message.total_cost_usd;
      durationMs = message.duration_ms;
      numTurns = message.num_turns;
    }
  }

  // Write result with sentinel markers
  const result: AgentResult = { text: resultText, sessionId, costUsd, durationMs, numTurns };
  process.stdout.write(SENTINEL_START + JSON.stringify(result) + SENTINEL_END);
}

main().catch((err) => {
  // On error, still write a result so the host can parse it
  const errorResult: AgentResult = {
    text: `[Agent runner error] ${err instanceof Error ? err.message : String(err)}`,
    sessionId: "",
    costUsd: 0,
    durationMs: 0,
    numTurns: 0,
  };
  process.stdout.write(SENTINEL_START + JSON.stringify(errorResult) + SENTINEL_END);
  process.exit(1);
});
