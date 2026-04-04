// Compare all available Ollama models against the baseline prompt on train + holdout scenarios.
// Produces a markdown comparison table and per-scenario breakdown.
//
// Usage:
//   PHILA_OLLAMA_URL=http://localhost:11434 node --experimental-strip-types research/model-compare.ts
//   node --experimental-strip-types research/model-compare.ts --models llama3.2,qwen2.5:7b --runs 3

import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { buildSystemPrompt } from '../src/gate.ts'
import { evaluate } from '../test/eval-shared.ts'
import { trainScenarios, holdoutScenarios } from '../test/scenarios.ts'
import type { InferenceConfig } from '../test/inference.ts'

const { values } = parseArgs({
  options: {
    models: { type: 'string', default: 'llama3.2,qwen2.5:3b,qwen2.5:7b,gemma2:2b,phi3:mini' },
    runs: { type: 'string', default: '3' },
    out: { type: 'string' },
  },
  strict: true,
})

const baseUrl = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'
const runs = parseInt(values.runs ?? '3', 10)
const modelList = (values.models ?? 'llama3.2').split(',').map((m) => m.trim())
const outPath = values.out ?? `test/research-reports/model-compare-${Date.now()}.md`

const baselinePrompt = buildSystemPrompt({ chatId: 'benchmark', speakBias: 0, updatedAt: 0 })
const train = trainScenarios()
const holdout = holdoutScenarios()

interface ModelResult {
  model: string
  train: Awaited<ReturnType<typeof evaluate>>
  holdout: Awaited<ReturnType<typeof evaluate>>
  durationMs: number
}

console.log(`Model comparison: ${modelList.length} models, ${runs} runs each`)
console.log(`Train: ${train.length} scenarios, Holdout: ${holdout.length} scenarios`)
console.log(`Ollama: ${baseUrl}\n`)

const results: ModelResult[] = []

for (const model of modelList) {
  const config: InferenceConfig = { model, temperature: 0.1, topP: 0.52, numPredict: 64 }
  const start = Date.now()
  process.stdout.write(`Evaluating ${model}...`)

  let trainResult, holdoutResult
  try {
    trainResult = await evaluate(baselinePrompt, config, train, runs, baseUrl)
    holdoutResult = await evaluate(baselinePrompt, config, holdout, runs, baseUrl)
    const duration = Date.now() - start
    process.stdout.write(
      ` train=${trainResult.compositeScore.toFixed(4)} holdout=${holdoutResult.compositeScore.toFixed(4)} (${(duration / 1000).toFixed(0)}s)\n`,
    )
    results.push({ model, train: trainResult, holdout: holdoutResult, durationMs: duration })
  } catch (e) {
    process.stdout.write(` ERROR: ${e instanceof Error ? e.message : e}\n`)
  }
}

// -- Report --

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`
}
function fmt(n: number) {
  return n.toFixed(4)
}

const sorted = [...results].sort((a, b) => b.train.compositeScore - a.train.compositeScore)
const baseline = sorted[0]

const lines: string[] = []

lines.push(`# Model Comparison Report`)
lines.push(`Generated: ${new Date().toISOString()}`)
lines.push(`Baseline prompt: gate.ts buildSystemPrompt()`)
lines.push(`Runs per scenario: ${runs}`)
lines.push(``)

// Summary table
lines.push(`## Summary`)
lines.push(``)
lines.push(
  `| Model | Train composite | Holdout composite | Gate (train) | Quality (train) | Silent% | Speak% | Duration |`,
)
lines.push(
  `|-------|----------------|------------------|-------------|----------------|---------|--------|----------|`,
)
for (const r of sorted) {
  const delta =
    r.model === baseline.model
      ? '(best)'
      : `${r.train.compositeScore < baseline.train.compositeScore ? '' : '+'}${fmt(r.train.compositeScore - baseline.train.compositeScore)}`
  const silentAcc =
    r.train.correctSilent / Math.max(1, r.train.correctSilent + r.train.falseSpeak)
  const speakAcc =
    r.train.correctSpeak / Math.max(1, r.train.correctSpeak + r.train.falseSilent)
  lines.push(
    `| ${r.model} | ${fmt(r.train.compositeScore)} ${delta} | ${fmt(r.holdout.compositeScore)} | ${fmt(r.train.gateScore)} | ${fmt(r.train.responseQuality)} | ${pct(silentAcc)} | ${pct(speakAcc)} | ${(r.durationMs / 1000).toFixed(0)}s |`,
  )
}
lines.push(``)

// Detailed per-metric breakdown
lines.push(`## Detailed Metrics`)
lines.push(``)
lines.push(`| Model | Composite | Gate | Quality | Latency | Avg Latency | Correct Silent | Correct Speak | False Speak | False Silent |`)
lines.push(`|-------|-----------|------|---------|---------|-------------|----------------|---------------|-------------|--------------|`)
for (const r of sorted) {
  lines.push(
    `| ${r.model} | ${fmt(r.train.compositeScore)} | ${fmt(r.train.gateScore)} | ${fmt(r.train.responseQuality)} | ${fmt(r.train.latencyScore)} | ${r.train.avgLatencyMs.toFixed(0)}ms | ${r.train.correctSilent} | ${r.train.correctSpeak} | ${r.train.falseSpeak} | ${r.train.falseSilent} |`,
  )
}
lines.push(``)

// Train vs holdout gap (potential overfitting signal)
lines.push(`## Train/Holdout Gap`)
lines.push(``)
lines.push(`| Model | Train | Holdout | Gap |`)
lines.push(`|-------|-------|---------|-----|`)
for (const r of sorted) {
  const gap = r.train.compositeScore - r.holdout.compositeScore
  lines.push(
    `| ${r.model} | ${fmt(r.train.compositeScore)} | ${fmt(r.holdout.compositeScore)} | ${gap >= 0 ? '+' : ''}${fmt(gap)} |`,
  )
}
lines.push(``)

// Winner analysis
lines.push(`## Winner Analysis`)
lines.push(``)
lines.push(`**Best train:** ${baseline.model} (${fmt(baseline.train.compositeScore)})`)
const bestHoldout = [...results].sort(
  (a, b) => b.holdout.compositeScore - a.holdout.compositeScore,
)[0]
lines.push(`**Best holdout:** ${bestHoldout.model} (${fmt(bestHoldout.holdout.compositeScore)})`)
lines.push(``)
if (baseline.model !== bestHoldout.model) {
  lines.push(
    `> Train and holdout winners differ - check for overfitting to the train scenario distribution.`,
  )
  lines.push(``)
}

const report = lines.join('\n')
writeFileSync(outPath, report)
console.log(`\nReport written to ${outPath}`)
