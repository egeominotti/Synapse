import { describe, it, expect } from "bun:test"
import {
  createSecurityHooks,
  createLoggingHooks,
  createProgressHooks,
  createNotificationHooks,
  buildHooks,
  type HookContext,
} from "../src/hooks"
import type { PreToolUseHookInput, PostToolUseHookInput, NotificationHookInput } from "@anthropic-ai/claude-agent-sdk"

const BASE_INPUT = {
  session_id: "test-session",
  transcript_path: "/tmp/test",
  cwd: "/tmp/sandbox",
}

function makePreToolInput(toolName: string, toolInput: unknown): PreToolUseHookInput {
  return {
    ...BASE_INPUT,
    hook_event_name: "PreToolUse" as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tool-123",
  }
}

function makePostToolInput(toolName: string, toolInput: unknown, toolResponse?: unknown): PostToolUseHookInput {
  return {
    ...BASE_INPUT,
    hook_event_name: "PostToolUse" as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse ?? "ok",
    tool_use_id: "tool-123",
  }
}

function makeNotificationInput(message: string, title?: string): NotificationHookInput {
  return {
    ...BASE_INPUT,
    hook_event_name: "Notification" as const,
    message,
    title,
    notification_type: "general",
  }
}

// ---------------------------------------------------------------------------
// Security hooks
// ---------------------------------------------------------------------------

