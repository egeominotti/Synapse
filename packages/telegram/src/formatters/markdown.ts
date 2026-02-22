/**
 * Escapes text for Telegram MarkdownV2 format.
 * Special characters that need escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function formatMarkdownV2(text: string): string {
  // Preserve code blocks - don't escape inside them
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Find next code block (``` or `)
    const tripleIdx = remaining.indexOf("```");
    const singleIdx = remaining.indexOf("`");

    if (tripleIdx !== -1 && (singleIdx === -1 || tripleIdx <= singleIdx)) {
      // Triple backtick code block
      const endIdx = remaining.indexOf("```", tripleIdx + 3);
      if (endIdx !== -1) {
        parts.push(escapeMarkdownV2(remaining.slice(0, tripleIdx)));
        parts.push(remaining.slice(tripleIdx, endIdx + 3)); // keep code block as-is
        remaining = remaining.slice(endIdx + 3);
        continue;
      }
    } else if (singleIdx !== -1) {
      // Inline code
      const endIdx = remaining.indexOf("`", singleIdx + 1);
      if (endIdx !== -1) {
        parts.push(escapeMarkdownV2(remaining.slice(0, singleIdx)));
        parts.push(remaining.slice(singleIdx, endIdx + 1)); // keep inline code as-is
        remaining = remaining.slice(endIdx + 1);
        continue;
      }
    }

    // No more code blocks, escape the rest
    parts.push(escapeMarkdownV2(remaining));
    remaining = "";
  }

  return parts.join("");
}

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Splits a message into chunks that fit Telegram's 4096 char limit.
 * Tries to split at newlines or spaces.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", maxLength);
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      // Try to split at a space
      splitIdx = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIdx === -1 || splitIdx < maxLength * 0.3) {
      // Hard split
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
