import type { McpServerConfig } from "../registry.js";

export function githubConfig(token?: string): McpServerConfig {
  return {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: token ? { GITHUB_PERSONAL_ACCESS_TOKEN: token } : undefined,
  };
}
