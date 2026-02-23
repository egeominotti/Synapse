/**
 * MCP (Model Context Protocol) server configuration.
 * Generates and manages the MCP config file used by Claude CLI.
 *
 * Active servers:
 *   - Fetch           — read any URL / webpage
 *
 * Disabled (too much startup overhead for sandbox agents):
 *   - Memory          — bot has its own memory system (src/memory.ts)
 *   - Sequential Thinking — adds ~30s latency per spawn
 *   - Filesystem      — Claude already has filesystem access in sandbox via CLI
 *   - Git             — sandbox has no git repos
 *   - SQLite          — bot manages DB internally
 *   - Everything      — unnecessary in a temp sandbox
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
    fetch: {
      command: "uvx",
      args: ["mcp-server-fetch"],
    },
    // --- Disabled: too much startup overhead ---
    // memory: {
    //   command: "npx",
    //   args: ["-y", "@modelcontextprotocol/server-memory"],
    // },
    // "sequential-thinking": {
    //   command: "npx",
    //   args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    // },
    // filesystem: {
    //   command: "npx",
    //   args: ["-y", "@modelcontextprotocol/server-filesystem"],
    // },
    // everything: {
    //   command: "npx",
    //   args: ["-y", "@modelcontextprotocol/server-everything"],
    // },
    // git: {
    //   command: "uvx",
    //   args: ["mcp-server-git"],
    // },
    // sqlite: {
    //   command: "uvx",
    //   args: ["mcp-server-sqlite"],
    // },
  },
}

/** Get the list of default MCP server names. */
export function getMcpServerNames(): string[] {
  return Object.keys(DEFAULT_MCP_SERVERS.mcpServers)
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
