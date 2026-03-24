// Post-processing safety net for personality constraints.
// The system prompt should produce correct voice, but this enforces it.

export function constrain(raw: string): string {
  let text = raw.trim()

  // Strip wrapping quotes
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1)
  }

  // Flatten bullet points and numbered lists into prose
  text = text.replace(/^[\s]*[-*•]\s+/gm, '').replace(/^[\s]*\d+\.\s+/gm, '')

  // Collapse to max 2 sentences
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  if (sentences.length > 2) {
    text = sentences.slice(0, 2).join(' ')
  }

  // Lowercase
  text = text.toLowerCase()

  // Strip trailing periods (texts don't end with periods, but keep ? and !)
  text = text.replace(/\.+$/, '')

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()

  return text
}
