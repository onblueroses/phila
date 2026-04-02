// Generates training JSONL for fine-tuning the phila gate model.
//
// Modes:
//   --count N --category buried-thread|speak-unanswered|silent-sarcasm|general|all --out path
//       Generate N examples via claude --print, write as JSONL
//   --seed --out path
//       Export existing trainScenarios() as seed.jsonl (silent + speak with claude-generated responses)
//   --count N --out path --validate
//       Generate then validate output shape
//   --out path --validate
//       Validate an existing JSONL file
//
// JSONL shape (one record per line):
//   {"messages":[
//     {"role":"system","content":"<full buildSystemPrompt output>"},
//     {"role":"user","content":"<conversation>"},
//     {"role":"assistant","content":"{\"action\":\"silent\"}"}
//   ]}
//
// Always run with CLAUDECODE='' to suppress claude-code env detection.

import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'

import { buildSystemPrompt } from '../../src/gate.ts'
import { trainScenarios } from '../scenarios.ts'
import type { Scenario } from '../scenarios.ts'

interface TrainingRecord {
  messages: [
    { role: 'system'; content: string },
    { role: 'user'; content: string },
    { role: 'assistant'; content: string }
  ]
}

// Neutral profile for training — no bias, no context hints
const SYSTEM_PROMPT = buildSystemPrompt({ chatId: 'train', speakBias: 0, updatedAt: 0 })

function silentRecord(conversation: string): TrainingRecord {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: conversation },
      { role: 'assistant', content: '{"action":"silent"}' },
    ],
  }
}

function speakRecord(conversation: string, reason: string, response: string): TrainingRecord {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: conversation },
      { role: 'assistant', content: JSON.stringify({ action: 'speak', reason, response }) },
    ],
  }
}

function callClaude(prompt: string): string {
  try {
    // execFileSync passes prompt as direct argv — no shell interpolation risk.
    return execFileSync('claude', ['--print', prompt], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CLAUDECODE: '' },
    })
  } catch (e) {
    console.warn('claude --print failed:', e instanceof Error ? e.message : e)
    return ''
  }
}

function stripFences(raw: string): string {
  const lines = raw.split('\n')
  const start = /^```(?:json)?\s*$/.test(lines[0]?.trim() ?? '') ? 1 : 0
  const end = /^```\s*$/.test(lines[lines.length - 1]?.trim() ?? '') ? lines.length - 1 : lines.length
  return lines.slice(start, end).join('\n').trim()
}

function extractJsonArray(raw: string): string | null {
  const cleaned = stripFences(raw)
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  return cleaned.slice(start, end + 1)
}

// --- Seed generation ---

function buildSeedResponsePrompt(speakSeeds: Scenario[]): string {
  const items = speakSeeds.map((s) => ({
    name: s.name,
    conversation: s.conversation,
    category: s.category,
  }))

  return `For each iMessage conversation below, generate the correct speak response for "phila", a silent group chat bot that only speaks when: (1) directly addressed as "phila", (2) there's an uncorrected factual error, or (3) a factual question went unanswered.

Style: lowercase, 1-2 sentences, casual, no filler phrases.

Input conversations: ${JSON.stringify(items)}

Return ONLY a JSON array. Each element:
{"name":"<exact scenario name>","reason":"direct address|wrong fact|unanswered question","response":"<casual lowercase response>"}

No prose, no markdown fences.`
}

function fetchSeedSpeakResponses(
  speakSeeds: Scenario[],
): Map<string, { reason: string; response: string }> {
  if (speakSeeds.length === 0) return new Map()
  console.log(`Generating responses for ${speakSeeds.length} seed speak scenarios via claude...`)
  const raw = callClaude(buildSeedResponsePrompt(speakSeeds))
  const arr = extractJsonArray(raw)
  if (!arr) {
    console.warn('No JSON array in claude response for seed responses')
    return new Map()
  }

  const result = new Map<string, { reason: string; response: string }>()
  try {
    const parsed = JSON.parse(arr) as Array<Record<string, unknown>>
    for (const item of parsed) {
      if (
        typeof item['name'] === 'string' &&
        typeof item['reason'] === 'string' &&
        typeof item['response'] === 'string'
      ) {
        result.set(item['name'], {
          reason: item['reason'],
          response: item['response'],
        })
      }
    }
  } catch (e) {
    console.warn('JSON parse failed for seed responses:', e instanceof Error ? e.message : e)
  }
  return result
}

function generateSeedRecords(): TrainingRecord[] {
  const seeds = trainScenarios()
  const silentSeeds = seeds.filter((s) => s.expect === 'silent')
  const speakSeeds = seeds.filter((s) => s.expect === 'speak')

  const speakResponses = fetchSeedSpeakResponses(speakSeeds)

  const records: TrainingRecord[] = []
  for (const s of silentSeeds) {
    records.push(silentRecord(s.conversation))
  }
  for (const s of speakSeeds) {
    const resp = speakResponses.get(s.name)
    if (resp) {
      records.push(speakRecord(s.conversation, resp.reason, resp.response))
    } else {
      console.warn(`No response generated for seed: ${s.name} — skipping`)
    }
  }
  return records
}

