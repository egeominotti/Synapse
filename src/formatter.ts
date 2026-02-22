/**
 * Converts Claude's Markdown output to Telegram-safe HTML.
 *
 * Telegram supports a limited HTML subset:
 *   <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>, <tg-spoiler>
 *
 * Strategy:
 *   1. Extract code blocks and inline code (protect from escaping)
 *   2. Escape HTML entities in remaining text
 *   3. Convert Markdown syntax → Telegram HTML tags
 *   4. Re-insert protected code
 *   5. Smart-chunk to 4096-char Telegram limit
 */

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// ---------------------------------------------------------------------------
// Markdown → Telegram HTML
// ---------------------------------------------------------------------------

export function markdownToTelegramHtml(md: string): string {
  // --- Protect fenced code blocks ---
  const codeBlocks: string[] = []
  let result = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const idx = codeBlocks.length
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : ""
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.trimEnd())}</code></pre>`)
    return `\uE000CB${idx}\uE000`
  })

  // --- Protect inline code ---
  const inlineCodes: string[] = []
  result = result.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\uE001IC${idx}\uE001`
  })

  // --- Escape HTML in the rest ---
  result = escapeHtml(result)

  // --- Headings → bold (Telegram has no heading tags) ---
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")

  // --- Horizontal rules → thin line ---
  result = result.replace(/^[-*_]{3,}\s*$/gm, "———")

  // --- Bold: **text** or __text__ ---
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  result = result.replace(/__(.+?)__/g, "<b>$1</b>")

  // --- Italic: *text* or _text_ (word-boundary aware) ---
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>")
  result = result.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "<i>$1</i>")

  // --- Strikethrough: ~~text~~ ---
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>")

  // --- Links: [text](url) ---
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // --- Blockquotes: > text ---
  result = result.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>")
  // Merge consecutive blockquotes into one
  result = result.replace(/<\/blockquote>\n<blockquote>/g, "\n")

  // --- Restore protected code ---
  result = result.replace(/\uE000CB(\d+)\uE000/g, (_m, idx) => codeBlocks[Number(idx)])
  result = result.replace(/\uE001IC(\d+)\uE001/g, (_m, idx) => inlineCodes[Number(idx)])

  return result.trim()
}

// ---------------------------------------------------------------------------
// Smart chunking for Telegram (max 4096 chars per message)
// ---------------------------------------------------------------------------

const TELEGRAM_MAX = 4096

/**
 * Splits HTML into Telegram-safe chunks.
 * Priority: split on \n\n (paragraph), then \n (line), then hard char cut.
 * Never splits inside <pre> blocks when possible.
 */
export function chunkHtml(html: string, maxLen = TELEGRAM_MAX): string[] {
  if (html.length <= maxLen) return [html]

  const chunks: string[] = []

  // Split into segments: alternate between <pre>...</pre> blocks and regular text
  const segments = splitPreBlocks(html)
  let current = ""

  for (const seg of segments) {
    // If this segment fits, append it
    if (current.length + seg.length <= maxLen) {
      current += seg
      continue
    }

    // If it's a <pre> block that doesn't fit alone, we still keep it whole
    // (Telegram will display it, just truncated on their side)
    if (seg.startsWith("<pre>") && !current) {
      chunks.push(seg.slice(0, maxLen))
      if (seg.length > maxLen) {
        // Remainder of oversized pre block
        for (let i = maxLen; i < seg.length; i += maxLen) {
          chunks.push(seg.slice(i, i + maxLen))
        }
      }
      continue
    }

    // Flush current buffer
    if (current) {
      chunks.push(current.trim())
      current = ""
    }

    // If segment itself is under limit, start new buffer
    if (seg.length <= maxLen) {
      current = seg
      continue
    }

    // Segment is too long — split on paragraphs, then lines
    const subChunks = splitLongText(seg, maxLen)
    for (const sc of subChunks) {
      chunks.push(sc)
    }
  }

  if (current.trim()) chunks.push(current.trim())
  return chunks
}

/** Split HTML into segments preserving <pre>...</pre> blocks as atomic units */
function splitPreBlocks(html: string): string[] {
  const segments: string[] = []
  const regex = /<pre>[\s\S]*?<\/pre>/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      segments.push(html.slice(lastIndex, match.index))
    }
    segments.push(match[0])
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < html.length) {
    segments.push(html.slice(lastIndex))
  }

  return segments
}

/** Split long text on paragraph boundaries, then lines, then hard cut */
function splitLongText(text: string, maxLen: number): string[] {
  const chunks: string[] = []
  const paragraphs = text.split(/\n\n+/)
  let current = ""

  for (const para of paragraphs) {
    if (current && current.length + 2 + para.length > maxLen) {
      chunks.push(current.trim())
      current = ""
    }

    if (para.length > maxLen) {
      if (current) {
        chunks.push(current.trim())
        current = ""
      }
      // Split on lines
      const lines = para.split("\n")
      for (const line of lines) {
        if (current && current.length + 1 + line.length > maxLen) {
          chunks.push(current.trim())
          current = ""
        }
        if (line.length > maxLen) {
          if (current) {
            chunks.push(current.trim())
            current = ""
          }
          for (let i = 0; i < line.length; i += maxLen) {
            chunks.push(line.slice(i, i + maxLen))
          }
        } else {
          current += (current ? "\n" : "") + line
        }
      }
    } else {
      current += (current ? "\n\n" : "") + para
    }
  }

  if (current.trim()) chunks.push(current.trim())
  return chunks
}

// ---------------------------------------------------------------------------
// Public helper: format + chunk in one call, with fallback
// ---------------------------------------------------------------------------

/**
 * Convert Markdown to Telegram HTML and split into chunks.
 * Returns { chunks, parseMode }. If conversion looks broken, falls back
 * to plain text (no parse_mode).
 */
export function formatForTelegram(
  markdown: string,
  meta?: string
): { chunks: string[]; parseMode: "HTML" | undefined } {
  try {
    let html = markdownToTelegramHtml(markdown)

    // Append meta footer to the HTML
    if (meta) {
      html += `\n\n<i>${escapeHtml(meta)}</i>`
    }

    const chunks = chunkHtml(html)
    return { chunks, parseMode: "HTML" }
  } catch {
    // Fallback: plain text, no formatting
    let plain = markdown
    if (meta) plain += `\n\n${meta}`
    const chunks = chunkHtml(plain)
    return { chunks, parseMode: undefined }
  }
}
