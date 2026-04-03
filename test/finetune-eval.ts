// Evaluation script for fine-tuned model comparison.
// Runs three analyses:
//   1. Holdout-only gate accuracy (generalisation check)
//   2. Composite scoring (gate + response quality) vs baseline
//   3. Regression deep-dive (10x runs on known failing scenarios)
//
// Usage:
//   node --experimental-strip-types test/finetune-eval.ts --model phila-ft
//   node --experimental-strip-types test/finetune-eval.ts --model phila-ft --baseline llama3.2 --runs 10

import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { buildSystemPrompt, parseDecision } from '../src/gate.ts'
import type { GroupProfile } from '../src/types.ts'
import { GateAction } from '../src/types.ts'
import { holdoutScenarios, SCENARIOS } from './scenarios.ts'
import type { Scenario } from './scenarios.ts'
import { scoreResponse, compositeWeights } from './scorer.ts'
import { infer } from './inference.ts'
import type { InferenceConfig } from './inference.ts'

const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: 'phila-ft' },
    baseline: { type: 'string', default: 'llama3.2' },
    runs: { type: 'string', default: '5' },
    'regression-runs': { type: 'string', default: '10' },
    out: { type: 'string' },
  },
})

const OLLAMA_URL = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'
const RUNS = parseInt(args.runs!)
const REGRESSION_RUNS = parseInt(args['regression-runs']!)

// Scenarios with known regressions vs baseline
const REGRESSION_SCENARIOS = [
  'unanswered question',
  'unanswered history',
  'wrong fact but clearly sarcastic',
  'near-miss philo not phila',
]

async function inferOne(
  system: string,
  conversation: string,
  config: InferenceConfig,
): Promise<{ decision: GateAction | null; response: string; latencyMs: number }> {
  const start = performance.now()
  const raw = await infer(system, conversation, config, OLLAMA_URL)
  const latencyMs = Math.round(performance.now() - start)
  const parsed = parseDecision(raw)
  const decision = parsed.action as GateAction
  const response = decision === GateAction.SPEAK ? ('response' in parsed ? parsed.response : raw) : ''
  return { decision, response, latencyMs }
}

interface ScenarioSummary {
  name: string
  expect: string
  split: string
  category: string
  gatePass: number
  gateTotal: number
  compositeSum: number
  compositeCount: number
  latencies: number[]
}

async function evalScenarios(
  scenarios: Scenario[],
  model: string,
  runs: number,
): Promise<ScenarioSummary[]> {
  const config: InferenceConfig = { model, temperature: 0.1, numPredict: 64, topP: 0.52 }
  const profile: GroupProfile = { chatId: 'eval', speakBias: 0.0, updatedAt: Date.now() }
  const system = buildSystemPrompt(profile)
  const summaries: ScenarioSummary[] = []

  for (const scenario of scenarios) {
    const s: ScenarioSummary = {
      name: scenario.name,
      expect: scenario.expect,
      split: scenario.split,
      category: scenario.category,
      gatePass: 0,
      gateTotal: 0,
      compositeSum: 0,
      compositeCount: 0,
      latencies: [],
    }

    for (let i = 0; i < runs; i++) {
      const { decision, response, latencyMs } = await inferOne(system, scenario.conversation, config)
      s.gateTotal++
      s.latencies.push(latencyMs)

      const expectedAction = scenario.expect === 'silent' ? GateAction.SILENT : GateAction.SPEAK
      if (decision === expectedAction) {
        s.gatePass++
        if (decision === GateAction.SPEAK && response) {
          const score = scoreResponse(response, scenario)
          s.compositeSum += score.composite
          s.compositeCount++
        }
      }
    }

    const pct = Math.round((s.gatePass / s.gateTotal) * 100)
    const label2 = pct === 100 ? 'PASS' : pct === 0 ? 'FAIL' : `${pct}%`
    console.log(`  [${label2}] ${s.name} (${s.split}/${s.category})`)
    summaries.push(s)
  }

  return summaries
}

