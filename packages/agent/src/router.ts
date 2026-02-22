import type { QueryRequest } from "./orchestrator.js";
import { agentRegistry } from "./agents/definitions.js";

export interface RoutingDecision {
  primaryAgent: string;
  systemPrompt: string;
  allowedTools: string[];
  model?: string;
  agents?: Record<
    string,
    {
      description: string;
      prompt: string;
      tools?: string[];
      model?: "sonnet" | "opus" | "haiku" | "inherit";
    }
  >;
}

interface PatternMatch {
  regex: RegExp;
  agentKey: string;
  priority: number;
}

export class AgentRouter {
  private patterns: PatternMatch[] = [
    {
      regex:
        /\b(code|bug|fix|refactor|implement|test|deploy|git|commit|pr|typescript|python|rust|java)\b/i,
      agentKey: "coder",
      priority: 10,
    },
    {
      regex: /\b(server|docker|container|nginx|ssh|process|port|systemctl|devops|deploy)\b/i,
      agentKey: "sysadmin",
      priority: 9,
    },
    {
      regex: /\b(light|thermostat|temperature|lock|camera|sensor|accendi|spegni|riscaldamento)\b/i,
      agentKey: "smart-home",
      priority: 9,
    },
    {
      regex: /\b(search|find|research|look up|what is|latest|news|cerca|ultime)\b/i,
      agentKey: "researcher",
      priority: 8,
    },
    {
      regex: /\b(query|database|sql|table|analyze|data|csv|report|analizza)\b/i,
      agentKey: "data-analyst",
      priority: 8,
    },
  ];

  async route(request: QueryRequest): Promise<RoutingDecision> {
    // Tier 1: Explicit command (/code, /research, etc.)
    const cmdMatch = request.text.match(/^\/(\w+)(?:\s|$)/);
    if (cmdMatch) {
      const agentKey = cmdMatch[1];
      if (agentKey in agentRegistry) {
        return this.buildDecision(agentKey);
      }
    }

    // Tier 2: Pattern matching with priority
    let best: { agentKey: string; priority: number } | null = null;
    for (const p of this.patterns) {
      if (p.regex.test(request.text) && (!best || p.priority > best.priority)) {
        best = { agentKey: p.agentKey, priority: p.priority };
      }
    }
    if (best) {
      return this.buildDecision(best.agentKey);
    }

    // Tier 3: Default to general (with all subagents)
    return this.buildDecision("general");
  }

  private buildDecision(agentKey: string): RoutingDecision {
    const agent = agentRegistry[agentKey] ?? agentRegistry.general;
    return {
      primaryAgent: agentKey,
      systemPrompt: agent.systemPrompt,
      allowedTools: agent.allowedTools,
      model: agent.model,
      agents: agent.subagents,
    };
  }
}
