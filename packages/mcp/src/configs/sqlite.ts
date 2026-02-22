import type { McpServerConfig } from "../registry.js";

export function sqliteConfig(dbPath: string): McpServerConfig {
  return {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite", dbPath],
  };
}
