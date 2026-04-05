// Generate diverse gate training examples using Haiku via OpenRouter MCP.
// Targets weak categories from benchmark data with persona diversity.
//
// Usage: node --experimental-strip-types research/v3-finetune/gen-gate-synthetic.ts --out data/v3-finetune/gate-synthetic.jsonl --count 5000

import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { buildSystemPrompt } from '../../src/gate.ts'
import type { GroupProfile } from '../../src/types.ts'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'data/v3-finetune/gate-synthetic.jsonl' },
    count: { type: 'string', default: '5000' },
  },
})

const TARGET = parseInt(args.count!)
const profile: GroupProfile = { chatId: 'train', speakBias: 0.0, updatedAt: Date.now() }
const systemPrompt = buildSystemPrompt(profile)

// Categories weighted by benchmark weakness
const CATEGORIES = [
  { name: 'silent-social', expect: 'silent', weight: 20, desc: 'casual chat between friends: weekend plans, food opinions, dating, gym, gaming, music, movies, work complaints, pets, weather. 3-5 messages. lowercase, slang, emoji ok.' },
  { name: 'silent-corrected', expect: 'silent', weight: 8, desc: 'someone states a wrong fact but ANOTHER person already corrected them. use words like "actually", "no its", "thats not right". 4-6 messages.' },
  { name: 'silent-rhetorical', expect: 'silent', weight: 5, desc: 'rhetorical questions, hypotheticals, "would you rather", existential musings. nobody expects a factual answer. 3-4 messages.' },
  { name: 'silent-logistics', expect: 'silent', weight: 5, desc: 'planning thats already resolved: ride sorted, bill split, time agreed. everyone confirmed. 3-5 messages.' },
  { name: 'speak-correction', expect: 'speak', weight: 15, desc: 'someone states a WRONG fact (wrong date, name, number, science, geography, history) and nobody corrects them. the WRONG fact must be clearly, verifiably wrong. 3-4 messages.' },
  { name: 'speak-unanswered', expect: 'speak', weight: 10, desc: 'someone asks a factual question nobody answers. others say "idk" or give wrong answers or change subject. 3-5 messages.' },
  { name: 'speak-direct', expect: 'speak', weight: 8, desc: 'someone addresses "phila" by name with a question or request. use "phila" clearly as addressing the bot. 2-3 messages.' },
  { name: 'adversarial-silent', expect: 'silent', weight: 10, desc: 'tricky edge cases that LOOK like they need a response but should stay silent: sarcastic wrong facts with laughing, jokes with false claims, "philo"/"philadelphia"/"philanthropy" (NOT "phila"), opinions that sound factual, questions directed at a specific person not phila.' },
  { name: 'speak-memory-logistics', expect: 'speak', weight: 8, desc: 'someone asks about plans discussed EARLIER in the conversation. first part has the plan ("dinner at thai place 7pm"), later someone asks about it ("where are we eating?"). 5-7 messages.' },
  { name: 'speak-memory-commitment', expect: 'speak', weight: 6, desc: 'someone asks WHO committed to do WHAT from earlier in conversation. first part has commitment ("ill bring drinks"), later someone asks ("whos bringing drinks?"). 5-7 messages.' },
  { name: 'speak-memory-personal', expect: 'speak', weight: 5, desc: 'someone asks about a personal fact mentioned earlier. first: someone says preference/allergy/restriction. later: someone asks about it. 5-7 messages.' },
]

const PERSONAS = [
  'college students in a dorm group chat',
  'coworkers at a tech company',
  'friends planning a weekend trip',
  'roommates coordinating household stuff',
  'a sports fan group chat',
  'parents in a school parents group',
  'musicians in a band group chat',
  'gym buddies',
  'book club members',
  'neighbors in an apartment building',
  'siblings family group chat',
  'hiking group',
  'cooking enthusiasts',
  'gaming clan chat',
  'old friends from high school reconnecting',
  'grad students in the same program',
  'volunteer group organizing events',
  'travel buddies planning next trip',
  'dog owners at the same park',
  'new employees at same company',
]

const OLLAMA_URL = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'

async function generateOne(category: typeof CATEGORIES[number], persona: string): Promise<string | null> {
  const prompt = `Generate a realistic group chat conversation for the category "${category.name}".
The expected bot decision is: ${category.expect.toUpperCase()}

Category: ${category.desc}

Persona context: ${persona}

Use person1, person2, person3 (etc) as speaker names. Write 3-7 messages.
Make it feel like a REAL group chat - lowercase, abbreviations, slang, varied sentence length.
Do NOT use the same topics/patterns repeatedly.

Respond with ONLY a JSON object:
{"conversation":"person1: ...\nperson2: ...\nperson3: ...","topic":"brief topic if speak scenario"}`

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [
          { role: 'system', content: 'You generate realistic group chat conversations for training a chat bot. Respond with only valid JSON.' },
          { role: 'user', content: prompt },
        ],
        stream: false,
        options: { temperature: 0.9, num_predict: 256, top_p: 0.95 },
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

    const parsed = JSON.parse(raw) as { conversation?: string; topic?: string }
    if (!parsed.conversation || parsed.conversation.length < 20) return null

    // Build training example
    const assistant = category.expect === 'speak'
      ? JSON.stringify({ action: 'speak', reason: category.name, response: parsed.topic ?? 'relevant response' })
      : JSON.stringify({ action: 'silent' })

    const example = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: parsed.conversation },
        { role: 'assistant', content: assistant },
      ],
    }

    return JSON.stringify(example)
  } catch {
    return null
  }
}

async function main() {
  // Resume from checkpoint
  let written = 0
  if (existsSync(args.out!)) {
    const existing = readFileSync(args.out!, 'utf-8').trim().split('\n').filter(Boolean)
    written = existing.length
    console.log(`Resuming from ${written} existing examples`)
  } else {
    writeFileSync(args.out!, '')
  }

  // Build weighted category pool
  const pool: typeof CATEGORIES[number][] = []
  for (const cat of CATEGORIES) {
    for (let i = 0; i < cat.weight; i++) pool.push(cat)
  }

  let attempts = 0
  const maxAttempts = TARGET * 3

  while (written < TARGET && attempts < maxAttempts) {
    const cat = pool[Math.floor(Math.random() * pool.length)]!
    const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)]!
    attempts++

    const result = await generateOne(cat, persona)
    if (result) {
      appendFileSync(args.out!, result + '\n')
      written++
      if (written % 50 === 0) {
        console.log(`[${written}/${TARGET}] ${cat.name} (${attempts} attempts, ${Math.round(written / attempts * 100)}% success)`)
      }
    }
  }

  console.log(`\nDone: ${written} examples, ${attempts} attempts (${Math.round(written / attempts * 100)}% success rate)`)
  console.log(`Output: ${args.out}`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
