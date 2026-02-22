import { describe, it, expect } from "bun:test"
import { markdownToTelegramHtml, chunkHtml, formatForTelegram } from "../src/formatter"

// ---------------------------------------------------------------------------
// markdownToTelegramHtml
// ---------------------------------------------------------------------------

describe("markdownToTelegramHtml", () => {
  it("escapes HTML entities in plain text", () => {
    expect(markdownToTelegramHtml("a < b > c & d")).toBe("a &lt; b &gt; c &amp; d")
  })

  it("converts **bold**", () => {
    expect(markdownToTelegramHtml("this is **bold** text")).toBe("this is <b>bold</b> text")
  })

  it("converts __bold__", () => {
    expect(markdownToTelegramHtml("this is __bold__ text")).toBe("this is <b>bold</b> text")
  })

  it("converts *italic*", () => {
    expect(markdownToTelegramHtml("this is *italic* text")).toBe("this is <i>italic</i> text")
  })

  it("converts _italic_", () => {
    expect(markdownToTelegramHtml("this is _italic_ text")).toBe("this is <i>italic</i> text")
  })

  it("does not convert underscores inside words", () => {
    expect(markdownToTelegramHtml("some_variable_name")).toBe("some_variable_name")
  })

  it("converts ~~strikethrough~~", () => {
    expect(markdownToTelegramHtml("~~deleted~~")).toBe("<s>deleted</s>")
  })

  it("converts inline `code`", () => {
    expect(markdownToTelegramHtml("run `npm install`")).toBe("run <code>npm install</code>")
  })

  it("escapes HTML inside inline code", () => {
    expect(markdownToTelegramHtml("use `<div>`")).toBe("use <code>&lt;div&gt;</code>")
  })

  it("converts fenced code blocks", () => {
    const md = "```js\nconst x = 1\n```"
    expect(markdownToTelegramHtml(md)).toBe('<pre><code class="language-js">const x = 1</code></pre>')
  })

  it("converts code blocks without language", () => {
    const md = "```\nhello\n```"
    expect(markdownToTelegramHtml(md)).toBe("<pre><code>hello</code></pre>")
  })

  it("escapes HTML inside code blocks", () => {
    const md = "```\n<script>alert(1)</script>\n```"
    expect(markdownToTelegramHtml(md)).toBe("<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>")
  })

  it("converts [links](url)", () => {
    expect(markdownToTelegramHtml("[Google](https://google.com)")).toBe('<a href="https://google.com">Google</a>')
  })

  it("converts headings to bold", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>")
    expect(markdownToTelegramHtml("## Subtitle")).toBe("<b>Subtitle</b>")
    expect(markdownToTelegramHtml("### H3")).toBe("<b>H3</b>")
  })

  it("converts blockquotes", () => {
    expect(markdownToTelegramHtml("> quote")).toBe("<blockquote>quote</blockquote>")
  })

  it("merges consecutive blockquotes", () => {
    const md = "> line1\n> line2"
    expect(markdownToTelegramHtml(md)).toBe("<blockquote>line1\nline2</blockquote>")
  })

  it("converts horizontal rules", () => {
    expect(markdownToTelegramHtml("---")).toBe("———")
    expect(markdownToTelegramHtml("***")).toBe("———")
  })

  it("handles mixed formatting", () => {
    const md = "**bold** and *italic* and `code`"
    expect(markdownToTelegramHtml(md)).toBe("<b>bold</b> and <i>italic</i> and <code>code</code>")
  })

  it("does not format inside code blocks", () => {
    const md = "```\n**not bold** *not italic*\n```"
    const html = markdownToTelegramHtml(md)
    expect(html).not.toContain("<b>")
    expect(html).not.toContain("<i>")
    expect(html).toContain("**not bold** *not italic*")
  })

  it("does not format inside inline code", () => {
    const md = "this `**not bold**` stays"
    const html = markdownToTelegramHtml(md)
    expect(html).toContain("<code>**not bold**</code>")
  })
})

// ---------------------------------------------------------------------------
// chunkHtml
// ---------------------------------------------------------------------------

describe("chunkHtml", () => {
  it("returns single chunk for short text", () => {
    expect(chunkHtml("hello")).toEqual(["hello"])
  })

  it("splits on paragraph boundaries", () => {
    const text = "A".repeat(3000) + "\n\n" + "B".repeat(3000)
    const chunks = chunkHtml(text, 4096)
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toBe("A".repeat(3000))
    expect(chunks[1]).toBe("B".repeat(3000))
  })

  it("splits on line boundaries when paragraphs are too long", () => {
    const text = ("A".repeat(100) + "\n").repeat(50)
    const chunks = chunkHtml(text.trim(), 500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500)
    }
  })

  it("hard splits lines exceeding max", () => {
    const text = "X".repeat(10000)
    const chunks = chunkHtml(text, 4096)
    expect(chunks.length).toBe(3)
    expect(chunks[0].length).toBe(4096)
    expect(chunks[1].length).toBe(4096)
    expect(chunks[2].length).toBe(10000 - 4096 * 2)
  })

  it("keeps pre blocks together when possible", () => {
    const pre = `<pre><code>${"x".repeat(200)}</code></pre>`
    const text = "intro\n\n" + pre + "\n\noutro"
    const chunks = chunkHtml(text, 4096)
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain("<pre>")
    expect(chunks[0]).toContain("</pre>")
  })
})

// ---------------------------------------------------------------------------
// formatForTelegram
// ---------------------------------------------------------------------------

describe("formatForTelegram", () => {
  it("returns HTML parse mode by default", () => {
    const { chunks, parseMode } = formatForTelegram("**hello**")
    expect(parseMode).toBe("HTML")
    expect(chunks[0]).toContain("<b>hello</b>")
  })

  it("appends meta as italic footer", () => {
    const { chunks } = formatForTelegram("hello", "⏱ 2.1s")
    expect(chunks[0]).toContain("<i>⏱ 2.1s</i>")
  })

  it("escapes HTML in meta", () => {
    const { chunks } = formatForTelegram("hello", "a < b")
    expect(chunks[0]).toContain("&lt;")
  })

  it("handles plain text without formatting", () => {
    const { chunks, parseMode } = formatForTelegram("just plain text")
    expect(parseMode).toBe("HTML")
    expect(chunks[0]).toBe("just plain text")
  })
})
