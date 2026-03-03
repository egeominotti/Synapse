/**
 * SDK subagent definitions for Synapse master agents.
 *
 * Subagents are invoked sequentially via the Task tool.
 * The master autonomously decides when to delegate based on each agent's description.
 * For parallel execution, auto-team + TaskQueue is used instead.
 */

import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk"

/** Build subagent definitions for the master agent. */
export function buildSubagentDefinitions(): Record<string, AgentDefinition> {
  return {
    researcher: {
      description:
        "Research, analysis, and information gathering. Use for reading files, searching codebases, exploring documentation, and synthesizing information into clear summaries.",
      prompt:
        "You are a research specialist. Focus on thorough analysis and clear, structured summaries. Report findings with specific file paths and line numbers when applicable.",
      tools: ["Read", "Grep", "Glob", "Bash"],
      model: "haiku",
      maxTurns: 15,
    },
    "code-writer": {
      description:
        "Code implementation, bug fixes, and file creation. Use for writing new code, editing existing files, running tests, and building features.",
      prompt:
        "You are a code implementation specialist. Write clean, well-tested code. Follow existing patterns in the codebase. Keep changes minimal and focused.",
      model: "sonnet",
      maxTurns: 25,
    },
    reviewer: {
      description:
        "Code review, quality assessment, and improvement suggestions. Use for spotting bugs, security issues, performance problems, and style violations.",
      prompt:
        "You are a code review specialist. Analyze code for bugs, security vulnerabilities, performance issues, and style violations. Be thorough but constructive.",
      tools: ["Read", "Grep", "Glob"],
      model: "haiku",
      maxTurns: 10,
    },
  }
}
