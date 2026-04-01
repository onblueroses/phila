// Targeted investigation of the "unanswered buried in thread" weakness (score ~0.099).
// Tests multiple models and prompt variations against 30 generated buried-thread scenarios.
// Goal: determine if this is a model capability limit or a prompt-fixable issue.
//
// Usage:
//   PHILA_OLLAMA_URL=http://localhost:11434 node --experimental-strip-types test/research/buried-thread-probe.ts

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { buildSystemPrompt } from '../../src/gate.ts'
import { scoreResponse } from '../scorer.ts'
import { parseDecision } from '../../src/gate.ts'
import { infer } from '../inference.ts'
import type { InferenceConfig } from '../inference.ts'

const baseUrl = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'
const RUNS = 5
const OUT = `test/research-reports/buried-thread-probe-${Date.now()}.md`

// -- Models to test --
const MODELS = ['llama3.2', 'qwen2.5:3b', 'qwen2.5:7b', 'gemma2:2b', 'phi3:mini']

// -- Prompt variants targeting the buried-thread weakness --
const basePrompt = buildSystemPrompt({ chatId: 'benchmark', speakBias: 0, updatedAt: 0 })

const PROMPT_VARIANTS: Record<string, string> = {
  baseline: basePrompt,
  'explicit-scan': basePrompt.replace(
    /(\nRULE 3[^]*?)(\n\nRespond)/,
    '$1\nIMPORTANT: Scan the ENTIRE conversation for unanswered questions, even if later messages changed topic.$2',
  ),
  'buried-example': basePrompt.replace(
    /(\nRULE 3[^]*?)(\n\nRespond)/,
    '$1\nExample: if someone asks a fact question in the middle of a conversation and later messages are off-topic, the question is still unanswered.$2',
  ),
  'speak-bias': basePrompt.replace(
    /(\nRULE 3[^]*?)(\n\nRespond)/,
    '$1\nWhen in doubt about whether a question was answered, prefer to speak.$2',
  ),
}

// -- Generate buried-thread scenarios via claude --print --
function generateScenarios(count: number): Array<{ conversation: string; topic: string }> {
  console.log(`Generating ${count} buried-thread scenarios via claude --print...`)
  const prompt = `Generate ${count} iMessage group chat conversations where:
1. Someone asks a trivia/factual question in the middle of the conversation
2. The conversation continues with off-topic messages AFTER the question
3. The question is never answered
4. The question is about something phila (the AI) would know

Return a JSON array of objects with "conversation" (string, use person1/person2/person3) and "topic" (the correct answer in 1-3 words).

Examples of question topics: capital cities, scientific facts, historical dates, record holders, unit conversions.

Return ONLY the JSON array, no markdown fences.`

  try {
    const out = execFileSync('claude', ['--print', prompt], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CLAUDECODE: '' },
    })
    const cleaned = out
      .split('\n')
      .filter((l, i, arr) => {
        if (i === 0 && l.startsWith('```')) return false
        if (i === arr.length - 1 && l.startsWith('```')) return false
        return true
      })
      .join('\n')
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) throw new Error('Not an array')
    return parsed.filter(
      (s) =>
        typeof s === 'object' &&
        typeof s.conversation === 'string' &&
        typeof s.topic === 'string',
    )
  } catch (e) {
    console.error('Generation failed:', e instanceof Error ? e.message : e)
    return []
  }
}

// -- Evaluate a single scenario against a model + prompt --
async function evalOne(
  conversation: string,
  prompt: string,
  model: string,
): Promise<{ pass: boolean; score: number }> {
  const config: InferenceConfig = { model, temperature: 0.1, topP: 0.52, numPredict: 64 }
  let passes = 0
  let totalScore = 0

  for (let i = 0; i < RUNS; i++) {
    try {
      const response = await infer(prompt, conversation, config, baseUrl)
      const decision = parseDecision(response)
      const pass = decision === 'speak'
      passes += pass ? 1 : 0
      const scenarioForScoring = {
        name: 'probe',
        conversation,
        expect: 'speak' as const,
        split: 'train' as const,
        category: 'speak-unanswered' as const,
        difficulty: 'hard' as const,
      }
      const score = scoreResponse(response, scenarioForScoring)
      totalScore += score.composite
    } catch {
      // count as fail
    }
  }

  return { pass: passes >= Math.ceil(RUNS / 2), score: totalScore / RUNS }
}

// -- Main --

const scenarios = generateScenarios(30)
console.log(`Got ${scenarios.length} scenarios\n`)

if (scenarios.length === 0) {
  console.error('No scenarios generated - exiting')
  process.exit(1)
}

// Results matrix: scenario -> model -> variant -> {pass, score}
interface ProbeResult {
  model: string
  variant: string
  passes: number
  avgScore: number
}

const scenarioResults: Array<{
  conversation: string
  topic: string
  results: ProbeResult[]
}> = []

