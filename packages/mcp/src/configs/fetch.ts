import type { McpServerConfig } from "../registry.js";

export function fetchConfig(): McpServerConfig {
  return {
    command: "npx",
    args: ["-y", "@anthropic-ai/mcp-server-fetch"],
  };
}
