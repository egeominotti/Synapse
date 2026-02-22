/** Shared utilities */

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}
