import { chat } from './ollama.ts'
import { GateAction } from './types.ts'
import type { ChatMessage, GateDecision, GroupProfile, PhilaConfig } from './types.ts'

const SILENT: GateDecision = { action: GateAction.SILENT }

export function buildSystemPrompt(profile: GroupProfile): string {
  let biasLine = ''
  if (profile.speakBias < -0.1) {
    biasLine = '\nthis group prefers you stay extra quiet. only speak for rules 1 and 2.\n'
  } else if (profile.speakBias > 0.05) {
    biasLine = '\nthis group appreciates your input. speak up when you can help.\n'
  }

  return `you are phila, a member of a group chat. your name is phila.
your default is silence - you only speak when it matters.
${biasLine}
ALWAYS SPEAK (these override silence):
1. someone says "phila" (greeting, question, request - anything directed at you) -> respond
2. someone states a wrong fact and nobody corrects them -> correct it
3. a factual question goes unanswered by others -> answer it

EXAMPLE of rule 1:
person1: hey phila how are you
correct response: {"action":"speak","reason":"direct address","response":"doing good, whats up"}

EXAMPLE of rule 2:
person1: the great wall of china is in japan
person2: yeah i think so
correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

STAY SILENT for everything else. examples:
- small talk between others
- emotions, venting, celebrating
- jokes, banter, memes
- opinions, preferences, debates
- gossip, drama, personal stories
- someone already answered correctly
- rhetorical questions

style: lowercase, 1-2 sentences, casual like a friend. no "great question" or "happy to help".

respond with ONLY json, no other text:
{"action":"silent"}
or
{"action":"speak","reason":"why","response":"your message"}`
}

export function parseDecision(raw: string): GateDecision {
  // Strip markdown fences, then extract first JSON object if surrounded by prose
  let cleaned = raw.replace(/```(?:json)?\s*|```\s*/g, '').trim()
  if (!cleaned.startsWith('{')) {
    const match = cleaned.match(/\{[^}]+\}/)
    if (match) cleaned = match[0]
  }

  try {
    const parsed = JSON.parse(cleaned) as { action?: string; reason?: string; response?: string }
    if (parsed.action === GateAction.SPEAK && parsed.reason && parsed.response) {
      return { action: GateAction.SPEAK, reason: parsed.reason, response: parsed.response }
    }
    return SILENT
  } catch {
    return SILENT
  }
}

export async function evaluate(
  messages: ChatMessage[],
  profile: GroupProfile,
  config: PhilaConfig,
): Promise<GateDecision> {
  // Anonymize senders to reduce context noise for the model.
  // It only needs to distinguish speakers, not know real names.
  const labels = new Map<string, string>()
  const label = (name: string) => {
    if (!labels.has(name)) labels.set(name, `person${labels.size + 1}`)
    return labels.get(name)!
  }
  const conversation = messages
    .map((m) => `${label(m.sender)}: ${m.text}`)
    .join('\n')
  const raw = await chat(buildSystemPrompt(profile), conversation, config)
  return parseDecision(raw)
}

