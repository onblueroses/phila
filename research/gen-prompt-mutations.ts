// Generates alternative gate system prompt candidates via claude --print, guided by
// failure data from prior adversarial runs. Each mutation is a complete replacement
// prompt, not a patch - so any candidate can be dropped directly into benchmark runs.

import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'

import { buildSystemPrompt } from '../src/gate.ts'

interface PromptMutation {
  name: string
  description: string
  fullPrompt: string
}

interface OutputFile {
  mutations: PromptMutation[]
  basePromptLength: number
  generatedAt: string
}

// Failure entry shape from gen-adversarial.ts output - we only need the name
// and expect/actual to summarise what went wrong for claude.
interface FailureEntry {
  name: string
  expect: string
  actual: string
  pass: boolean
}

interface AdversarialOutput {
  scenarios?: Array<{ name: string; conversation: string; expect: string; category: string }>
  results?: FailureEntry[]
  failureRate?: number
}

function loadBasePrompt(customPath: string | undefined): string {
  if (customPath) {
    if (!existsSync(customPath)) {
      console.error(`--base-prompt file not found: ${customPath}`)
      process.exit(1)
    }
    return readFileSync(customPath, 'utf8')
  }
  return buildSystemPrompt({ chatId: 'test', speakBias: 0, updatedAt: 0 })
}

function buildFailuresBlock(failuresPath: string | undefined): string {
  if (!failuresPath) return ''
  if (!existsSync(failuresPath)) {
    console.warn(`--failures file not found: ${failuresPath} (continuing without failure data)`)
    return ''
  }

  let parsed: AdversarialOutput
  try {
    parsed = JSON.parse(readFileSync(failuresPath, 'utf8')) as AdversarialOutput
  } catch (e) {
    console.warn('Could not parse --failures file:', e instanceof Error ? e.message : e)
    return ''
  }

  const failures = (parsed.results ?? []).filter((r) => !r.pass)
  if (failures.length === 0) return ''

  const lines = failures.map((f) => `  - "${f.name}": expected ${f.expect}, got ${f.actual}`)
  return `\nKnown failures from the last adversarial run (scenarios the current prompt got wrong):
${lines.join('\n')}

These failures are your primary guide. Each mutation should address at least one of these failure modes.
`
}

function buildClaudePrompt(count: number, basePrompt: string, failuresBlock: string): string {
  // Mutation strategy hints are concrete, not generic - each maps to a real observed weakness.
  const mutationStrategies = `
Mutation strategy categories to draw from (use variety across the ${count} mutations):

1. extra-examples: Add more borderline "speak" examples. The current prompt has only 1 rule-2 example.
   Add 1-2 more showing wrong facts in different phrasings (e.g. wrong person attribution, wrong numbers).

2. stronger-already-corrected: The "already corrected" silence rule is vague. The model often misses
   corrections that come several messages after the original claim or use informal phrasing like
   "wait no", "lol thats wrong", "nah it was". Enumerate more correction signals explicitly.

3. joke-context-clarity: The prompt says "jokes... even if they contain wrong facts" -> stay silent.
   But a model reading quickly may not detect the joke framing. Add a rule: if the conversation tone
   is joking, sarcastic, or comedic (e.g. "lmao", "haha", "obviously"), treat apparent wrong facts
   as jokes and stay silent.

4. opinions-and-debates: Explicitly add: never speak on opinions, preferences, or subjective debates
   even if they are framed as questions ("who's better", "do you think X is overrated", etc.).
   Factual questions vs. opinion questions is a common confusion vector.

5. rule-reorder: Reorganise the SPEAK rules so the most common silence-override cases come first and
   the most common false-positive triggers come last. Also move "already corrected" handling to
   immediately after rule 2 so the model processes it before deciding.

6. casual-correction-format: Change the example correction response from formal phrasing to more
   casual friend-style. A mismatch between the instructed style and the example may cause the model
   to produce responses that are too formal or too long.`

  return `You are improving an iMessage gate system prompt. The gate LLM reads the prompt and decides
SPEAK or SILENT for each message batch. The current gate is biased toward silence.

Current system prompt:
---
${basePrompt}
---
${failuresBlock}
Your task: produce ${count} alternative complete system prompts. Each is a full replacement for the
prompt above, not a diff or patch. Each must preserve the core silence-first philosophy and the
JSON output format ({"action":"silent"} or {"action":"speak",...}).

${mutationStrategies}

Return ONLY a JSON array. No prose, no markdown fences. Each element must have:
- name: string (short kebab-case identifier, e.g. "extra-examples", "stronger-silence")
- description: string (1-2 sentences: what changed and expected effect on failure rate)
- fullPrompt: string (the complete replacement system prompt, ready to use as-is)`
}

