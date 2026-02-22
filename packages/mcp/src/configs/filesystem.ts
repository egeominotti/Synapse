import type { McpServerConfig } from "../registry.js";

export function filesystemConfig(allowedPaths: string[]): McpServerConfig {
  return {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", ...allowedPaths],
  };
}
