/**
 * Optional local speech-to-text via whisper.cpp.
 *
 * Requires external binaries (not bundled):
 *   brew install whisper-cpp ffmpeg
 *
 * Enable by setting WHISPER_MODEL_PATH to a ggml model file.
 * If not configured, voice messages are gracefully ignored.
 */

import { unlinkSync } from "fs"
import { logger } from "./logger"

const WHISPER_TIMEOUT_MS = 120_000 // 2 minutes max for transcription
const FFMPEG_TIMEOUT_MS = 30_000 // 30 seconds for audio conversion

export interface WhisperConfig {
  modelPath: string
  language: string
  threads: number
}

/** Check if whisper-cpp and ffmpeg binaries are available in PATH. */
export async function checkBinaryAvailable(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", name], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

/** Validate that whisper-cpp and ffmpeg are both available. */
export async function validateWhisperDeps(): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = []
  if (!(await checkBinaryAvailable("whisper-cpp"))) missing.push("whisper-cpp")
  if (!(await checkBinaryAvailable("ffmpeg"))) missing.push("ffmpeg")
  return { ok: missing.length === 0, missing }
}

/**
 * Convert audio file to WAV 16kHz mono (required by whisper.cpp).
 * Supports OGG Opus (Telegram voice), MP3, M4A, etc.
 */
export async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-i", inputPath, "-ar", "16000", "-ac", "1", "-y", outputPath], {
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, FFMPEG_TIMEOUT_MS)

  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
  clearTimeout(timeout)

  if (timedOut) throw new Error("ffmpeg: timeout durante conversione audio")

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const msg = stderr.trim().split("\n").pop() ?? `ffmpeg exit code ${exitCode}`
    throw new Error(`ffmpeg: ${msg}`)
  }
}

/**
 * Transcribe a WAV file using whisper-cpp.
 * Returns the transcribed text.
 */
export async function transcribe(audioPath: string, config: WhisperConfig): Promise<string> {
  // Step 1: convert to WAV 16kHz (whisper.cpp requirement)
  const wavPath = audioPath.replace(/\.[^.]+$/, ".wav")
  await convertToWav(audioPath, wavPath)

  // Step 2: run whisper-cpp
  const args = [
    "whisper-cpp",
    "-m",
    config.modelPath,
    "-l",
    config.language,
    "-t",
    String(config.threads),
    "--no-prints", // suppress progress output
    "-f",
    wavPath,
  ]

  logger.debug("Whisper transcription started", { audioPath, language: config.language })

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, WHISPER_TIMEOUT_MS)

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ])
  clearTimeout(timeout)

  // Cleanup temp WAV
  try {
    unlinkSync(wavPath)
  } catch {
    /* ignore */
  }

  if (timedOut) throw new Error("whisper-cpp: timeout durante trascrizione")

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const msg = stderr.trim().split("\n").pop() ?? `whisper-cpp exit code ${exitCode}`
    throw new Error(`whisper-cpp: ${msg}`)
  }

  // whisper-cpp stdout contains timestamped lines like:
  //   [00:00:00.000 --> 00:00:03.000]   Hello world
  // Extract just the text, stripping timestamps
  const text = parseWhisperOutput(stdout)
  if (!text) throw new Error("whisper-cpp: nessun testo trascritto")

  logger.info("Whisper transcription complete", { length: text.length, language: config.language })
  return text
}

/** Parse whisper-cpp stdout, stripping timestamp markers. */
export function parseWhisperOutput(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => line.replace(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim()
}
