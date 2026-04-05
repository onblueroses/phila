// Generate memory recall (Pass 2) training data using Ollama on VPS.
// Teaches the model to answer questions from injected extracted facts.
// Format: system=MEMORY_CHECK_SYSTEM, user=conversation+facts, assistant=speak/silent
//
// Usage: node --experimental-strip-types research/v3-finetune/gen-memory-recall.ts --out data/v3-finetune/memory-recall.jsonl --count 3000

import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'data/v3-finetune/memory-recall.jsonl' },
    count: { type: 'string', default: '3000' },
  },
})

const TARGET = parseInt(args.count!)
const OLLAMA_URL = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'

// Must match src/gate-dual.ts MEMORY_CHECK_SYSTEM exactly
const MEMORY_CHECK_SYSTEM = `you are phila, a member of a group chat.

someone just asked about something discussed earlier. you have facts from the conversation.

EXAMPLES:
facts: meeting_location = thai place on main at 7pm
question: "where are we going tonight?"
correct response: {"action":"speak","reason":"memory recall","response":"the thai place on main, 7pm"}

facts: whos_driving = person1
question: "who said theyd drive?"
correct response: {"action":"speak","reason":"memory recall","response":"person1 said theyd drive"}

facts: allergy = person1 is allergic to shellfish
question: "can everyone eat shrimp?"
correct response: {"action":"speak","reason":"memory recall","response":"person1 mentioned theyre allergic to shellfish"}

facts: commitment = person1 will bring chips, commitment = person2 will handle drinks
question: "who said theyd get drinks?"
correct response: {"action":"speak","reason":"memory recall","response":"person2 said theyd handle drinks"}

USE THE FACTS TO ANSWER. if the facts contain the answer, speak up.
only stay silent if the facts genuinely don't help answer what was asked.

respond with ONLY json:
{"action":"silent"}
or
{"action":"speak","reason":"memory recall","response":"your message"}

style: lowercase, 1-2 sentences, casual like a friend.`

// Scenario types: speak (facts answer the question) and silent (facts don't help)
const RECALL_SCENARIOS = [
  // SPEAK - facts answer the question
  { expect: 'speak', weight: 35, desc: 'someone asks about plans/logistics. the facts contain the answer (time, place, event). generate: conversation where someone asks, + facts that answer it, + correct speak response.' },
  { expect: 'speak', weight: 25, desc: 'someone asks who committed to do something. the facts track commitments. generate: conversation asking "whos doing X?", + commitment facts, + correct speak response naming the person.' },
  { expect: 'speak', weight: 15, desc: 'someone asks about a personal fact (allergy, preference, birthday). facts have it. generate: conversation + relevant personal facts + correct speak response.' },
  // SILENT - facts exist but don't answer what was asked
  { expect: 'silent', weight: 15, desc: 'someone asks something the facts CANNOT answer. facts are about a different topic. generate: conversation + unrelated facts. the model should stay silent.' },
  { expect: 'silent', weight: 10, desc: 'pure social conversation, no question being asked. facts exist from prior context but nobody is asking about them. stay silent.' },
]

function buildMemoryPrompt(conversation: string, facts: Array<{type: string; key: string; value: string}>): string {
  const factLines = facts.map(f => `- ${f.type}: ${f.key} = ${f.value}`).join('\n')
  return `conversation:\n${conversation}\n\nfacts from earlier in this chat:\n${factLines}`
}

async function generateOne(scenario: typeof RECALL_SCENARIOS[number]): Promise<string | null> {
  const prompt = scenario.expect === 'speak'
    ? `Generate a memory recall training example where phila SHOULD speak.

${scenario.desc}

Create:
1. A short group chat conversation (3-5 messages, person1/person2/etc) where someone asks a question
2. 1-3 relevant extracted facts that ANSWER the question
3. The correct speak response (lowercase, casual, 1-2 sentences)

Respond ONLY with JSON:
{"conversation":"person1: ...\nperson2: ...","facts":[{"type":"logistics","key":"meeting_place","value":"thai place on main"}],"response":"the thai place on main"}`
    : `Generate a memory recall training example where phila should STAY SILENT.

${scenario.desc}

Create:
1. A short group chat conversation (3-5 messages, person1/person2/etc)
2. 1-3 extracted facts that are NOT relevant to what's being discussed
3. The correct action is SILENT because the facts don't help

Respond ONLY with JSON:
{"conversation":"person1: ...\nperson2: ...","facts":[{"type":"logistics","key":"old_plan","value":"some unrelated fact"}]}`

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [
          { role: 'system', content: 'Generate memory recall training examples for a group chat agent. JSON only.' },
          { role: 'user', content: prompt },
        ],
        stream: false,
        options: { temperature: 0.9, num_predict: 300, top_p: 0.95 },
      }),
    })
    if (!res.ok) return null

    interface OllamaResponse { message: { content: string } }
    const data = (await res.json()) as OllamaResponse
    let raw = data.message.content.replace(/```(?:json)?\s*|```\s*/g, '').trim()
    if (!raw.startsWith('{')) {
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start !== -1 && end > start) raw = raw.slice(start, end + 1)
    }

    const parsed = JSON.parse(raw) as {
      conversation?: string
      facts?: Array<{type: string; key: string; value: string}>
      response?: string
    }
    if (!parsed.conversation || !parsed.facts?.length) return null

    const userContent = buildMemoryPrompt(parsed.conversation, parsed.facts)
    const assistantContent = scenario.expect === 'speak'
      ? JSON.stringify({ action: 'speak', reason: 'memory recall', response: parsed.response ?? 'relevant answer' })
      : JSON.stringify({ action: 'silent' })

    const example = {
      messages: [
        { role: 'system', content: MEMORY_CHECK_SYSTEM },
        { role: 'user', content: userContent },
        { role: 'assistant', content: assistantContent },
      ],
    }
    return JSON.stringify(example)
  } catch {
    return null
  }
}

async function main() {
  let written = 0
  if (existsSync(args.out!)) {
    written = readFileSync(args.out!, 'utf-8').trim().split('\n').filter(Boolean).length
    console.log(`Resuming from ${written}`)
  } else {
    writeFileSync(args.out!, '')
  }

  // Build weighted pool
  const pool: typeof RECALL_SCENARIOS[number][] = []
  for (const s of RECALL_SCENARIOS) {
    for (let i = 0; i < s.weight; i++) pool.push(s)
  }

  let attempts = 0
  while (written < TARGET && attempts < TARGET * 3) {
    const scenario = pool[Math.floor(Math.random() * pool.length)]!
    attempts++

    const result = await generateOne(scenario)
    if (result) {
      appendFileSync(args.out!, result + '\n')
      written++
      if (written % 100 === 0) {
        console.log(`[${written}/${TARGET}] expect=${scenario.expect} (${attempts} attempts, ${Math.round(written / attempts * 100)}% success)`)
      }
    }
  }

  console.log(`\nDone: ${written} examples`)
  console.log(`Output: ${args.out}`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
