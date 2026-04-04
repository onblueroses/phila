// Hierarchical gate: decomposes the monolithic speak/silent decision into stages.
//
// Stage 0 (rule-based, no LLM): direct address detection (current batch only)
// Stage 1 (LLM): classify conversation - does it contain a factual claim or question?
// Stage 2 (LLM, conditional): if yes, is the claim wrong / question unanswered?
//
// Rationale: the monolithic gate asks a 3B model to simultaneously (a) understand
// social context, (b) identify factual claims, (c) verify correctness, and
// (d) compose a response. Decomposition lets each stage focus on one thing.
//
// Profile/context integration:
// - speakBias: rule-based gate between Stage 0 and Stage 1 (strong negative bias
//   short-circuits to SILENT unless direct address)
// - late-night: same rule-based gate
// - high-traffic: same rule-based gate
// - correctionHint: passed to Stage 2 claim prompt (not a conversation-wide veto)
// - groupNotes: injected into Stage 2 prompts as context

import { chat, chatFast } from './ollama.ts'
import { GateAction } from './types.ts'
import type { ChatMessage, Classification, ConversationContext, GateDecision, GroupProfile, HierarchicalDecision, PhilaConfig } from './types.ts'
import { buildConversation, parseDecision } from './gate.ts'

const SILENT: GateDecision = { action: GateAction.SILENT }

// Stage 0: direct address detection on the NEW batch only (not full history).
// Must distinguish "hey phila" (direct address) from "phila museum" or
// "my friend phila" (incidental mention). Only triggers on patterns where
// phila is clearly being spoken TO, not ABOUT. Ambiguous cases fall through
// to Stage 1 where the LLM classifies properly.
const DIRECT_ADDRESS_PATTERNS = [
  /^phila\s*[,?!]/i,             // "phila, ..." or "phila?" or "phila!"
  /^phila\s+(do|can|what|how|will|would|should|did|does|whats|hows)\b/i, // "phila what..." (no is/are - those are third-person)
  /\bhey\s+phila\b/i,            // "hey phila"
  /\byo\s+phila\b/i,             // "yo phila"
  /\bask\s+phila\b/i,            // "ask phila"
  /\bphila\s+(do|can|what|how|will|would|should|did|does|whats|hows)\b/i, // "phila what..." mid-sentence (no is/are)
]

export function detectDirectAddress(messages: ChatMessage[]): boolean {
  for (const m of messages) {
    if (DIRECT_ADDRESS_PATTERNS.some(p => p.test(m.text))) return true
  }
  return false
}

// Rule-based context gate: applies profile and context signals before LLM calls.
// Returns 'suppress' to force silence, 'continue' to proceed to classification.
function contextGate(profile: GroupProfile, ctx?: ConversationContext): 'suppress' | 'continue' {
  // Strong negative bias: only allow direct address (already handled before this)
  if (profile.speakBias <= -0.15) return 'suppress'

  // Late night: suppress non-direct-address activity
  if (ctx?.latestMessageHour != null && (ctx.latestMessageHour >= 23 || ctx.latestMessageHour < 7)) {
    return 'suppress'
  }

  // High traffic: be cautious
  if (ctx?.messagesPerMinute != null && ctx.messagesPerMinute > 5) {
    // Moderate negative bias + high traffic = suppress
    if (profile.speakBias <= -0.05) return 'suppress'
  }

  return 'continue'
}

const STAGE1_SYSTEM = `you classify group chat messages. your ONLY job: pick one category.

respond with ONLY one word:
- "social" if it's just chat, opinions, emotions, jokes, sarcasm, or banter
- "claim" if someone stated a wrong fact (wrong date, name, number, science fact)
- "question" if someone asked a factual question that wasn't answered correctly
- "memory" if someone is asking about something discussed EARLIER in this conversation (e.g. "where are we meeting?", "what time did we say?", "who is bringing drinks?", "what was the address again?")

if unsure, say "social". most conversations are social.`

function buildStage2ClaimSystem(ctx?: ConversationContext): string {
  let prompt = `someone in this group chat stated a fact. your job: is the fact wrong, AND has nobody corrected it yet?`

  if (ctx?.correctionHint) {
    prompt += `\n\nIMPORTANT: check carefully whether someone already corrected the error in the conversation. look for words like "actually", "no its", "thats not right".`
  }

  if (ctx?.groupNotes) {
    prompt += `\n\ngroup context: ${ctx.groupNotes}`
  }

  prompt += `

if the fact is wrong and uncorrected:
{"action":"speak","reason":"wrong fact","response":"your correction here"}

if the fact is correct, or someone already corrected it, or it's a joke/sarcasm:
{"action":"silent"}

style: lowercase, 1-2 sentences, casual. no "great question" or "happy to help".
respond with ONLY json.`

  return prompt
}

