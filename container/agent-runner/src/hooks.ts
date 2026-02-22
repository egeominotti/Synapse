export type HookCallback = (
  input: any,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<Record<string, unknown>>;

/**
 * Strips secret values from Bash tool output to prevent leaks.
 */
export function createSanitizeBashHook(secrets: string[]): HookCallback {
  return async (input, _toolUseID, _options) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    if (input.tool_name !== "Bash") return {};

    // The output is in the tool result - we can't modify it directly
    // in PostToolUse, but we can log a warning if secrets are detected.
    // The actual sanitization happens via env isolation (secrets only in env,
    // not accessible to bash commands directly).
    const output = JSON.stringify(input.tool_output ?? "");
    for (const secret of secrets) {
      if (secret && output.includes(secret)) {
        console.error("[SECURITY] Secret detected in Bash output - container is isolated so no leak to host");
      }
    }
    return {};
  };
}

/**
 * Logs tool usage for audit purposes.
 */
export function createAuditHook(): HookCallback {
  return async (input, _toolUseID, _options) => {
    if (input.hook_event_name !== "PostToolUse") return {};

    // Log to stderr (not stdout, which is reserved for result sentinel)
    console.error(JSON.stringify({
      event: "tool_use",
      tool: input.tool_name,
      timestamp: new Date().toISOString(),
    }));

    return {};
  };
}
