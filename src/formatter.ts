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
// Markdown → Telegram HTML (pre-compiled regex for performance)
// ---------------------------------------------------------------------------

const RE_FENCED_CODE = /```(\w*)\n?([\s\S]*?)```/g
const RE_INLINE_CODE = /`([^`\n]+)`/g
const RE_HEADING = /^#{1,6}\s+(.+)$/gm
const RE_HR = /^[-*_]{3,}\s*$/gm
const RE_BOLD_STAR = /\*\*(.+?)\*\*/g
const RE_BOLD_UNDER = /__(.+?)__/g
const RE_ITALIC_STAR = /(?<!\w)\*([^*\n]+?)\*(?!\w)/g
const RE_ITALIC_UNDER = /(?<!\w)_([^_\n]+?)_(?!\w)/g
const RE_STRIKE = /~~(.+?)~~/g
const RE_LINK = /\[([^\]]+)\]\(([^)]+)\)/g
const RE_BLOCKQUOTE = /^&gt;\s?(.+)$/gm
const RE_BLOCKQUOTE_MERGE = /<\/blockquote>\n<blockquote>/g
const RE_RESTORE_CB = /\uE000CB(\d+)\uE000/g
const RE_RESTORE_IC = /\uE001IC(\d+)\uE001/g
const RE_SPLIT_PRE = /<pre>[\s\S]*?<\/pre>/g

export function markdownToTelegramHtml(md: string): string {
  // --- Protect fenced code blocks ---
  const codeBlocks: string[] = []
  let result = md.replace(RE_FENCED_CODE, (_match, lang: string, code: string) => {
    const idx = codeBlocks.length
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : ""
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.trimEnd())}</code></pre>`)
    return `\uE000CB${idx}\uE000`
  })

  // --- Protect inline code ---
  const inlineCodes: string[] = []
  result = result.replace(RE_INLINE_CODE, (_match, code: string) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\uE001IC${idx}\uE001`
  })

  // --- Escape HTML in the rest ---
  result = escapeHtml(result)

  // --- Convert Markdown syntax ---
  result = result.replace(RE_HEADING, "<b>$1</b>")
  result = result.replace(RE_HR, "———")
  result = result.replace(RE_BOLD_STAR, "<b>$1</b>")
  result = result.replace(RE_BOLD_UNDER, "<b>$1</b>")
  result = result.replace(RE_ITALIC_STAR, "<i>$1</i>")
  result = result.replace(RE_ITALIC_UNDER, "<i>$1</i>")
  result = result.replace(RE_STRIKE, "<s>$1</s>")
  result = result.replace(RE_LINK, '<a href="$2">$1</a>')
  result = result.replace(RE_BLOCKQUOTE, "<blockquote>$1</blockquote>")
  result = result.replace(RE_BLOCKQUOTE_MERGE, "\n")

  // --- Restore protected code ---
  result = result.replace(RE_RESTORE_CB, (_m, idx) => codeBlocks[Number(idx)])
  result = result.replace(RE_RESTORE_IC, (_m, idx) => inlineCodes[Number(idx)])

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
  RE_SPLIT_PRE.lastIndex = 0
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = RE_SPLIT_PRE.exec(html)) !== null) {
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
  meta?: string,
  header?: string
): { chunks: string[]; parseMode: "HTML" | undefined } {
  try {
    let html = ""

    // Identity header at the top, bold
    if (header) {
      html += `<b>${escapeHtml(header)}</b>\n\n`
    }

    html += markdownToTelegramHtml(markdown)

    // Meta footer (timing, tokens) at the bottom, italic
    if (meta) {
      html += `\n\n<i>${escapeHtml(meta)}</i>`
    }

    const chunks = chunkHtml(html)
    return { chunks, parseMode: "HTML" }
  } catch {
    // Fallback: plain text, no formatting
    let plain = ""
    if (header) plain += `${header}\n\n`
    plain += markdown
    if (meta) plain += `\n\n${meta}`
    const chunks = chunkHtml(plain)
    return { chunks, parseMode: undefined }
  }
}
