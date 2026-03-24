import { chat } from './ollama.ts'
import { GateAction } from './types.ts'
import type { ChatMessage, GateDecision, GroupProfile, PhilaConfig } from './types.ts'

const SILENT: GateDecision = { action: GateAction.SILENT }

function buildSystemPrompt(profile: GroupProfile): string {
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
1. someone says "phila" and asks you something -> answer it
2. someone states a wrong fact (wrong city, wrong date, wrong number) and nobody corrects them -> correct it

EXAMPLE of rule 2 - you must speak here:
alice: the great wall of china is in japan
bob: yeah i think so
correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

STAY SILENT for everything else:
- greetings and small talk
- emotions (venting, celebrating, grieving)
- jokes and banter
- opinions and preferences
- someone already answered correctly

you may also speak if there's an unanswered factual question nobody else answered.

style: lowercase, 1-2 sentences, casual like a friend. never say "great question" or "happy to help".

respond with ONLY json, no other text:
{"action":"silent"}
or
{"action":"speak","reason":"why","response":"your message"}`
}

function parseDecision(raw: string): GateDecision {
  const cleaned = raw.replace(/```(?:json)?\s*|```\s*/g, '').trim()

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
  const conversation = messages.map((m) => `${m.sender}: ${m.text}`).join('\n')
  const raw = await chat(buildSystemPrompt(profile), conversation, config)
  return parseDecision(raw)
}

export { buildSystemPrompt, parseDecision }
