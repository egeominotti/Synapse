/**
 * MCP (Model Context Protocol) configuration for Claude agents.
 * Provides inline MCP server config for the SDK query() API.
 * Currently: bunqueue (job scheduling).
 */

import { join } from "path"

interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

/** Build MCP servers config for SDK inline use. */
export function buildMcpServers(dbDir?: string): Record<string, McpServerConfig> {
  const env: Record<string, string> = {}
  if (dbDir) env.DATA_PATH = join(dbDir, "bunqueue.db")

  return {
    bunqueue: {
      command: "bunx",
      args: ["bunqueue-mcp"],
      env,
    },
  }
}

/** Get the names of configured MCP servers (for startup message). */
export function getMcpServerNames(): string[] {
  return Object.keys(buildMcpServers())
}