// --- Generated example generation ---

interface GeneratedExample {
  conversation: string
  action: 'silent' | 'speak'
  reason?: string
  response?: string
}

function buildGenerationPrompt(count: number, category: string): string {
  let categoryInstructions: string

  if (category === 'buried-thread') {
    categoryInstructions = `Generate ${count} BURIED THREAD speak examples. In each, the speak trigger must be buried in the middle of unrelated social chatter:
- A factual question asked mid-conversation, ignored by others who continue the unrelated topic
- A factual error stated mid-conversation, agreed with but never corrected
- The conversation must be 4+ messages total, with the trigger NOT at the end
- Generate speak examples only (action: "speak")

Example structure:
person1: haha yeah same
person2: ok so who knows what year ww2 ended
person3: lol no idea
person1: anyway back to the main thing`
  } else if (category === 'speak-unanswered') {
    categoryInstructions = `Generate ${count} SIMPLE UNANSWERED QUESTION speak examples.
Rules:
- Someone asks a clear factual question (not opinion, not rhetorical)
- Others don't know the answer ("idk", "no clue", wrong guess, silence)
- phila should speak because the question is still open (action: "speak", reason: "unanswered question")
- Keep conversations SHORT (2-4 messages). No burying — the question is front and centre.
- Vary topics: history, science, geography, pop culture, basic facts
- Mix difficulty: obvious ones ("what year did WW2 end") and slightly trickier ones ("what's the capital of Australia")

Example:
person1: wait what language do they speak in brazil
person2: spanish?
person3: idk probably spanish

→ {"action":"speak","reason":"unanswered question","response":"portuguese, brazil was colonized by portugal"}`
  } else if (category === 'silent-sarcasm') {
    categoryInstructions = `Generate ${count} SARCASM / JOKE / IRONY silent examples.
Rules:
- Someone states a clearly wrong "fact" but it's obviously sarcastic, ironic, or a joke
- The surrounding tone makes it clear nobody believes it — it's banter, not genuine misinformation
- phila should stay SILENT (action: "silent") — correcting a joke is socially tone-deaf
- Vary the sarcasm style: hyperbolic wrong claims, deadpan irony, absurdist jokes, playful teasing
- NEVER generate examples where the wrong fact could be genuinely believed

Example patterns:
  "oh yeah the moon is made of cheese, definitely" + agreement banter → silent
  "as we all know, the sun rises in the west" used sarcastically → silent
  wrong fact stated in obvious self-mockery → silent`
  } else {
    categoryInstructions = `Generate ${count} mixed examples with this approximate distribution:
- 40% silent-social (small talk, emotions, opinions, celebrations, gossip)
- 15% silent-corrected (someone already corrected the error)
- 10% silent-rhetorical (rhetorical questions, venting, hypotheticals)
- 10% silent-logistics (planning, coordinating)
- 5% silent-media (memes, links, reactions)
- 10% speak-direct (phila addressed by name)
- 5% speak-correction (uncorrected factual error)
- 5% speak-unanswered (factual question, nobody answers)

Vary difficulty: mix of obvious, medium, and edge-case conversations.`
  }

  return `You are generating fine-tuning training data for "phila", a group chat bot.

Phila's rules (the system prompt it uses):
---
${SYSTEM_PROMPT}
---

${categoryInstructions}

Return ONLY a JSON array. No prose, no markdown fences. Each element:
- "conversation": multi-line string, speaker labels person1/person2/etc., \\n separated
- "action": "silent" or "speak"
- "reason": string required if action is "speak" (e.g. "direct address", "wrong fact", "unanswered question")
- "response": string required if action is "speak" — lowercase, 1-2 sentences, casual, no "happy to help"

Example speak record:
{"conversation":"person1: anyone catch the game\\nperson2: yeah great match\\nperson1: btw what country is cairo in\\nperson2: no idea\\nperson3: me neither","action":"speak","reason":"unanswered question","response":"cairo is in egypt"}

Example silent record:
{"conversation":"person1: this assignment is killing me\\nperson2: same honestly\\nperson3: prof is brutal","action":"silent"}`
}

function parseGeneratedExamples(raw: string): GeneratedExample[] {
  const arr = extractJsonArray(raw)
  if (!arr) {
    console.warn('No JSON array found in claude output')
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(arr)
  } catch (e) {
    console.warn('JSON parse failed on generated examples:', e instanceof Error ? e.message : e)
    return []
  }
  if (!Array.isArray(parsed)) return []

  const valid: GeneratedExample[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const s = item as Record<string, unknown>
    if (typeof s['conversation'] !== 'string') continue
    if (s['action'] !== 'silent' && s['action'] !== 'speak') continue
    if (
      s['action'] === 'speak' &&
      (typeof s['reason'] !== 'string' || typeof s['response'] !== 'string')
    ) {
      console.warn(`Discarding speak example — missing reason or response`)
      continue
    }
    valid.push({
      conversation: s['conversation'],
      action: s['action'],
      reason: typeof s['reason'] === 'string' ? s['reason'] : undefined,
      response: typeof s['response'] === 'string' ? s['response'] : undefined,
    })
  }
  return valid
}

