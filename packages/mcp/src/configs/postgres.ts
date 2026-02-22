import type { McpServerConfig } from "../registry.js";

export function postgresConfig(connectionString: string): McpServerConfig {
  return {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", connectionString],
  };
}
