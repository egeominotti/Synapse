/**
 * Animated terminal spinner.
 * Runs on a timer, cleans up its line on stop.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const FRAME_INTERVAL_MS = 80

export class Spinner {
  private frameIndex = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private message: string

  constructor(message = "Claude sta pensando...") {
    this.message = message
  }

  start(): void {
    if (this.timer) return
    this.frameIndex = 0

    // Hide cursor
    process.stdout.write("\x1b[?25l")

    this.timer = setInterval(() => {
      const frame = FRAMES[this.frameIndex % FRAMES.length]
      process.stdout.write(`\r\x1b[90m${frame} ${this.message}\x1b[0m`)
      this.frameIndex++
    }, FRAME_INTERVAL_MS)
  }

  /** Update the spinner message while running */
  setMessage(message: string): void {
    this.message = message
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null

    // Clear spinner line and show cursor
    process.stdout.write("\r\x1b[K\x1b[?25h")
  }
}
