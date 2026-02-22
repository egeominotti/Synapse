/**
 * MCP (Model Context Protocol) server configuration.
 * Generates and manages the MCP config file used by Claude CLI.
 * Default servers: Memory (knowledge graph) + Sequential Thinking.
 */

import { writeFileSync, mkdirSync } from "fs"
import { dirname } from "path"
import { logger } from "./logger"

export interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
}

const DEFAULT_MCP_SERVERS: McpConfig = {
  mcpServers: {
    memory: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
    "sequential-thinking": {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
  },
}

/** Write the MCP config file. Overwrites on every boot to stay in sync. */
export function ensureMcpConfig(configPath: string): string {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(DEFAULT_MCP_SERVERS, null, 2))
  logger.info("MCP config written", {
    path: configPath,
    servers: Object.keys(DEFAULT_MCP_SERVERS.mcpServers),
  })
  return configPath
}
