import { spawn } from "node:child_process";
import type { NeoConfig } from "@neo/core";

const SENTINEL_START = "---NEO-RESULT-START---";
const SENTINEL_END = "---NEO-RESULT-END---";

export interface ContainerPayload {
  prompt: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpServers: Record<string, unknown>;
  maxTurns: number;
  model: string;
  sessionId?: string;
  secrets: Record<string, string>;
  agents?: unknown[];
}

export interface ContainerResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
}

export class ContainerRunner {
  constructor(private config: NeoConfig) {}

  async run(payload: ContainerPayload): Promise<ContainerResult> {
    const containerName = `neo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const args = [
      "run", "--rm", "-i",
      "--name", containerName,
      "--memory", this.config.docker.memoryLimit,
      "--cpus", this.config.docker.cpuLimit,
      this.config.docker.imageName,
    ];

    return new Promise<ContainerResult>((resolve, reject) => {
      const proc = spawn("docker", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Pass payload (including secrets) via stdin - never on disk
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Container exited with code ${code}: ${stderr.slice(0, 2000)}`));
          return;
        }

        const startIdx = stdout.indexOf(SENTINEL_START);
        const endIdx = stdout.indexOf(SENTINEL_END);

        if (startIdx === -1 || endIdx === -1) {
          reject(new Error(`Container output missing sentinel markers. stdout: ${stdout.slice(0, 2000)}`));
          return;
        }

        const resultJson = stdout.slice(startIdx + SENTINEL_START.length, endIdx);
        try {
          resolve(JSON.parse(resultJson));
        } catch {
          reject(new Error(`Failed to parse container result: ${resultJson.slice(0, 500)}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn container: ${err.message}`));
      });
    });
  }
}