function callClaude(prompt: string): string {
  try {
    // execFileSync with array argv: no shell involved, no injection risk from prompt content.
    return execFileSync('claude', ['--print', prompt], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch (e) {
    console.warn('claude --print failed:', e instanceof Error ? e.message : e)
    return ''
  }
}

function stripOuterFences(raw: string): string {
  // Strip only the first and last lines if they are fence markers.
  // Using line-split avoids the multiline-flag hazard where /m makes $ match interior lines.
  const lines = raw.split('\n')
  const start = /^```(?:json)?\s*$/.test(lines[0]?.trim() ?? '') ? 1 : 0
  const end = /^```\s*$/.test(lines[lines.length - 1]?.trim() ?? '') ? lines.length - 1 : lines.length
  return lines.slice(start, end).join('\n').trim()
}

function parseMutations(raw: string): PromptMutation[] {
  if (!raw.trim()) {
    console.warn('claude returned empty output')
    return []
  }

  const cleaned = stripOuterFences(raw)
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) {
    console.warn('No JSON array found in claude output')
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch (e) {
    console.warn('JSON parse failed on claude output:', e instanceof Error ? e.message : e)
    return []
  }

  if (!Array.isArray(parsed)) {
    console.warn('claude output parsed to non-array')
    return []
  }

  return parsed as PromptMutation[]
}

function validateMutation(
  item: unknown,
  basePrompt: string,
): { valid: true; mutation: PromptMutation } | { valid: false; reason: string; name: string } {
  if (typeof item !== 'object' || item === null) {
    return { valid: false, reason: 'not an object', name: '(unknown)' }
  }
  const m = item as Record<string, unknown>
  const name = typeof m['name'] === 'string' ? m['name'] : '(unnamed)'

  if (typeof m['name'] !== 'string') return { valid: false, reason: 'name is not a string', name }
  if (typeof m['description'] !== 'string') return { valid: false, reason: 'description is not a string', name }
  if (typeof m['fullPrompt'] !== 'string') return { valid: false, reason: 'fullPrompt is not a string', name }

  const fp = m['fullPrompt'] as string

  // C4a: must mention phila (the agent's name is load-bearing for rule 1 detection)
  if (!fp.toLowerCase().includes('phila')) {
    return { valid: false, reason: 'fullPrompt does not contain "phila"', name }
  }

  // C4b: must contain json output instruction (without this the model won't know the output format)
  if (!fp.toLowerCase().includes('json')) {
    return { valid: false, reason: 'fullPrompt does not contain JSON output instruction', name }
  }

  // C4c: length bounds - too short means truncated, too long is a runaway generation
  if (fp.length < 200 || fp.length > 5000) {
    return { valid: false, reason: `fullPrompt length ${fp.length} outside 200-5000 range`, name }
  }

  // C4d: must differ from base - identical mutations provide no signal
  if (fp === basePrompt) {
    return { valid: false, reason: 'fullPrompt is identical to base prompt', name }
  }

  return {
    valid: true,
    mutation: { name: m['name'] as string, description: m['description'] as string, fullPrompt: fp },
  }
}

// -- entry point --

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '5' },
    out: { type: 'string' },
    failures: { type: 'string' },
    'base-prompt': { type: 'string' },
  },
  strict: true,
})

if (!values.out) {
  console.error(
    'Usage: node --experimental-strip-types research/gen-prompt-mutations.ts --out <path> [--count N] [--failures <path>] [--base-prompt <path>]',
  )
  process.exit(1)
}

const count = parseInt(values.count ?? '5', 10)
if (isNaN(count) || count < 1) {
  console.error('--count must be a positive integer')
  process.exit(1)
}

const basePrompt = loadBasePrompt(values['base-prompt'])
const failuresBlock = buildFailuresBlock(values.failures)

const candidatesDir = 'test/research-reports/candidates'
// mkdirSync with recursive is a no-op if the directory already exists
mkdirSync(candidatesDir, { recursive: true })

console.log(`Generating ${count} prompt mutations via claude --print...`)
const claudeOutput = callClaude(buildClaudePrompt(count, basePrompt, failuresBlock))
const raw = parseMutations(claudeOutput)

const valid: PromptMutation[] = []
const timestamp = Date.now()

for (const item of raw) {
  const result = validateMutation(item, basePrompt)
  if (!result.valid) {
    console.warn(`Discarding mutation "${result.name}": ${result.reason}`)
    continue
  }
  const idx = valid.length
  valid.push(result.mutation)

  // Write individual prompt file so each candidate can be fed directly to a benchmark run
  const candidatePath = `${candidatesDir}/mutation-${timestamp}-${idx}.txt`
  writeFileSync(candidatePath, result.mutation.fullPrompt)
  console.log(`  Written: ${candidatePath} (${result.mutation.name})`)
}

console.log(`\nValidated ${valid.length}/${raw.length} mutations (${raw.length - valid.length} discarded)`)

const output: OutputFile = {
  mutations: valid,
  basePromptLength: basePrompt.length,
  generatedAt: new Date().toISOString(),
}
writeFileSync(values.out, JSON.stringify(output, null, 2))
console.log(`Mutations written to ${values.out}`)
