// Dual-pass gate: additive architecture that keeps the monolithic gate
// and adds memory-recall as a second pass.
//
// Pass 1: Monolithic gate (unchanged, proven 86.4% on 140 scenarios)
//   -> SPEAK? -> done
//   -> SILENT? -> Pass 2
//
// Pass 2: Memory-recall check (only when Pass 1 said SILENT)
//   "Is someone asking about something from earlier in this conversation?"
//   -> NO? -> stay SILENT
//   -> YES? -> retrieve facts from store, generate response
//
// Zero regression risk: Pass 1 IS the current gate.

import { chat } from './ollama.ts'
import { GateAction } from './types.ts'
import type { ChatMessage, ConversationContext, GateDecision, GroupProfile, HierarchicalDecision, PhilaConfig } from './types.ts'
import { evaluate, buildConversation, parseDecision } from './gate.ts'
import type { Memory } from './memory.ts'
import type { ExtractedFact } from './types.ts'

const SILENT: GateDecision = { action: GateAction.SILENT }

// Pass 2 prompt: check if someone is asking about something from earlier
const MEMORY_CHECK_SYSTEM = `you are phila, a member of a group chat.

someone in this conversation might be asking about something that was discussed earlier.
you have been given some facts extracted from the conversation history.

if someone is asking a question that these facts can answer, respond with the answer.
if nobody is asking about earlier conversation, or the facts don't help, stay silent.

respond with ONLY json:
{"action":"silent"}
or
{"action":"speak","reason":"memory recall","response":"your message"}

style: lowercase, 1-2 sentences, casual like a friend. no "great question" or "happy to help".`

function buildMemoryPrompt(conversation: string, facts: ExtractedFact[]): string {
  const factLines = facts.map(f => `- ${f.type}: ${f.key} = ${f.value}`).join('\n')
  return `conversation:\n${conversation}\n\nfacts from earlier in this chat:\n${factLines}`
}

export async function evaluateDual(
  messages: ChatMessage[],
  recent: ChatMessage[],
  profile: GroupProfile,
  config: PhilaConfig,
  ctx?: ConversationContext,
  memory?: Memory,
): Promise<HierarchicalDecision> {
  const stages: string[] = []

  // Pass 1: monolithic gate (unchanged)
  const pass1 = await evaluate(recent, profile, config, ctx)
  stages.push(`p1:${pass1.action}`)

  if (pass1.action === GateAction.SPEAK) {
    return { ...pass1, stages, classification: 'claim' }
  }

  // Pass 2: memory-recall (only when Pass 1 said SILENT and we have a fact store)
  if (!memory) {
    stages.push('p2:skip-no-memory')
    return { ...SILENT, stages, classification: 'social' }
  }

  const facts = memory.getRecentFacts(messages[0]?.chatId ?? '', 20)
  if (facts.length === 0) {
    stages.push('p2:skip-no-facts')
    return { ...SILENT, stages, classification: 'social' }
  }

  const conversation = buildConversation(recent)
  const userMsg = buildMemoryPrompt(conversation, facts)
  const raw = await chat(MEMORY_CHECK_SYSTEM, userMsg, config)
  stages.push('p2:memory-check')
  const decision = parseDecision(raw)

  if (decision.action === GateAction.SPEAK) {
    stages.push('p2:speak')
    return { ...decision, stages, classification: 'memory-query' }
  }

  stages.push('p2:silent')
  return { ...SILENT, stages, classification: 'social' }
}
