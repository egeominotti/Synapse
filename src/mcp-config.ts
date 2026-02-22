/**
 * MCP (Model Context Protocol) server configuration.
 * Generates and manages the MCP config file used by Claude CLI.
 *
 * Default servers (always active):
 *   - Memory          — persistent knowledge graph
 *   - Sequential Thinking — structured reasoning
 *   - Fetch           — read any URL / webpage
 *   - Filesystem      — file access (scoped to sandbox)
 *   - Git             — clone, diff, log, blame
 *   - SQLite          — query SQLite databases
 *   - Everything      — universal file search
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
    // --- Node.js servers (npx) ---
    memory: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
    "sequential-thinking": {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    },
    everything: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    },
    // --- Python servers (uvx) ---
    fetch: {
      command: "uvx",
      args: ["mcp-server-fetch"],
    },
    git: {
      command: "uvx",
      args: ["mcp-server-git"],
    },
    sqlite: {
      command: "uvx",
      args: ["mcp-server-sqlite"],
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
