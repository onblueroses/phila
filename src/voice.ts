export function constrain(raw: string): string {
  let text = raw.trim()
  if (!text) return ''

  if ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'")) {
    text = text.slice(1, -1)
  }

  text = text.replace(/^[\s]*[-*•]\s+/gm, '').replace(/^[\s]*\d+\.\s+/gm, '')

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  if (sentences.length > 2) {
    text = sentences.slice(0, 2).join(' ')
  }

  return text.toLowerCase().replace(/\.+$/, '').replace(/\s+/g, ' ').trim()
}
