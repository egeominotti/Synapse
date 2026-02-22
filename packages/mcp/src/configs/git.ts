import type { McpServerConfig } from "../registry.js";

export function gitConfig(): McpServerConfig {
  return {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-git"],
  };
}
