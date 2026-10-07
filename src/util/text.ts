/** End a UTF-16 slice without splitting a Unicode surrogate pair. */
export function safeEnd(text: string, end: number): number {
  end = Math.max(0, Math.min(text.length, end));
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[end]) ? end - 1 : end;
}

export function truncateText(text: string, maxChars: number): string {
  return text.slice(0, safeEnd(text, maxChars));
}
