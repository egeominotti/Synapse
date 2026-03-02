/**
 * MCP (Model Context Protocol) configuration for Claude agents.
 * Generates the JSON config file that tells `claude --mcp-config` which MCP
 * servers to connect to. Currently: bunqueue (job scheduling).
 */

import { writeFileSync, existsSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { logger } from "./logger"

interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
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

/** Build the MCP config object with bunqueue server. */
function buildMcpConfig(dbDir?: string): McpConfig {
  const env: Record<string, string> = {}
  if (dbDir) env.DATA_PATH = join(dbDir, "bunqueue.db")

  return {
    mcpServers: {
      bunqueue: {
        command: "bunx",
        args: ["bunqueue-mcp"],
        env,
      },
    },
  }
}

/**
 * Write the MCP config JSON file to disk.
 * If configPath is provided, writes there; otherwise generates a path
 * in the same directory as the database.
 * Returns the absolute path to the written config file.
 */
export function ensureMcpConfig(configPath?: string, dbDir?: string): string {
  const target = configPath ?? join(dbDir ?? join(process.env.HOME ?? "/tmp", ".claude-agent"), "mcp-config.json")
  const dir = dirname(target)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const config = buildMcpConfig(dbDir)
  writeFileSync(target, JSON.stringify(config, null, 2))
  logger.info("MCP config written", { path: target, servers: Object.keys(config.mcpServers) })
  return target
}

/** Get the names of configured MCP servers (for startup message). */
export function getMcpServerNames(): string[] {
  return Object.keys(buildMcpConfig().mcpServers)
}
