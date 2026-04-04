// Multi-model benchmark for phila's speak gate.
// Runs all scenarios against each available Ollama model, producing a comparison report.
//
// Usage:
//   node --experimental-strip-types research/benchmark-multimodel.ts
//   node --experimental-strip-types research/benchmark-multimodel.ts --models llama3.2,phi3:mini --runs 3

import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { buildSystemPrompt, parseDecision } from '../src/gate.ts'
import { GateAction } from '../src/types.ts'
import type { GroupProfile } from '../src/types.ts'
import { SCENARIOS } from '../test/scenarios.ts'
import type { Scenario, ScenarioCategory } from '../test/scenarios.ts'
import { scoreResponse } from '../test/scorer.ts'

const { values: args } = parseArgs({
  options: {
    models: { type: 'string' },
    runs: { type: 'string', default: '3' },
    out: { type: 'string' },
  },
})

const BASE_URL = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'
const RUNS = Number(args.runs) || 3

async function getAvailableModels(): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/api/tags`)
  const data = (await res.json()) as { models: { name: string }[] }
  return data.models.map((m) => m.name)
}

async function infer(system: string, user: string, model: string): Promise<{ content: string; latencyMs: number }> {
  const start = performance.now()
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      options: { temperature: 0.1, num_predict: 64, top_p: 0.52 },
    }),
  })
  const latencyMs = Math.round(performance.now() - start)
  if (!res.ok) throw new Error(`ollama ${res.status}`)
  return { content: ((await res.json()) as { message: { content: string } }).message.content, latencyMs }
}

interface CategoryResult {
  category: ScenarioCategory
  total: number
  correct: number
  accuracy: number
}

interface ModelResult {
  name: string
  gateAccuracy: number
  responseQuality: number
  avgLatencyMs: number
  totalCorrect: number
  totalRuns: number
  falseSpeak: number
  falseSilent: number
  perCategory: CategoryResult[]
  failures: { scenario: string; expected: string; got: string; response?: string }[]
}

async function benchmarkModel(model: string, scenarios: Scenario[], runs: number, system: string): Promise<ModelResult> {
  // Warm-up inference
  try {
    await infer(system, 'person1: test', model)
  } catch { /* ignore warm-up errors */ }

  const categoryMap = new Map<ScenarioCategory, { total: number; correct: number }>()
  let totalCorrect = 0
  let falseSpeak = 0
  let falseSilent = 0
  let qualitySum = 0
  let qualityCount = 0
  let latencySum = 0
  let latencyCount = 0
  const failures: ModelResult['failures'] = []

  for (const scenario of scenarios) {
    const cat = categoryMap.get(scenario.category) ?? { total: 0, correct: 0 }
    categoryMap.set(scenario.category, cat)

    for (let r = 0; r < runs; r++) {
      cat.total++
      try {
        const { content, latencyMs } = await infer(system, scenario.conversation, model)
        latencySum += latencyMs
        latencyCount++
        const decision = parseDecision(content)

        if (decision.action === scenario.expect) {
          totalCorrect++
          cat.correct++
          if (decision.action === GateAction.SPEAK && 'response' in decision) {
            const score = scoreResponse(decision.response as string, scenario)
            qualitySum += score.composite
            qualityCount++
          }
        } else {
          if (decision.action === GateAction.SPEAK) {
            falseSpeak++
            failures.push({ scenario: scenario.name, expected: 'silent', got: 'speak', response: 'response' in decision ? decision.response as string : undefined })
          } else {
            falseSilent++
            failures.push({ scenario: scenario.name, expected: 'speak', got: 'silent' })
          }
        }
      } catch (e) {
        cat.total-- // don't count errors against accuracy
        failures.push({ scenario: scenario.name, expected: scenario.expect, got: `error: ${e instanceof Error ? e.message : e}` })
      }
    }

    const rate = cat.total ? Math.round(cat.correct / cat.total * 100) : 0
    process.stdout.write(`  [${model}] ${scenario.name.padEnd(40)} ${rate}%\n`)
  }

  const totalRuns = scenarios.length * runs
  const perCategory: CategoryResult[] = [...categoryMap.entries()].map(([category, { total, correct }]) => ({
    category,
    total,
    correct,
    accuracy: total ? Math.round(correct / total * 1000) / 10 : 0,
  }))

  return {
    name: model,
    gateAccuracy: totalRuns ? Math.round(totalCorrect / totalRuns * 1000) / 10 : 0,
    responseQuality: qualityCount ? Math.round(qualitySum / qualityCount * 1000) / 10 : 0,
    avgLatencyMs: latencyCount ? Math.round(latencySum / latencyCount) : 0,
    totalCorrect,
    totalRuns,
    falseSpeak,
    falseSilent,
    perCategory,
    failures,
  }
}

async function main() {
  const models = args.models ? args.models.split(',') : await getAvailableModels()

  const profile: GroupProfile = { chatId: 'bench', speakBias: 0.0, updatedAt: Date.now() }
  const system = buildSystemPrompt(profile)

  console.log('=== phila multi-model benchmark ===')
  console.log(`models: ${models.join(', ')}`)
  console.log(`scenarios: ${SCENARIOS.length} | runs per scenario: ${RUNS}`)
  console.log()

  const results: ModelResult[] = []

  for (const model of models) {
    console.log(`--- ${model} ---`)
    const result = await benchmarkModel(model, SCENARIOS, RUNS, system)
    results.push(result)
    console.log(`  gate: ${result.gateAccuracy}% | quality: ${result.responseQuality}% | latency: ${result.avgLatencyMs}ms`)
    console.log(`  errors: ${result.falseSpeak} false-speak, ${result.falseSilent} false-silent`)
    console.log()
  }

  // Summary table
  console.log('=== comparison ===')
  console.log(`  ${'model'.padEnd(20)} ${'gate'.padEnd(8)} ${'quality'.padEnd(10)} ${'latency'.padEnd(10)} ${'f-speak'.padEnd(8)} f-silent`)
  for (const r of results) {
    console.log(`  ${r.name.padEnd(20)} ${(r.gateAccuracy + '%').padEnd(8)} ${(r.responseQuality + '%').padEnd(10)} ${(r.avgLatencyMs + 'ms').padEnd(10)} ${String(r.falseSpeak).padEnd(8)} ${r.falseSilent}`)
  }

  // Write JSON output
  const outPath = args.out ?? `test/research-reports/multimodel-${Date.now()}.json`
  writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), models: results }, null, 2))
  console.log(`\nresults: ${outPath}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
