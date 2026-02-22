/**
 * Speech-to-text via Groq API (primary) + whisper-cli local (fallback).
 *
 * Priority: Groq cloud → local whisper-cli + ffmpeg
 *
 * Groq: sends OGG directly (no ffmpeg needed), <1 sec response, free 8h/day.
 * Local: OGG Opus → ffmpeg → WAV 16kHz mono → whisper-cli → text.
 *
 * Enable cloud: set GROQ_API_KEY
 * Enable local: set WHISPER_MODEL_PATH + install whisper-cpp ffmpeg
 */

import { logger } from "./logger"

const WHISPER_TIMEOUT_MS = 120_000 // 2 minutes max for local transcription
const GROQ_TIMEOUT_MS = 30_000 // 30 seconds for cloud API

export interface WhisperConfig {
  modelPath: string
  language: string
  threads: number
  groqApiKey?: string
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

// ---------------------------------------------------------------------------
// Groq cloud transcription
// ---------------------------------------------------------------------------

/** Transcribe audio via Groq API (whisper-large-v3-turbo). */
async function transcribeGroq(audioPath: string, apiKey: string, language: string): Promise<string> {
  const audioBuffer = await Bun.file(audioPath).arrayBuffer()
  const fileName = audioPath.split("/").pop() ?? "audio.ogg"

  const formData = new FormData()
  formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), fileName)
  formData.append("model", "whisper-large-v3-turbo")
  formData.append("response_format", "json")
  formData.append("temperature", "0")
  if (language !== "auto") {
    formData.append("language", language)
  }

  logger.debug("Groq transcription started", { audioPath, language })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS)

  try {
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Groq API ${res.status}: ${body}`)
    }

    const json = (await res.json()) as { text: string }
    logger.info("Groq transcription complete", { length: json.text.length })
    return json.text
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Local whisper-cli transcription
// ---------------------------------------------------------------------------

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

/** Transcribe audio locally via whisper-cli (boosted). */
async function transcribeLocal(audioPath: string, config: WhisperConfig): Promise<string> {
  const wavPath = await convertToWav(audioPath)

  const args = [
    "whisper-cli",
    "-m",
    config.modelPath,
    "-l",
    config.language,
    "-t",
    String(config.threads),
    "--beam-size",
    "8",
    "--best-of",
    "8",
    "--entropy-thold",
    "2.8",
    "--no-speech-thold",
    "0.3",
    "--flash-attn",
    "--no-prints",
    "--prompt",
    "Transcribe accurately.",
    "-f",
    wavPath,
  ]

  logger.debug("Local whisper transcription started", { audioPath, wavPath, language: config.language })

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

  if (timedOut) throw new Error("whisper-cli: transcription timeout")

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const msg = stderr.trim().split("\n").pop() ?? `whisper-cli exit code ${exitCode}`
    throw new Error(`whisper-cli: ${msg}`)
  }

  const text = parseWhisperOutput(stdout)
  if (!text) throw new Error("whisper-cli: no text transcribed")

  logger.info("Local whisper transcription complete", { length: text.length, language: config.language })
  return text
}

// ---------------------------------------------------------------------------
// Public API: Groq primary → local fallback
// ---------------------------------------------------------------------------

/**
 * Transcribe audio. Uses Groq API if configured, falls back to local whisper-cli.
 */
export async function transcribe(audioPath: string, config: WhisperConfig): Promise<string> {
  if (config.groqApiKey) {
    try {
      return await transcribeGroq(audioPath, config.groqApiKey, config.language)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn("Groq transcription failed, falling back to local", { error: msg })
      return await transcribeLocal(audioPath, config)
    }
  }

  return await transcribeLocal(audioPath, config)
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
