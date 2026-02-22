/**
 * Optional local speech-to-text via whisper.cpp (whisper-cli).
 *
 * Requires external binaries (not bundled):
 *   brew install whisper-cpp ffmpeg
 *
 * Enable by setting WHISPER_MODEL_PATH to a ggml model file.
 * If not configured, voice messages are gracefully ignored.
 *
 * Flow: OGG Opus (Telegram) → ffmpeg → WAV 16kHz mono → whisper-cli → text
 */

import { logger } from "./logger"

const WHISPER_TIMEOUT_MS = 120_000 // 2 minutes max for transcription

export interface WhisperConfig {
  modelPath: string
  language: string
  threads: number
}

/** Check if a binary is available in PATH. */
export async function checkBinaryAvailable(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", name], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

/** Validate that whisper-cli and ffmpeg are available. */
export async function validateWhisperDeps(): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = []
  if (!(await checkBinaryAvailable("whisper-cli"))) missing.push("whisper-cli")
  if (!(await checkBinaryAvailable("ffmpeg"))) missing.push("ffmpeg")
  return { ok: missing.length === 0, missing }
}

/** Convert audio to WAV 16kHz mono via ffmpeg (required for OGG Opus). */
async function convertToWav(inputPath: string): Promise<string> {
  const wavPath = inputPath.replace(/\.[^.]+$/, ".wav")
  const args = ["ffmpeg", "-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]

  logger.debug("ffmpeg conversion started", { inputPath, wavPath })

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const msg = stderr.trim().split("\n").pop() ?? `ffmpeg exit code ${exitCode}`
    throw new Error(`ffmpeg: ${msg}`)
  }

  return wavPath
}

/**
 * Transcribe an audio file using whisper-cli (boosted).
 * Converts to WAV first (Telegram sends OGG Opus which whisper-cli can't read directly).
 */
export async function transcribe(audioPath: string, config: WhisperConfig): Promise<string> {
  // Convert to WAV 16kHz mono — whisper-cli requires WAV format
  const wavPath = await convertToWav(audioPath)

  const args = [
    "whisper-cli",
    "-m",
    config.modelPath,
    "-l",
    config.language,
    "-t",
    String(config.threads),
    // -- Boost: accuracy --
    "--beam-size",
    "8", // default 5 → wider search
    "--best-of",
    "8", // default 5 → more candidates
    "--entropy-thold",
    "2.8", // default 2.4 → more tolerant on uncertain segments
    "--no-speech-thold",
    "0.3", // default 0.6 → less aggressive silence trimming
    "--flash-attn", // GPU-accelerated attention (Metal on macOS)
    // -- Boost: output --
    "--no-prints",
    "--prompt",
    "Trascrivi accuratamente.",
    "-f",
    wavPath,
  ]

  logger.debug("Whisper transcription started", { audioPath, wavPath, language: config.language })

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

  if (timedOut) throw new Error("whisper-cli: timeout durante trascrizione")

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const msg = stderr.trim().split("\n").pop() ?? `whisper-cli exit code ${exitCode}`
    throw new Error(`whisper-cli: ${msg}`)
  }

  // whisper-cli stdout contains timestamped lines like:
  //   [00:00:00.000 --> 00:00:03.000]   Hello world
  // Extract just the text, stripping timestamps
  const text = parseWhisperOutput(stdout)
  if (!text) throw new Error("whisper-cli: nessun testo trascritto")

  logger.info("Whisper transcription complete", { length: text.length, language: config.language })
  return text
}

/** Parse whisper-cli stdout, stripping timestamp markers. */
export function parseWhisperOutput(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => line.replace(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim()
}