function generateExamples(count: number, category: string): TrainingRecord[] {
  // Claude handles up to ~200 examples cleanly; batch into chunks if larger
  const BATCH = 80
  const records: TrainingRecord[] = []
  let remaining = count

  while (remaining > 0) {
    const batchCount = Math.min(BATCH, remaining)
    console.log(`  Requesting batch of ${batchCount} examples...`)
    const raw = callClaude(buildGenerationPrompt(batchCount, category))
    const examples = parseGeneratedExamples(raw)
    console.log(`  Got ${examples.length} valid examples (${batchCount - examples.length} discarded)`)

    for (const ex of examples) {
      if (ex.action === 'silent') {
        records.push(silentRecord(ex.conversation))
      } else if (ex.reason && ex.response) {
        records.push(speakRecord(ex.conversation, ex.reason, ex.response))
      }
    }
    remaining -= batchCount
  }

  return records
}

// --- Validation ---

function validateFile(path: string): { valid: number; invalid: number; total: number } {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())

  let valid = 0
  let invalid = 0

  for (let i = 0; i < lines.length; i++) {
    try {
      const record = JSON.parse(lines[i]) as { messages?: unknown[] }
      if (!Array.isArray(record.messages) || record.messages.length !== 3)
        throw new Error('messages must be array of 3')
      const [sys, user, asst] = record.messages as Array<{ role?: string; content?: string }>
      if (sys.role !== 'system') throw new Error(`bad role at [0]: ${sys.role}`)
      if (user.role !== 'user') throw new Error(`bad role at [1]: ${user.role}`)
      if (asst.role !== 'assistant') throw new Error(`bad role at [2]: ${asst.role}`)
      if (typeof sys.content !== 'string' || sys.content.length === 0)
        throw new Error('system content empty')
      if (typeof user.content !== 'string' || user.content.length === 0)
        throw new Error('user content empty')
      // Assistant turn must be valid JSON with action field
      const parsed = JSON.parse(asst.content ?? 'null') as { action?: string }
      if (parsed.action !== 'silent' && parsed.action !== 'speak')
        throw new Error(`invalid action: ${parsed.action}`)
      valid++
    } catch (e) {
      invalid++
      console.warn(`[INVALID] line ${i + 1}: ${e instanceof Error ? e.message : e}`)
    }
  }

  return { valid, invalid, total: lines.length }
}

// --- Entry point ---

const { values } = parseArgs({
  options: {
    count: { type: 'string' },
    category: { type: 'string', default: 'all' },
    out: { type: 'string' },
    validate: { type: 'boolean', default: false },
    seed: { type: 'boolean', default: false },
  },
  strict: true,
})

if (!values.out) {
  console.error(
    'Usage: node --experimental-strip-types test/research/gen-finetune-data.ts' +
      ' --out <path> [--count N] [--category buried-thread|speak-unanswered|silent-sarcasm|general|all]' +
      ' [--validate] [--seed]',
  )
  process.exit(1)
}

// Validate-only mode (no generation)
if (values.validate && !values.count && !values.seed) {
  if (!existsSync(values.out)) {
    console.error(`File not found: ${values.out}`)
    process.exit(1)
  }
  const { valid, invalid, total } = validateFile(values.out)
  console.log(`Validation: ${valid}/${total} valid, ${invalid} invalid`)
  process.exit(invalid > 0 ? 1 : 0)
}

// Ensure output directory exists
const dir = values.out.split('/').slice(0, -1).join('/')
if (dir) mkdirSync(dir, { recursive: true })

const records: TrainingRecord[] = []

if (values.seed) {
  // Export trainScenarios() as JSONL seed file
  console.log('Generating seed records from trainScenarios()...')
  const seedRecords = generateSeedRecords()
  records.push(...seedRecords)
  console.log(`Generated ${records.length} seed records`)
}

if (values.count) {
  const count = parseInt(values.count, 10)
  if (isNaN(count) || count < 1) {
    console.error('--count must be a positive integer')
    process.exit(1)
  }
  const category = values.category ?? 'all'
  console.log(`Generating ${count} ${category} examples via claude --print...`)
  const generated = generateExamples(count, category)
  records.push(...generated)
  console.log(`Generated ${generated.length} records`)
}

if (records.length === 0) {
  console.error('No records generated. Provide --count N and/or --seed.')
  process.exit(1)
}

const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
writeFileSync(values.out, jsonl)
console.log(`Written ${records.length} records to ${values.out}`)

if (values.validate) {
  const { valid, invalid, total } = validateFile(values.out)
  console.log(`Validation: ${valid}/${total} valid, ${invalid} invalid`)
  if (invalid > 0) process.exit(1)
}