function printSection(title: string) {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  ${title}`)
  console.log('='.repeat(56))
}

function summarize(summaries: ScenarioSummary[]) {
  const total = summaries.reduce((n, s) => n + s.gateTotal, 0)
  const pass = summaries.reduce((n, s) => n + s.gatePass, 0)
  const acc = pass / total

  const speakOnes = summaries.filter((s) => s.compositeCount > 0)
  const avgQuality = speakOnes.length
    ? speakOnes.reduce((n, s) => n + s.compositeSum / s.compositeCount, 0) / speakOnes.length
    : null

  const allLatencies = summaries.flatMap((s) => s.latencies).sort((a, b) => a - b)
  const p50 = allLatencies[Math.floor(allLatencies.length * 0.5)]
  const p95 = allLatencies[Math.floor(allLatencies.length * 0.95)]
  const avgLat = Math.round(allLatencies.reduce((n, v) => n + v, 0) / allLatencies.length)

  const weights = compositeWeights(acc)
  const composite = acc * weights.gate + (avgQuality ?? 0) * weights.quality

  return { acc, avgQuality, avgLat, p50, p95, composite, pass, total }
}

function byCategory(summaries: ScenarioSummary[]) {
  const cats = new Map<string, { pass: number; total: number }>()
  for (const s of summaries) {
    const c = cats.get(s.category) ?? { pass: 0, total: 0 }
    c.pass += s.gatePass
    c.total += s.gateTotal
    cats.set(s.category, c)
  }
  return cats
}

// ── Main ───────────────────────────────────────────────────────────────────

const ftModel = args.model!
const baselineModel = args.baseline!

console.log(`\nPhila fine-tune eval: ${ftModel} vs ${baselineModel}`)
console.log(`Ollama: ${OLLAMA_URL}  |  runs: ${RUNS}  |  regression runs: ${REGRESSION_RUNS}`)

// ── 1. Holdout-only accuracy ───────────────────────────────────────────────
printSection(`1. HOLDOUT ACCURACY (n=${holdoutScenarios().length} scenarios × ${RUNS} runs)`)

console.log(`\n[${ftModel}]`)
const ftHoldout = await evalScenarios(holdoutScenarios(), ftModel, RUNS)

console.log(`\n[${baselineModel}]`)
const baseHoldout = await evalScenarios(holdoutScenarios(), baselineModel, RUNS)

const ftH = summarize(ftHoldout)
const baseH = summarize(baseHoldout)

console.log(`\nHoldout gate accuracy:  ${baselineModel}=${(baseH.acc * 100).toFixed(1)}%  ${ftModel}=${(ftH.acc * 100).toFixed(1)}%  delta=${((ftH.acc - baseH.acc) * 100).toFixed(1)}pp`)

// ── 2. Full composite scoring ──────────────────────────────────────────────
printSection(`2. COMPOSITE SCORING — all ${SCENARIOS.length} scenarios × ${RUNS} runs`)

console.log(`\n[${ftModel}]`)
const ftAll = await evalScenarios(SCENARIOS, ftModel, RUNS)

console.log(`\n[${baselineModel}]`)
const baseAll = await evalScenarios(SCENARIOS, baselineModel, RUNS)

const ftA = summarize(ftAll)
const baseA = summarize(baseAll)

console.log('\nFull composite:')
console.log(`  ${baselineModel.padEnd(16)} gate=${(baseA.acc * 100).toFixed(1)}%  quality=${(baseA.avgQuality ?? 0).toFixed(3)}  composite=${baseA.composite.toFixed(4)}  lat=${baseA.avgLat}ms p50=${baseA.p50}ms`)
console.log(`  ${ftModel.padEnd(16)} gate=${(ftA.acc * 100).toFixed(1)}%  quality=${(ftA.avgQuality ?? 0).toFixed(3)}  composite=${ftA.composite.toFixed(4)}  lat=${ftA.avgLat}ms p50=${ftA.p50}ms`)

console.log('\nPer-category (gate accuracy):')
const ftCats = byCategory(ftAll)
const baseCats = byCategory(baseAll)
for (const [cat, base] of baseCats) {
  const ft = ftCats.get(cat) ?? { pass: 0, total: 1 }
  const basePct = (base.pass / base.total * 100).toFixed(0)
  const ftPct = (ft.pass / ft.total * 100).toFixed(0)
  const delta = ft.pass / ft.total - base.pass / base.total
  const marker = Math.abs(delta) >= 0.05 ? (delta > 0 ? ' ▲' : ' ▼') : ''
  console.log(`  ${cat.padEnd(30)} baseline=${basePct.padStart(3)}%  ft=${ftPct.padStart(3)}%${marker}`)
}

// ── 3. Regression deep-dive ────────────────────────────────────────────────
printSection(`3. REGRESSION DEEP-DIVE (${REGRESSION_RUNS} runs each)`)

const regressionSet = SCENARIOS.filter((s) => REGRESSION_SCENARIOS.includes(s.name))
console.log(`\nRunning ${regressionSet.length} scenarios × ${REGRESSION_RUNS} runs on ${ftModel} and ${baselineModel}`)

console.log(`\n[${ftModel}]`)
const ftReg = await evalScenarios(regressionSet, ftModel, REGRESSION_RUNS)

console.log(`\n[${baselineModel}]`)
const baseReg = await evalScenarios(regressionSet, baselineModel, REGRESSION_RUNS)

console.log('\nRegression scenario detail:')
for (const s of ftReg) {
  const base = baseReg.find((b) => b.name === s.name)!
  const ftPct = Math.round(s.gatePass / s.gateTotal * 100)
  const basePct = Math.round(base.gatePass / base.gateTotal * 100)
  const delta = ftPct - basePct
  const marker = delta > 0 ? '▲' : delta < 0 ? '▼' : '='
  console.log(`  ${marker} ${s.name}: baseline=${basePct}%  ft=${ftPct}%  (${REGRESSION_RUNS} runs)`)
}

// ── Output ─────────────────────────────────────────────────────────────────
const report = {
  timestamp: new Date().toISOString(),
  model: ftModel,
  baseline: baselineModel,
  runs: RUNS,
  regressionRuns: REGRESSION_RUNS,
  holdout: { ft: ftH, base: baseH },
  full: { ft: ftA, base: baseA },
  regressions: ftReg.map((s, i) => ({ ...s, baselineGatePass: baseReg[i].gatePass, baselineGateTotal: baseReg[i].gateTotal })),
}

const outPath = args.out ?? `test/research-reports/finetune-eval-${Date.now()}.json`
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`\nReport written to ${outPath}`)
