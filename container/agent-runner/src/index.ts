// Agent runner - runs inside Docker container
// Will be implemented in Fase 2

const SENTINEL_START = "---NEO-RESULT-START---";
const SENTINEL_END = "---NEO-RESULT-END---";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const input = await readStdin();
  const payload = JSON.parse(input);

  // Set secrets as env vars (in-memory only, container is ephemeral)
  for (const [key, value] of Object.entries(payload.secrets as Record<string, string>)) {
    process.env[key] = value;
  }

  // TODO: Import and use @anthropic-ai/claude-agent-sdk query()
  // For now, echo back a test response
  const result = {
    text: `[Neo agent-runner] Received prompt: "${payload.prompt}"`,
    sessionId: `test-${Date.now()}`,
    costUsd: 0,
    durationMs: 0,
    numTurns: 0,
  };

  process.stdout.write(SENTINEL_START + JSON.stringify(result) + SENTINEL_END);
}

main().catch((err) => {
  console.error("Agent runner error:", err);
  process.exit(1);
});
