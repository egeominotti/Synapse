/**
 * Sandbox management for Claude agents.
 * Creates isolated temp directories with safety rules (CLAUDE.md)
 * that prevent Claude from modifying system files.
 */

import { mkdtempSync, readdirSync, statSync, writeFileSync } from "fs"
import { join, relative } from "path"
import { tmpdir } from "os"
import { logger } from "./logger"

/** Supported image MIME types for vision */
export const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

/** Build spawn env: inherit Bun.env, strip CLAUDECODE, inject token.
 *  Cached per token — avoids rebuilding the env object on every spawn call. */
let _cachedEnv: Record<string, string> | null = null
let _cachedToken: string | null = null

export function buildSpawnEnv(token: string): Record<string, string> {
  if (_cachedEnv && _cachedToken === token) return _cachedEnv
  const { CLAUDECODE: _stripped, ...rest } = Bun.env
  _cachedEnv = Object.fromEntries(
    Object.entries({ ...rest, CLAUDE_CODE_OAUTH_TOKEN: token }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
  _cachedToken = token
  return _cachedEnv
}

/** Generate the CLAUDE.md safety rules text for a sandbox directory */
export function generateSandboxRules(sandboxDir: string): string {
  return [
    "# CLAUDE.md",
    "",
    "## Safety Rules — MANDATORY",
    "",
    "You are running in an isolated sandbox. These rules are NON-NEGOTIABLE.",
    "Violations can cause irreversible damage to the host system.",
    "",
    "## 1. FILESYSTEM — FORBIDDEN PATHS",
    "",
    "**NEVER read, write, delete, or modify files outside this sandbox.**",
    "",
    "**Linux protected paths:**",
    "- `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/boot`, `/opt`, `/var`, `/root`, `/proc`, `/sys`, `/dev`",
    "",
    "**macOS protected paths:**",
    "- `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/sbin`, `/etc`, `/var`, `/private`, `/cores`",
    "",
    "**Windows protected paths:**",
    "- `C:\\Windows`, `C:\\Program Files`, `C:\\Program Files (x86)`, `C:\\ProgramData`",
    "- `C:\\Users\\<user>\\AppData`, `C:\\Recovery`, `C:\\$Recycle.Bin`",
    "",
    "**User home protected paths (all platforms):**",
    "- `~`, `$HOME`, `%USERPROFILE%` — never delete or recursively modify",
    "- `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.config`, `~/.local`",
    "- `~/.bashrc`, `~/.zshrc`, `~/.profile`, `~/.bash_profile`",
    "- Any `.env`, `.env.*`, `credentials`, `secrets`, `token` files",
    "",
    "## 2. DESTRUCTIVE COMMANDS — FORBIDDEN",
    "",
    "**Never execute these commands or any variation:**",
    "",
    "File destruction:",
    "- `rm -rf /`, `rm -rf ~`, `rm -rf $HOME`, `rm -rf /*`",
    "- `del /s /q C:\\`, `rd /s /q C:\\`",
    "- Any recursive delete (`rm -rf`, `rd /s`) targeting paths outside this sandbox",
    "",
    "Disk/partition:",
    "- `mkfs`, `fdisk`, `dd` (on block devices), `format`, `diskpart`, `parted`",
    "",
    "System control:",
    "- `shutdown`, `reboot`, `halt`, `poweroff`, `init 0`, `init 6`",
    "- `shutdown /s`, `shutdown /r` (Windows)",
    "",
    "Process killing:",
    "- `kill -9 1`, `killall` (system processes), `pkill` (system processes)",
    "- `taskkill /f` on: svchost, csrss, winlogon, lsass, wininit, smss",
    "",
    "Privilege escalation:",
    "- `sudo`, `su`, `doas`, `runas`, `pkexec`",
    "- `chmod 777`, `chmod +s`, `chown root` on any system files",
    "",
    "Registry/config:",
    "- `reg delete`, `regedit` (Windows registry)",
    "- `defaults write` on system domains (macOS)",
    "",
    "Service management:",
    "- `systemctl stop/disable`, `launchctl unload`, `sc stop` on system services",
    "- `crontab -r` (delete all cron jobs)",
    "",
    "Network/firewall:",
    "- `iptables -F`, `ufw disable`, `pfctl -d` (flush/disable firewalls)",
    "- `route del`, `ip route flush` (delete network routes)",
    "",
    "Container/VM (if accessible):",
    "- `docker rm -f`, `docker system prune -af`, `docker rmi -f`",
    "- `docker run --privileged`, `docker run -v /:/host`",
    "",
    "Remote code execution:",
    "- `curl | sh`, `curl | bash`, `wget -O- | sh` (piped execution)",
    "- `eval` on untrusted remote content",
    "",
    "Package managers (global installs):",
    "- `npm install -g`, `pip install` (system-wide), `gem install` (system)",
    "- `apt remove`, `brew uninstall`, `pacman -R` (system packages)",
    "",
    "Symlink attacks:",
    "- Do NOT create symlinks pointing outside this sandbox directory",
    "",
    "## 3. ALLOWED OPERATIONS",
    "",
    `- Create, read, write, delete files ONLY within this sandbox: \`${sandboxDir}\``,
    "- Run read-only commands: `ls`, `cat`, `head`, `tail`, `wc`, `df`, `uname`, `whoami`, `date`, `dir`",
    "- Network read operations: `curl`, `wget`, `fetch` (GET requests for data retrieval)",
    "- Language REPLs within sandbox: `python`, `node`, `bun` (operating on sandbox files only)",
    "",
    "## 4. WHEN IN DOUBT",
    "",
    "If a user asks you to perform a potentially dangerous operation:",
    "1. REFUSE the operation",
    "2. Explain what was requested and why it is dangerous",
    "3. Suggest a safe alternative if possible",
    "",
    "**Remember: you can always create and work on files in this sandbox freely.**",
    "**You MUST NEVER operate on files outside it.**",
  ].join("\n")
}

/** Create an isolated sandbox directory with safety rules. Returns the path. */
export function createSandbox(): string {
  const sandboxDir = mkdtempSync(join(tmpdir(), "neo-agent-"))
  writeFileSync(join(sandboxDir, "CLAUDE.md"), generateSandboxRules(sandboxDir))
  return sandboxDir
}

/**
 * List all user-created files in the sandbox (excludes CLAUDE.md).
 * Returns relative paths with their modification times.
 */
export function listSandboxFiles(sandboxDir: string): Array<{ path: string; mtimeMs: number }> {
  const results: Array<{ path: string; mtimeMs: number }> = []
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir) as string[]
    } catch (err) {
      logger.debug("Failed to read sandbox directory", { dir, error: String(err) })
      return
    }
    for (const name of names) {
      const fullPath = join(dir, name)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          walk(fullPath)
        } else if (stat.isFile()) {
          const rel = relative(sandboxDir, fullPath)
          if (rel === "CLAUDE.md") continue
          results.push({ path: rel, mtimeMs: stat.mtimeMs })
        }
      } catch {
        /* file may have been deleted between readdir and stat */
      }
    }
  }
  walk(sandboxDir)
  return results
}
