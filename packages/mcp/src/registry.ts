import type { NeoConfig } from "@neo/core";

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class McpRegistry {
  private configs = new Map<string, McpServerConfig>();

  constructor(private config: NeoConfig) {}

  initialize(): void {
    const enabled = this.config.mcp.enabled;
    const configs = this.config.mcp.configs;

    if (enabled.filesystem) {
      const paths = (configs.filesystem?.allowedPaths as string[]) ?? [];
      this.configs.set("filesystem", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", ...paths],
      });
    }

    if (enabled.git) {
      this.configs.set("git", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-git"],
      });
    }

    if (enabled.fetch) {
      this.configs.set("fetch", {
        command: "npx",
        args: ["-y", "@anthropic-ai/mcp-server-fetch"],
      });
    }

    if (enabled.github) {
      this.configs.set("github", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: configs.github?.token
          ? { GITHUB_PERSONAL_ACCESS_TOKEN: configs.github.token as string }
          : undefined,
      });
    }

    if (enabled.sqlite) {
      this.configs.set("sqlite", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sqlite", this.config.database.path],
      });
    }

    if (enabled.postgres) {
      this.configs.set("postgres", {
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-postgres",
          (configs.postgres?.connectionString as string) ?? "",
        ],
      });
    }

    if (enabled.puppeteer) {
      this.configs.set("puppeteer", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-puppeteer"],
      });
    }

    if (enabled.docker) {
      this.configs.set("docker", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-docker"],
      });
    }

    if (enabled["home-assistant"]) {
      this.configs.set("home-assistant", {
        command: "npx",
        args: ["-y", "homeassistant-mcp"],
        env: configs["home-assistant"]?.token
          ? { HA_TOKEN: configs["home-assistant"].token as string }
          : undefined,
      });
    }
  }

  getConfigsForAgent(_agentType: string): Record<string, McpServerConfig> {
    // For now, all agents get all configs. Can be refined per-agent later.
    return Object.fromEntries(this.configs);
  }

  getActiveConfigs(): Record<string, McpServerConfig> {
    return Object.fromEntries(this.configs);
  }

  getServerNames(): string[] {
    return [...this.configs.keys()];
  }
}