describe("createSecurityHooks", () => {
  const matchers = createSecurityHooks()
  const hook = matchers[0].hooks[0]

  it("blocks writes to .env files", async () => {
    const result = await hook(makePreToolInput("Write", { file_path: "/tmp/.env" }), "t1", {
      signal: new AbortController().signal,
    })
    const output = result as { hookSpecificOutput?: { permissionDecision?: string } }
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  it("blocks writes to .env.local", async () => {
    const result = await hook(makePreToolInput("Edit", { file_path: "/tmp/.env.local" }), "t1", {
      signal: new AbortController().signal,
    })
    const output = result as { hookSpecificOutput?: { permissionDecision?: string } }
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  it("blocks writes to credentials files", async () => {
    const result = await hook(makePreToolInput("Write", { file_path: "/tmp/credentials.json" }), "t1", {
      signal: new AbortController().signal,
    })
    const output = result as { hookSpecificOutput?: { permissionDecision?: string } }
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  it("blocks writes to .pem files", async () => {
    const result = await hook(makePreToolInput("Write", { file_path: "/tmp/server.pem" }), "t1", {
      signal: new AbortController().signal,
    })
    const output = result as { hookSpecificOutput?: { permissionDecision?: string } }
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  it("blocks bash commands touching .ssh/", async () => {
    const result = await hook(makePreToolInput("Bash", { command: "cat ~/.ssh/id_rsa" }), "t1", {
      signal: new AbortController().signal,
    })
    const output = result as { hookSpecificOutput?: { permissionDecision?: string } }
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  it("allows writes to normal files", async () => {
    const result = await hook(makePreToolInput("Write", { file_path: "/tmp/sandbox/main.ts" }), "t1", {
      signal: new AbortController().signal,
    })
    expect(result).toEqual({})
  })

  it("allows reads (no file path extraction for Read tool)", async () => {
    const result = await hook(makePreToolInput("Read", { file_path: "/tmp/.env" }), "t1", {
      signal: new AbortController().signal,
    })
    // Read is not matched by the "Write|Edit|Bash" matcher, but we test the hook directly
    // with a Read tool — extractFilePath returns null for Read
    expect(result).toEqual({})
  })

  it("has matcher for Write|Edit|Bash", () => {
    expect(matchers[0].matcher).toBe("Write|Edit|Bash")
  })
})

// ---------------------------------------------------------------------------
// Logging hooks
// ---------------------------------------------------------------------------

describe("createLoggingHooks", () => {
  const logging = createLoggingHooks()

  it("returns pre, post, and failure matchers", () => {
    expect(logging.pre).toHaveLength(1)
    expect(logging.post).toHaveLength(1)
    expect(logging.failure).toHaveLength(1)
  })

  it("pre hook returns empty (passthrough)", async () => {
    const hook = logging.pre[0].hooks[0]
    const result = await hook(makePreToolInput("Bash", { command: "ls" }), "t1", {
      signal: new AbortController().signal,
    })
    expect(result).toEqual({})
  })

  it("post hook returns empty (passthrough)", async () => {
    const hook = logging.post[0].hooks[0]
    const result = await hook(makePostToolInput("Write", { file_path: "/tmp/foo" }), "t1", {
      signal: new AbortController().signal,
    })
    expect(result).toEqual({})
  })

  it("pre hook has no matcher (fires for all tools)", () => {
    expect(logging.pre[0].matcher).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Progress hooks
// ---------------------------------------------------------------------------

describe("createProgressHooks", () => {
  it("fires onToolComplete callback", async () => {
    let captured: { name: string; input: unknown } | null = null
    const ctx: HookContext = {
      onToolComplete: (name, input) => {
        captured = { name, input }
      },
    }
    const matchers = createProgressHooks(ctx)
    const hook = matchers[0].hooks[0]

    await hook(makePostToolInput("Write", { file_path: "/tmp/foo.ts" }, "written"), "t1", {
      signal: new AbortController().signal,
    })

    expect(captured).not.toBeNull()
    expect(captured!.name).toBe("Write")
  })

  it("returns async: true (fire-and-forget)", async () => {
    const ctx: HookContext = { onToolComplete: () => {} }
    const matchers = createProgressHooks(ctx)
    const hook = matchers[0].hooks[0]

    const result = await hook(makePostToolInput("Edit", {}), "t1", {
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ async: true })
  })

  it("has matcher for Write|Edit|Bash", () => {
    const ctx: HookContext = { onToolComplete: () => {} }
    const matchers = createProgressHooks(ctx)
    expect(matchers[0].matcher).toBe("Write|Edit|Bash")
  })
})

// ---------------------------------------------------------------------------
// Notification hooks
// ---------------------------------------------------------------------------

describe("createNotificationHooks", () => {
  it("fires onNotification callback", async () => {
    let captured: { message: string; title?: string } | null = null
    const ctx: HookContext = {
      onNotification: (message, title) => {
        captured = { message, title }
      },
    }
    const matchers = createNotificationHooks(ctx)
    const hook = matchers[0].hooks[0]

    await hook(makeNotificationInput("Hello", "Test Title"), "t1", {
      signal: new AbortController().signal,
    })

    expect(captured).not.toBeNull()
    expect(captured!.message).toBe("Hello")
    expect(captured!.title).toBe("Test Title")
  })

  it("returns async: true", async () => {
    const ctx: HookContext = { onNotification: () => {} }
    const matchers = createNotificationHooks(ctx)
    const hook = matchers[0].hooks[0]

    const result = await hook(makeNotificationInput("test"), "t1", {
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ async: true })
  })
})

// ---------------------------------------------------------------------------
// buildHooks assembler
// ---------------------------------------------------------------------------

describe("buildHooks", () => {
  it("returns security + logging hooks without context", () => {
    const hooks = buildHooks()
    expect(hooks.PreToolUse).toBeDefined()
    expect(hooks.PreToolUse!.length).toBeGreaterThanOrEqual(2) // security + logging
    expect(hooks.PostToolUse).toBeDefined()
    expect(hooks.PostToolUseFailure).toBeDefined()
    expect(hooks.Notification).toBeUndefined() // no ctx → no notification hooks
  })

  it("includes progress hooks when ctx has onToolComplete", () => {
    const hooks = buildHooks({ onToolComplete: () => {} })
    // PostToolUse should have progress + logging
    expect(hooks.PostToolUse!.length).toBeGreaterThanOrEqual(2)
  })

  it("includes notification hooks when ctx has onNotification", () => {
    const hooks = buildHooks({ onNotification: () => {} })
    expect(hooks.Notification).toBeDefined()
    expect(hooks.Notification!.length).toBe(1)
  })

  it("includes all hooks when ctx has all callbacks", () => {
    const hooks = buildHooks({
      onToolComplete: () => {},
      onNotification: () => {},
    })
    expect(hooks.PreToolUse).toBeDefined()
    expect(hooks.PostToolUse).toBeDefined()
    expect(hooks.PostToolUseFailure).toBeDefined()
    expect(hooks.Notification).toBeDefined()
  })
})