function buildStage2QuestionSystem(ctx?: ConversationContext): string {
  let prompt = `someone in this group chat asked a factual question. your job: did anyone answer it correctly?`

  if (ctx?.groupNotes) {
    prompt += `\n\ngroup context: ${ctx.groupNotes}`
  }

  prompt += `

if the question is unanswered or answered incorrectly:
{"action":"speak","reason":"unanswered question","response":"your answer here"}

if someone already answered correctly, or the question is rhetorical/opinion-based:
{"action":"silent"}

style: lowercase, 1-2 sentences, casual. no "great question" or "happy to help".
respond with ONLY json.`

  return prompt
}

function buildDirectSystem(profile: GroupProfile, ctx?: ConversationContext): string {
  let prompt = `you are phila, a member of a group chat. someone addressed you directly.
respond helpfully in 1-2 sentences, casual like a friend. lowercase. no "great question" or "happy to help".`

  if (profile.speakBias > 0.03) {
    prompt += `\nthis group appreciates your input. feel comfortable being helpful.`
  }

  if (ctx?.groupNotes) {
    prompt += `\n\ngroup context: ${ctx.groupNotes}`
  }

  prompt += `

respond with ONLY json:
{"action":"speak","reason":"direct address","response":"your message"}`

  return prompt
}

export function parseStage1(raw: string): Classification {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z]/g, '')
  if (cleaned === 'claim') return 'claim'
  if (cleaned === 'question') return 'question'
  if (cleaned === 'memory') return 'memory-query'
  return 'social'
}

export async function evaluateHierarchical(
  messages: ChatMessage[],
  profile: GroupProfile,
  config: PhilaConfig,
  ctx?: ConversationContext,
  recentHistory?: ChatMessage[],
): Promise<HierarchicalDecision> {
  // Use recent history for full conversation context (Stage 1/2),
  // but only check the current batch for direct address (Stage 0).
  const allMessages = recentHistory ?? messages
  const conversation = buildConversation(allMessages)
  const stages: string[] = []

  // Stage 0: direct address (checks current batch only, not full history).
  // Only triggers when "phila" appears to be directly addressed (not "philadelphia",
  // "phila museum", etc). The \bphila\b regex catches near-misses, so we additionally
  // check that phila appears in a position consistent with address (start of message,
  // after "hey/yo", or followed by question/comma). Ambiguous cases fall through to
  // Stage 1 where the LLM classifies properly.
  const isDirect = detectDirectAddress(messages)
  stages.push(`s0:${isDirect ? 'direct' : 'no-direct'}`)

  if (isDirect) {
    const raw = await chat(buildDirectSystem(profile, ctx), conversation, config)
    stages.push('s0-direct:respond')
    const decision = parseDecision(raw)
    return { ...decision, stages, classification: 'social' }
  }

  // Context gate: apply profile/context signals before spending an LLM call
  const gateResult = contextGate(profile, ctx)
  if (gateResult === 'suppress') {
    stages.push('ctx-gate:suppress')
    return { ...SILENT, stages, classification: 'social' }
  }

  // Stage 1: classify (fast path - numPredict=4, enough for one word)
  const classRaw = await chatFast(STAGE1_SYSTEM, conversation, config)
  const classification = parseStage1(classRaw)
  stages.push(`s1:${classification}`)

  if (classification === 'social') return { ...SILENT, stages, classification }

  // Moderate negative bias: only allow direct address (already handled) and strong corrections
  if (profile.speakBias <= -0.05 && classification === 'question') {
    stages.push('bias-gate:suppress-question')
    return { ...SILENT, stages, classification }
  }

  // memory-query: will be handled in Phase 3 (memory extraction pipeline)
  // For now, fall through to question handler
  const effectiveClassification = classification === 'memory-query' ? 'question' : classification

  // Stage 2: verify and respond (only reached for claims/questions)
  const stage2System = effectiveClassification === 'claim'
    ? buildStage2ClaimSystem(ctx)
    : buildStage2QuestionSystem(ctx)
  const raw = await chat(stage2System, conversation, config)
  stages.push('s2:decide')
  const decision = parseDecision(raw)
  return { ...decision, stages, classification }
}
