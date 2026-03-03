/**
 * SDK hook factories for Synapse agents.
 *
 * Hooks intercept tool calls, notifications, and lifecycle events.
 * Factory functions return HookCallbackMatcher arrays ready for the SDK.
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  NotificationHookInput,
} from "@anthropic-ai/claude-agent-sdk"
import { logger } from "./logger"

/** Context provided to hook factories for Telegram-aware hooks. */
export interface HookContext {
  onToolComplete?: (toolName: string, toolInput: unknown, toolResponse: unknown) => void
  onToolFailure?: (toolName: string, error: string) => void
  onNotification?: (message: string, title?: string) => void
}

/** Patterns that indicate sensitive files — never allow writes. */
const SENSITIVE_PATTERNS = [
  /\.env($|\.)/,
  /credentials/i,
  /secrets?\.(?:json|ya?ml|toml)/i,
  /\.(pem|key|crt|cert)$/i,
  /id_rsa/,
  /\.ssh\//,
  /\.aws\//,
  /\.gnupg\//,
]

/** Extract file path from tool input (Write, Edit, Bash). */
function extractFilePath(toolName: string, toolInput: unknown): string | null {
  const input = toolInput as Record<string, unknown>
  if (toolName === "Write" || toolName === "Edit") {
    return (input.file_path ?? input.path ?? null) as string | null
  }
  if (toolName === "Bash") {
    const cmd = (input.command ?? "") as string
    // Detect common write patterns: >, >>, tee, cp, mv targeting sensitive files
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(cmd)) return cmd
    }
  }
  return null
}

/** PreToolUse: block writes to sensitive files (.env, credentials, keys). */
export function createSecurityHooks(): HookCallbackMatcher[] {
  const hook: HookCallback = async (input): Promise<HookJSONOutput> => {
    const pre = input as PreToolUseHookInput
    const filePath = extractFilePath(pre.tool_name, pre.tool_input)
    if (!filePath) return {}

    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(filePath)) {
        logger.warn("Security hook blocked sensitive file access", {
          tool: pre.tool_name,
          path: filePath.slice(0, 100),
          pattern: pattern.source,
        })
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `Blocked: writing to sensitive file matching ${pattern.source}`,
          },
        }
      }
    }
    return {}
  }

  return [{ matcher: "Write|Edit|Bash", hooks: [hook] }]
}

/** PreToolUse + PostToolUse + PostToolUseFailure: structured logging via pino. */
export function createLoggingHooks(): {
  pre: HookCallbackMatcher[]
  post: HookCallbackMatcher[]
  failure: HookCallbackMatcher[]
} {
  const preHook: HookCallback = async (input): Promise<HookJSONOutput> => {
    const pre = input as PreToolUseHookInput
    logger.info("Hook: tool called", {
      tool: pre.tool_name,
      toolId: pre.tool_use_id?.slice(0, 16),
      input: JSON.stringify(pre.tool_input ?? {}).slice(0, 200),
    })
    return {}
  }

  const postHook: HookCallback = async (input): Promise<HookJSONOutput> => {
    const post = input as PostToolUseHookInput
    logger.debug("Hook: tool completed", {
      tool: post.tool_name,
      toolId: post.tool_use_id?.slice(0, 16),
    })
    return {}
  }

  const failureHook: HookCallback = async (input): Promise<HookJSONOutput> => {
    const fail = input as PostToolUseFailureHookInput
    logger.warn("Hook: tool failed", {
      tool: fail.tool_name,
      toolId: fail.tool_use_id?.slice(0, 16),
      error: fail.error?.slice(0, 200),
    })
    return {}
  }

  return {
    pre: [{ hooks: [preHook] }],
    post: [{ hooks: [postHook] }],
    failure: [{ hooks: [failureHook] }],
  }
}

/** PostToolUse: fire progress callback for file writes. */
export function createProgressHooks(ctx: HookContext): HookCallbackMatcher[] {
  const hook: HookCallback = async (input): Promise<HookJSONOutput> => {
    const post = input as PostToolUseHookInput
    ctx.onToolComplete?.(post.tool_name, post.tool_input, post.tool_response)
    return { async: true }
  }

  return [{ matcher: "Write|Edit|Bash", hooks: [hook] }]
}

/** Notification: forward agent notifications via callback. */
export function createNotificationHooks(ctx: HookContext): HookCallbackMatcher[] {
  const hook: HookCallback = async (input): Promise<HookJSONOutput> => {
    const notif = input as NotificationHookInput
    ctx.onNotification?.(notif.message, notif.title)
    return { async: true }
  }

  return [{ hooks: [hook] }]
}

/**
 * Assemble all hooks into a single SDK-ready config.
 * Security + logging always included. Progress + notification when ctx provided.
 */
export function buildHooks(ctx?: HookContext): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const security = createSecurityHooks()
  const logging = createLoggingHooks()

  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
    PreToolUse: [...security, ...logging.pre],
    PostToolUse: [...logging.post],
    PostToolUseFailure: [...logging.failure],
  }

  if (ctx) {
    if (ctx.onToolComplete) {
      hooks.PostToolUse = [...createProgressHooks(ctx), ...hooks.PostToolUse!]
    }
    if (ctx.onNotification) {
      hooks.Notification = createNotificationHooks(ctx)
    }
  }

  return hooks
}
