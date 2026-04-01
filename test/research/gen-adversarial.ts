// Generates adversarial test scenarios via claude --print, then runs them against llama3.2.
// Claude proposes novel edge cases that target gate rule ambiguity; we validate and benchmark
// them to surface failure modes that the existing scenario set doesn't cover.

import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

import { buildSystemPrompt, parseDecision } from '../../src/gate.ts'
import type { ScenarioCategory } from '../scenarios.ts'
import { infer } from '../inference.ts'
import type { InferenceConfig } from '../inference.ts'
import { GateAction } from '../../src/types.ts'

const VALID_CATEGORIES = new Set<ScenarioCategory>([
  'silent-social',
  'silent-corrected',
  'silent-rhetorical',
  'silent-logistics',
  'silent-media',
  'speak-direct',
  'speak-correction',
  'speak-unanswered',
  'adversarial',
])

interface GeneratedScenario {
  name: string
  conversation: string
  expect: 'silent' | 'speak'
  category: ScenarioCategory
}

interface ScenarioResult {
  name: string
  expect: 'silent' | 'speak'
  actual: 'silent' | 'speak'
  pass: boolean
}

interface OutputFile {
  scenarios: GeneratedScenario[]
  results: ScenarioResult[]
  failureRate: number
}

// Shown in the prompt so claude understands the exact shape required.
const REFERENCE_SCENARIO: GeneratedScenario = {
  name: 'near-miss philanthropy',
  conversation: 'person1: i want to get into philanthropy\nperson2: thats awesome what cause\nperson1: maybe education or clean water',
  expect: 'silent',
  category: 'adversarial',
}

function buildClaudePrompt(count: number, findingsPath: string | undefined): string {
  const systemPromptText = buildSystemPrompt({ chatId: 'test', speakBias: 0, updatedAt: 0 })

  let findingsBlock = ''
  if (findingsPath && existsSync(findingsPath)) {
    const contents = readFileSync(findingsPath, 'utf8')
    findingsBlock = `\nKnown failure patterns from prior research (generate harder variants of these):\n${contents}\n`
  }

  const categoryList = [...VALID_CATEGORIES].join(' | ')

  return `You are generating adversarial test scenarios for an iMessage gate LLM.

The gate uses this system prompt to decide SPEAK or SILENT:
---
${systemPromptText}
---

The 3 rules that trigger SPEAK:
1. Someone addresses phila by name
2. A factual error is present and nobody corrected it
3. A factual question went unanswered
${findingsBlock}
Your task: generate ${count} scenarios likely to cause the gate to produce the WRONG decision. Target edge cases - jokes containing false facts, phila as part of another word, opinion questions that look factual, corrections using unusual phrasing, etc.

Reference scenario (exact required JSON shape):
${JSON.stringify(REFERENCE_SCENARIO, null, 2)}

Return ONLY a JSON array. No prose, no markdown fences. Each element must have:
- name: string (short unique label)
- conversation: string (multi-line, person1/person2/etc. as speaker labels, \\n separated)
- expect: "silent" or "speak" (the correct answer)
- category: one of ${categoryList}`
}

function callClaude(prompt: string): string {
  try {
    // execFileSync passes the prompt as a direct argv element - no shell involved,
    // so there is no interpolation risk regardless of what the prompt contains.
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

function parseGeneratedScenarios(raw: string): GeneratedScenario[] {
  if (!raw.trim()) return []

  const cleaned = stripOuterFences(raw)

  // Locate the outermost JSON array in case claude prefixed with stray text.
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

  const valid: GeneratedScenario[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      console.warn('Discarding non-object scenario item:', item)
      continue
    }
    const s = item as Record<string, unknown>

    if (typeof s['name'] !== 'string') {
      console.warn('Discarding scenario: name is not a string')
      continue
    }
    if (typeof s['conversation'] !== 'string') {
      console.warn('Discarding scenario:', s['name'], '- conversation is not a string')
      continue
    }
    if (s['expect'] !== 'silent' && s['expect'] !== 'speak') {
      console.warn('Discarding scenario:', s['name'], '- invalid expect value:', s['expect'])
      continue
    }
    if (!VALID_CATEGORIES.has(s['category'] as ScenarioCategory)) {
      console.warn('Discarding scenario:', s['name'], '- invalid category:', s['category'])
      continue
    }

    valid.push({
      name: s['name'],
      conversation: s['conversation'],
      expect: s['expect'],
      category: s['category'] as ScenarioCategory,
    })
  }

  return valid
}

async function runScenarios(
  scenarios: GeneratedScenario[],
  systemPrompt: string,
  config: InferenceConfig,
  baseUrl: string,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []

  for (const scenario of scenarios) {
    let actual: 'silent' | 'speak' = 'silent'
    try {
      const raw = await infer(systemPrompt, scenario.conversation, config, baseUrl)
      const decision = parseDecision(raw)
      actual = decision.action === GateAction.SPEAK ? 'speak' : 'silent'
    } catch (e) {
      // Inference error defaults to silent - consistent with gate's own parse failure behaviour.
      console.warn('infer error for scenario:', scenario.name, '-', e instanceof Error ? e.message : e)
    }

    const pass = actual === scenario.expect
    results.push({ name: scenario.name, expect: scenario.expect, actual, pass })
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${scenario.name} (expected ${scenario.expect}, got ${actual})`)
  }

  return results
}

// -- entry point --

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '20' },
    out: { type: 'string' },
    findings: { type: 'string' },
  },
  strict: true,
})

if (!values.out) {
  console.error('Usage: node --experimental-strip-types test/research/gen-adversarial.ts --out <path> [--count N] [--findings <path>]')
  process.exit(1)
}

const count = parseInt(values.count ?? '20', 10)
if (isNaN(count) || count < 1) {
  console.error('--count must be a positive integer')
  process.exit(1)
}

const baseUrl = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'

const inferConfig: InferenceConfig = {
  model: 'llama3.2',
  temperature: 0.1,
  topP: 0.52,
  numPredict: 64,
}

console.log(`Generating ${count} adversarial scenarios via claude --print...`)
const claudeOutput = callClaude(buildClaudePrompt(count, values.findings))
const scenarios = parseGeneratedScenarios(claudeOutput)
console.log(`Validated ${scenarios.length} scenarios (${count - scenarios.length} discarded)`)

const systemPrompt = buildSystemPrompt({ chatId: 'test', speakBias: 0, updatedAt: 0 })

console.log(`Running against llama3.2 at ${baseUrl}...`)
const results = await runScenarios(scenarios, systemPrompt, inferConfig, baseUrl)

const failures = results.filter((r) => !r.pass).length
const failureRate = results.length > 0 ? failures / results.length : 0
console.log(`\n${failures}/${results.length} failures (${(failureRate * 100).toFixed(1)}%)`)

const output: OutputFile = { scenarios, results, failureRate }
writeFileSync(values.out, JSON.stringify(output, null, 2))
console.log(`Results written to ${values.out}`)
