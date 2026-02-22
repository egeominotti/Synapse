import { describe, it, expect } from "bun:test"
import { parseWhisperOutput } from "../src/whisper"

describe("parseWhisperOutput", () => {
  it("strips timestamps and joins lines", () => {
    const raw = `[00:00:00.000 --> 00:00:03.000]   Ciao, come stai?
[00:00:03.000 --> 00:00:06.000]   Tutto bene grazie.`
    expect(parseWhisperOutput(raw)).toBe("Ciao, come stai? Tutto bene grazie.")
  })

  it("handles single line", () => {
    const raw = "[00:00:00.000 --> 00:00:02.000]   Hello world"
    expect(parseWhisperOutput(raw)).toBe("Hello world")
  })

  it("handles output without timestamps", () => {
    const raw = "Plain text output\nSecond line"
    expect(parseWhisperOutput(raw)).toBe("Plain text output Second line")
  })

  it("returns empty string for empty input", () => {
    expect(parseWhisperOutput("")).toBe("")
  })

  it("strips extra whitespace", () => {
    const raw = `[00:00:00.000 --> 00:00:01.000]    Spaced   text
[00:00:01.000 --> 00:00:02.000]   More text`
    expect(parseWhisperOutput(raw)).toBe("Spaced   text More text")
  })

  it("handles varied timestamp formats", () => {
    const raw = "[00:00:00.000 -->  00:00:05.120]  Testo con spazi"
    expect(parseWhisperOutput(raw)).toBe("Testo con spazi")
  })

  it("skips blank lines", () => {
    const raw = `[00:00:00.000 --> 00:00:01.000]   Prima

[00:00:02.000 --> 00:00:03.000]   Dopo`
    expect(parseWhisperOutput(raw)).toBe("Prima Dopo")
  })
})
