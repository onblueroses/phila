export function constrain(raw: string): string {
  let text = raw.trim()
  if (!text) return ''

  if ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'")) {
    text = text.slice(1, -1)
  }

  text = text.replace(/^[\s]*(?:[-*•]|\d+\.)\s+/gm, '')
  text = text.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
  text = text.replace(/(?:^|(?<=\.\s)|(?<=!\s)|(?<=\?\s))(great question|i'?d be happy to help|happy to help|glad you asked|absolutely|here'?s what i (?:know|found)|i should (?:note|mention) that|it'?s worth (?:noting|mentioning) that)[!.:,]?\s*/gi, '')

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  if (sentences.length > 2) {
    text = sentences.slice(0, 2).join(' ')
  }

  return text.toLowerCase().replace(/\.+$/, '').replace(/\s+/g, ' ').trim()
}
