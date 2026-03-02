import { describe, it, expect, afterEach } from "bun:test"
import { existsSync, writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { MIME_TYPES, buildAgentEnv, generateSandboxRules, createSandbox, listSandboxFiles } from "../src/sandbox"

// ---------------------------------------------------------------------------
// MIME_TYPES
// ---------------------------------------------------------------------------

describe("MIME_TYPES", () => {
  it("maps common image extensions", () => {
    expect(MIME_TYPES[".jpg"]).toBe("image/jpeg")
    expect(MIME_TYPES[".jpeg"]).toBe("image/jpeg")
    expect(MIME_TYPES[".png"]).toBe("image/png")
    expect(MIME_TYPES[".gif"]).toBe("image/gif")
    expect(MIME_TYPES[".webp"]).toBe("image/webp")
  })

  it("returns undefined for unsupported extensions", () => {
    expect(MIME_TYPES[".pdf"]).toBeUndefined()
    expect(MIME_TYPES[".bmp"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildAgentEnv
// ---------------------------------------------------------------------------

describe("buildAgentEnv", () => {
  it("injects CLAUDE_CODE_OAUTH_TOKEN", () => {
    const env = buildAgentEnv("my-token")
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("my-token")
  })

  it("returns only string values (no undefined)", () => {
    const env = buildAgentEnv("tok")
    for (const [, value] of Object.entries(env)) {
      expect(typeof value).toBe("string")
    }
  })

  it("returns cached env for same token", () => {
    const a = buildAgentEnv("same-tok")
    const b = buildAgentEnv("same-tok")
    expect(a).toBe(b) // same reference
  })

  it("returns new env for different token", () => {
    const a = buildAgentEnv("tok-a")
    const b = buildAgentEnv("tok-b")
    expect(a).not.toBe(b)
    expect(a.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-a")
    expect(b.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-b")
  })
})

// ---------------------------------------------------------------------------
// generateSandboxRules
// ---------------------------------------------------------------------------

describe("generateSandboxRules", () => {
  it("returns a non-empty string", () => {
    const rules = generateSandboxRules("/tmp/test-sandbox")
    expect(rules.length).toBeGreaterThan(100)
  })

  it("contains the sandbox directory path", () => {
    const rules = generateSandboxRules("/tmp/my-sandbox-dir")
    expect(rules).toContain("/tmp/my-sandbox-dir")
  })

  it("contains safety headers", () => {
    const rules = generateSandboxRules("/tmp/test")
    expect(rules).toContain("# CLAUDE.md")
    expect(rules).toContain("FORBIDDEN")
    expect(rules).toContain("ALLOWED")
  })

  it("covers Linux, macOS, and Windows paths", () => {
    const rules = generateSandboxRules("/tmp/test")
    expect(rules).toContain("/etc")
    expect(rules).toContain("/System")
    expect(rules).toContain("C:\\Windows")
  })

  it("forbids destructive commands", () => {
    const rules = generateSandboxRules("/tmp/test")
    expect(rules).toContain("rm -rf")
    expect(rules).toContain("shutdown")
    expect(rules).toContain("sudo")
  })
})

// ---------------------------------------------------------------------------
// createSandbox
// ---------------------------------------------------------------------------

const createdDirs: string[] = []
afterEach(() => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true })
    } catch {
      /* already cleaned */
    }
  }
  createdDirs.length = 0
})

describe("createSandbox", () => {
  it("creates a temp directory that exists", () => {
    const dir = createSandbox()
    createdDirs.push(dir)
    expect(existsSync(dir)).toBe(true)
  })

  it("creates CLAUDE.md in the sandbox", () => {
    const dir = createSandbox()
    createdDirs.push(dir)
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true)
  })

  it("creates unique directories", () => {
    const a = createSandbox()
    const b = createSandbox()
    createdDirs.push(a, b)
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// listSandboxFiles
// ---------------------------------------------------------------------------

describe("listSandboxFiles", () => {
  it("returns empty for fresh sandbox", () => {
    const dir = createSandbox()
    createdDirs.push(dir)
    const files = listSandboxFiles(dir)
    expect(files).toEqual([])
  })

  it("excludes CLAUDE.md", () => {
    const dir = createSandbox()
    createdDirs.push(dir)
    const files = listSandboxFiles(dir)
    const names = files.map((f) => f.path)
    expect(names).not.toContain("CLAUDE.md")
  })

  it("lists user-created files", () => {
    const dir = createSandbox()
    createdDirs.push(dir)
    writeFileSync(join(dir, "output.txt"), "hello")
    writeFileSync(join(dir, "data.json"), '{"key":"val"}')

    const files = listSandboxFiles(dir)
    const names = files.map((f) => f.path).sort()
    expect(names).toEqual(["data.json", "output.txt"])
  })

  it("lists files in subdirectories", () => {
    const dir = createSandbox()
    createdDirs.push(dir)
    mkdirSync(join(dir, "subdir"))
    writeFileSync(join(dir, "subdir", "nested.txt"), "deep")

    const files = listSandboxFiles(dir)
    expect(files.length).toBe(1)
    expect(files[0].path).toBe(join("subdir", "nested.txt"))
  })

  it("includes mtimeMs for each file", () => {
    const dir = createSandbox()
    createdDirs.push(dir)
    writeFileSync(join(dir, "file.txt"), "content")

    const files = listSandboxFiles(dir)
    expect(files[0].mtimeMs).toBeGreaterThan(0)
  })

  it("returns empty for non-existent directory", () => {
    const files = listSandboxFiles("/tmp/does-not-exist-sandbox-xyz")
    expect(files).toEqual([])
  })
})
