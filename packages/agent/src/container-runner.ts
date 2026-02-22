import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { NeoConfig, Logger } from "@neo/core";

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
  agents?: Record<string, unknown>;
}

export interface ContainerResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
}

export class ContainerRunner {
  constructor(
    private config: NeoConfig,
    private logger: Logger,
  ) {}

  async run(payload: ContainerPayload): Promise<ContainerResult> {
    const containerName = `neo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ipcPath = resolve(process.cwd(), "data/ipc");

    const args = [
      "run",
      "--rm",
      "-i",
      "--name",
      containerName,
      "--memory",
      this.config.docker.memoryLimit,
      "--cpus",
      this.config.docker.cpuLimit,
      // Mount workspace and IPC directories
      "-v",
      `${ipcPath}:/ipc:rw`,
      this.config.docker.imageName,
    ];

    this.logger.info({ container: containerName, model: payload.model }, "Spawning container");

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
        // Log agent-runner stderr output (audit, errors)
        const lines = chunk.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          this.logger.debug({ container: containerName, stderr: line }, "Container stderr");
        }
      });

      proc.on("close", (code) => {
        this.logger.info({ container: containerName, code }, "Container exited");

        // Even on non-zero exit, try to parse result (agent-runner writes result on error too)
        const startIdx = stdout.indexOf(SENTINEL_START);
        const endIdx = stdout.indexOf(SENTINEL_END);

        if (startIdx !== -1 && endIdx !== -1) {
          const resultJson = stdout.slice(startIdx + SENTINEL_START.length, endIdx);
          try {
            resolve(JSON.parse(resultJson));
            return;
          } catch {
            // Fall through to error handling
          }
        }

        if (code !== 0) {
          reject(new Error(`Container exited with code ${code}: ${stderr.slice(0, 2000)}`));
          return;
        }

        reject(
          new Error(`Container output missing sentinel markers. stdout: ${stdout.slice(0, 2000)}`),
        );
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn container: ${err.message}`));
      });
    });
  }
}
