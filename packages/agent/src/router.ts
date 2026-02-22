import type { QueryRequest } from "./orchestrator.js";

export interface RoutingDecision {
  primaryAgent: string;
  systemPrompt: string;
  allowedTools: string[];
  model?: string;
  agents?: unknown[];
}

interface PatternMatch {
  regex: RegExp;
  agentKey: string;
  priority: number;
}

const AGENT_PROMPTS: Record<string, { systemPrompt: string; allowedTools: string[]; model?: string }> = {
  general: {
    systemPrompt: `You are Neo, a personal AI assistant. You are helpful, concise, and capable.
You have access to various tools to help the user with coding, research, system administration, and more.
Always respond in the same language the user uses.`,
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Task"],
  },
  coder: {
    systemPrompt: `You are Neo in coding mode. You are an expert software engineer.
Focus on writing clean, correct, and efficient code. Use tools to read, edit, and test code.
Always respond in the same language the user uses.`,
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    model: "sonnet",
  },
  researcher: {
    systemPrompt: `You are Neo in research mode. You are a research specialist.
Use web search and fetch to find accurate, up-to-date information.
Always cite sources and respond in the same language the user uses.`,
    allowedTools: ["WebSearch", "WebFetch", "Read", "Write"],
    model: "sonnet",
  },
  sysadmin: {
    systemPrompt: `You are Neo in sysadmin mode. You are a senior system administrator.
Help with server management, Docker, networking, and infrastructure tasks.
Always respond in the same language the user uses.`,
    allowedTools: ["Bash", "Read", "Write", "Edit"],
    model: "sonnet",
  },
  "smart-home": {
    systemPrompt: `You are Neo in smart home mode. You control home automation via Home Assistant.
Help the user manage lights, thermostats, locks, and other IoT devices.
Always respond in the same language the user uses.`,
    allowedTools: ["Read"],
    model: "haiku",
  },
  "data-analyst": {
    systemPrompt: `You are Neo in data analysis mode. You are a data analyst.
Help with SQL queries, data exploration, CSV analysis, and reporting.
Always respond in the same language the user uses.`,
    allowedTools: ["Read", "Write", "Bash"],
    model: "sonnet",
  },
};

export class AgentRouter {
  private patterns: PatternMatch[] = [
    { regex: /\b(code|bug|fix|refactor|implement|test|deploy|git|commit|pr)\b/i, agentKey: "coder", priority: 10 },
    { regex: /\b(server|docker|container|nginx|ssh|process|port|systemctl)\b/i, agentKey: "sysadmin", priority: 9 },
    { regex: /\b(light|thermostat|temperature|lock|camera|sensor|home|room)\b/i, agentKey: "smart-home", priority: 9 },
    { regex: /\b(search|find|research|look up|what is|latest|news)\b/i, agentKey: "researcher", priority: 8 },
    { regex: /\b(query|database|sql|table|analyze|data|csv|report)\b/i, agentKey: "data-analyst", priority: 8 },
  ];

  async route(request: QueryRequest): Promise<RoutingDecision> {
    // Tier 1: Explicit command
    const cmdMatch = request.text.match(/^\/(\w+)\s/);
    if (cmdMatch) {
      const agentKey = cmdMatch[1];
      if (agentKey in AGENT_PROMPTS) {
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

    // Tier 3: Default to general
    return this.buildDecision("general");
  }

  private buildDecision(agentKey: string): RoutingDecision {
    const agent = AGENT_PROMPTS[agentKey] ?? AGENT_PROMPTS.general;
    return {
      primaryAgent: agentKey,
      systemPrompt: agent.systemPrompt,
      allowedTools: agent.allowedTools,
      model: agent.model,
    };
  }
}
