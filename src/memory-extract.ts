// Background fact extraction from group chat messages.
// Runs after the gate decision (fire-and-forget, never blocks responses).
// Extracts structured facts (logistics, commitments, preferences, personal)
// into SQLite for memory-grounded recall in Pass 2 of the dual gate.

import { chat } from './ollama.ts'
import { buildConversation } from './gate.ts'
import type { ChatMessage, ExtractedFact, FactType, PhilaConfig } from './types.ts'

const VALID_TYPES = new Set<FactType>(['logistics', 'commitment', 'preference', 'personal'])

const EXTRACT_SYSTEM = `extract factual information from this group chat snippet.
return a JSON array of objects. each object has:
- "type": one of "logistics", "commitment", "preference", "personal"
- "key": short label (e.g. "meeting_location", "allergy", "dinner_time", "whos_driving")
- "value": the fact itself (e.g. "thai place on main at 7pm", "person1 is allergic to shellfish")

only extract concrete facts. ignore opinions, jokes, emotions, greetings, banter.
if no facts, return [].
respond with ONLY the JSON array, no other text.`

interface RawFact {
  type?: string
  key?: string
  value?: string
}

export function parseExtraction(raw: string): Array<{ type: FactType; key: string; value: string }> {
  let cleaned = raw.replace(/```(?:json)?\s*|```\s*/g, '').trim()
  if (!cleaned.startsWith('[')) {
    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1)
  }

  let parsed: RawFact[]
  try {
    parsed = JSON.parse(cleaned) as RawFact[]
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) return []

  return parsed.filter(
    (f): f is { type: FactType; key: string; value: string } =>
      typeof f.type === 'string' &&
      VALID_TYPES.has(f.type as FactType) &&
      typeof f.key === 'string' &&
      f.key.length > 0 &&
      typeof f.value === 'string' &&
      f.value.length > 0,
  )
}

export async function extractFacts(
  messages: ChatMessage[],
  config: PhilaConfig,
): Promise<Array<{ type: FactType; key: string; value: string }>> {
  const conversation = buildConversation(messages)
  const raw = await chat(EXTRACT_SYSTEM, conversation, config)
  return parseExtraction(raw)
}