// For each model + variant, batch-evaluate all scenarios
for (const model of MODELS) {
  for (const [variantName, prompt] of Object.entries(PROMPT_VARIANTS)) {
    process.stdout.write(`  ${model} / ${variantName}... `)
    let totalPasses = 0
    let totalScore = 0

    for (let si = 0; si < scenarios.length; si++) {
      const s = scenarios[si]!
      const r = await evalOne(s.conversation, prompt, model)
      totalPasses += r.pass ? 1 : 0
      totalScore += r.score

      // Store result in scenarioResults
      if (!scenarioResults[si]) {
        scenarioResults[si] = { conversation: s.conversation, topic: s.topic, results: [] }
      }
      scenarioResults[si]!.results.push({
        model,
        variant: variantName,
        passes: r.pass ? 1 : 0,
        avgScore: r.score,
      })
    }

    const passRate = totalPasses / scenarios.length
    process.stdout.write(`${(passRate * 100).toFixed(0)}% pass (avg score ${(totalScore / scenarios.length).toFixed(3)})\n`)
  }
}

// -- Build report --
const lines: string[] = []
lines.push(`# Buried Thread Probe Report`)
lines.push(`Generated: ${new Date().toISOString()}`)
lines.push(`Scenarios: ${scenarios.length} generated, ${RUNS} runs each`)
lines.push(``)

// Summary matrix: model rows, variant columns
lines.push(`## Pass Rate Matrix (% scenarios where model correctly spoke)`)
lines.push(``)
const variantNames = Object.keys(PROMPT_VARIANTS)
lines.push(`| Model | ${variantNames.join(' | ')} |`)
lines.push(`|-------|${variantNames.map(() => '------').join('|')}|`)

for (const model of MODELS) {
  const cells = variantNames.map((v) => {
    const allResults = scenarioResults.flatMap((s) =>
      s.results.filter((r) => r.model === model && r.variant === v),
    )
    const passRate = allResults.reduce((sum, r) => sum + r.passes, 0) / allResults.length
    return `${(passRate * 100).toFixed(1)}%`
  })
  lines.push(`| ${model} | ${cells.join(' | ')} |`)
}
lines.push(``)

// Score matrix
lines.push(`## Avg Score Matrix`)
lines.push(``)
lines.push(`| Model | ${variantNames.join(' | ')} |`)
lines.push(`|-------|${variantNames.map(() => '------').join('|')}|`)

for (const model of MODELS) {
  const cells = variantNames.map((v) => {
    const allResults = scenarioResults.flatMap((s) =>
      s.results.filter((r) => r.model === model && r.variant === v),
    )
    const avgScore = allResults.reduce((sum, r) => sum + r.avgScore, 0) / allResults.length
    return avgScore.toFixed(4)
  })
  lines.push(`| ${model} | ${cells.join(' | ')} |`)
}
lines.push(``)

// Best combination
lines.push(`## Best Combination`)
lines.push(``)
let bestPass = 0
let bestModel = ''
let bestVariant = ''
for (const model of MODELS) {
  for (const v of variantNames) {
    const allResults = scenarioResults.flatMap((s) =>
      s.results.filter((r) => r.model === model && r.variant === v),
    )
    const passRate = allResults.reduce((sum, r) => sum + r.passes, 0) / allResults.length
    if (passRate > bestPass) {
      bestPass = passRate
      bestModel = model
      bestVariant = v
    }
  }
}
lines.push(`**Best:** ${bestModel} + ${bestVariant} = ${(bestPass * 100).toFixed(1)}% pass rate`)
lines.push(``)

const baselinePass = scenarioResults
  .flatMap((s) => s.results.filter((r) => r.model === 'llama3.2' && r.variant === 'baseline'))
  .reduce((sum, r) => sum + r.passes, 0) / scenarios.length
lines.push(`**Baseline (llama3.2 + baseline prompt):** ${(baselinePass * 100).toFixed(1)}% pass rate`)
lines.push(``)
lines.push(
  `**Conclusion:** ${bestPass > baselinePass + 0.1 ? `Significant improvement found - ${bestModel} + ${bestVariant} is worth trying.` : bestPass > baselinePass + 0.05 ? `Modest improvement - likely prompt-fixable with more targeted mutations.` : `No significant improvement - this appears to be a model capability limitation.`}`,
)
lines.push(``)

// Sample failures
lines.push(`## Sample Failure Analysis (baseline prompt, all models)`)
lines.push(``)
const failures = scenarioResults
  .filter((s) =>
    s.results
      .filter((r) => r.variant === 'baseline')
      .every((r) => r.passes === 0),
  )
  .slice(0, 5)

for (const f of failures) {
  lines.push(`**Topic:** ${f.topic}`)
  lines.push(`\`\`\``)
  lines.push(f.conversation)
  lines.push(`\`\`\``)
  const modelScores = MODELS.map((m) => `${m}: FAIL`).join(', ')
  lines.push(modelScores)
  lines.push(``)
}

const report = lines.join('\n')
writeFileSync(OUT, report)
console.log(`\nReport written to ${OUT}`)
