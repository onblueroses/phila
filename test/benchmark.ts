// Full sweep benchmark for phila's speak gate.
// Measures accuracy (pass rate over N runs) and latency per scenario.
//
// Usage:
//   node --experimental-strip-types test/benchmark.ts
//   node --experimental-strip-types test/benchmark.ts --runs 10 --temperature 0.3
//   node --experimental-strip-types test/benchmark.ts --sweep
//   node --experimental-strip-types test/benchmark.ts --model llama3.2:1b
//
// Requires PHILA_OLLAMA_URL or localhost Ollama running.

import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { buildSystemPrompt, parseDecision } from '../src/gate.ts'
import { GateAction } from '../src/types.ts'
import type { GroupProfile } from '../src/types.ts'
import { SCENARIOS } from './scenarios.ts'

// -- Config --

interface RunConfig {
  label: string
  model: string
  ollamaUrl: string
  runs: number
  temperature: number
  numPredict: number
  topP: number
  seed: number | null
}

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    model: { type: 'string', default: 'llama3.2' },
    temperature: { type: 'string', default: '0.1' },
    'num-predict': { type: 'string', default: '64' },
    'top-p': { type: 'string', default: '0.52' },
    seed: { type: 'string' },
    sweep: { type: 'boolean', default: false },
    'model-sweep': { type: 'boolean', default: false },
    out: { type: 'string' },
  },
})

const BASE_URL = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'

// -- Scenarios (from shared scenarios.ts) --

const scenarios = SCENARIOS

// -- Inference --

async function infer(
  system: string,
  user: string,
  config: RunConfig,
): Promise<{ content: string; latencyMs: number }> {
  const start = performance.now()

  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    options: {
      temperature: config.temperature,
      num_predict: config.numPredict,
      top_p: config.topP,
      ...(config.seed !== null ? { seed: config.seed } : {}),
    },
  }

  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const latencyMs = Math.round(performance.now() - start)

  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text().catch(() => '')}`)
  return { content: ((await res.json()) as { message: { content: string } }).message.content, latencyMs }
}

// -- Benchmark runner --

interface ScenarioResult {
  name: string
  expect: string
  passes: number
  fails: number
  errors: number
  latencies: number[]
}

async function runBenchmark(config: RunConfig): Promise<ScenarioResult[]> {
  const profile: GroupProfile = { chatId: 'bench', speakBias: 0.0, updatedAt: Date.now() }
  const system = buildSystemPrompt(profile)
  const results: ScenarioResult[] = []

  for (const scenario of scenarios) {
    const result: ScenarioResult = { name: scenario.name, expect: scenario.expect, passes: 0, fails: 0, errors: 0, latencies: [] }

    for (let i = 0; i < config.runs; i++) {
      try {
        const { content, latencyMs } = await infer(system, scenario.conversation, config)
        const decision = parseDecision(content)
        result.latencies.push(latencyMs)

        if (decision.action === scenario.expect) {
          result.passes++
        } else {
          result.fails++
        }
      } catch {
        result.errors++
      }
    }

    results.push(result)
    const rate = `${Math.round(result.passes / config.runs * 100)}%`
    const avgMs = result.latencies.length ? Math.round(avg(result.latencies)) : '-'
    process.stdout.write(`  ${pad(scenario.name, 40)} ${result.passes}/${config.runs}  ${pad(rate, 6)} ${avgMs}ms\n`)
  }

  return results
}

// -- Stats --

function avg(nums: number[]): number { return nums.reduce((a, b) => a + b, 0) / nums.length }
function percentile(nums: number[], p: number): number {
  const sorted = [...nums].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * p)] ?? 0
}
function pad(s: string | number, n: number): string { return String(s).padEnd(n) }

function summarize(results: ScenarioResult[], config: RunConfig) {
  const scored = results
  const totalPasses = scored.reduce((s, r) => s + r.passes, 0)
  const totalRuns = scored.length * config.runs
  const allLatencies = results.flatMap((r) => r.latencies)

  const accuracy = totalRuns ? Math.round(totalPasses / totalRuns * 1000) / 10 : 0
  const avgLat = allLatencies.length ? Math.round(avg(allLatencies)) : 0
  const p50 = allLatencies.length ? Math.round(percentile(allLatencies, 0.5)) : 0
  const p95 = allLatencies.length ? Math.round(percentile(allLatencies, 0.95)) : 0

  return { accuracy, totalPasses, totalRuns, avgLat, p50, p95 }
}

// -- Sweep configs --

const PARAM_SWEEP: Omit<RunConfig, 'model' | 'ollamaUrl' | 'runs' | 'seed'>[] = [
  { label: 'default (t=0.7)',       temperature: 0.7, numPredict: 256, topP: 0.9 },
  { label: 'low-temp (t=0.3)',      temperature: 0.3, numPredict: 256, topP: 0.9 },
  { label: 'very-low-temp (t=0.1)', temperature: 0.1, numPredict: 256, topP: 0.9 },
  { label: 'zero-temp (t=0.0)',     temperature: 0.0, numPredict: 256, topP: 1.0 },
  { label: 'high-temp (t=1.0)',     temperature: 1.0, numPredict: 256, topP: 0.9 },
  { label: 'short-output (np=64)',  temperature: 0.7, numPredict: 64,  topP: 0.9 },
  { label: 'tight-topp (tp=0.5)',   temperature: 0.7, numPredict: 256, topP: 0.5 },
  { label: 'focused (t=0.1,tp=0.5)', temperature: 0.1, numPredict: 128, topP: 0.5 },
]

// -- Main --

async function main() {
  const model = args.model ?? 'llama3.2'
  const runs = Number(args.runs) || 5
  const seed = args.seed !== undefined ? Number(args.seed) : null

  if (args.sweep) {
    console.log(`=== parameter sweep === model: ${model} | runs: ${runs}`)
    console.log()

    const sweepResults: { label: string; accuracy: number; avgLat: number; p50: number; p95: number }[] = []

    for (const params of PARAM_SWEEP) {
      const config: RunConfig = { ...params, model, ollamaUrl: BASE_URL, runs, seed }
      console.log(`--- ${params.label} ---`)
      const results = await runBenchmark(config)
      const s = summarize(results, config)
      sweepResults.push({ label: params.label, ...s })
      console.log(`  accuracy: ${s.accuracy}% (${s.totalPasses}/${s.totalRuns}) | latency: ${s.avgLat}ms avg, ${s.p50}ms p50, ${s.p95}ms p95\n`)
    }

    console.log('=== sweep summary ===')
    console.log(`  ${pad('config', 28)} ${pad('accuracy', 10)} ${pad('avg ms', 10)} ${pad('p50 ms', 10)} p95 ms`)
    for (const r of sweepResults) {
      console.log(`  ${pad(r.label, 28)} ${pad(r.accuracy + '%', 10)} ${pad(r.avgLat, 10)} ${pad(r.p50, 10)} ${r.p95}`)
    }

    if (args.out) {
      writeFileSync(args.out, JSON.stringify(sweepResults, null, 2))
      console.log(`\nresults written to ${args.out}`)
    }
  } else if (args['model-sweep']) {
    const models = ['llama3.2', 'llama3.2:1b']
    console.log(`=== model comparison === runs: ${runs}`)

    for (const m of models) {
      const config: RunConfig = {
        label: m, model: m, ollamaUrl: BASE_URL, runs, seed,
        temperature: Number(args.temperature) || 0.7,
        numPredict: Number(args['num-predict']) || 256,
        topP: Number(args['top-p']) || 0.9,
      }
      console.log(`\n--- ${m} ---`)
      const results = await runBenchmark(config)
      const s = summarize(results, config)
      console.log(`  accuracy: ${s.accuracy}% | latency: ${s.avgLat}ms avg, ${s.p50}ms p50\n`)
    }
  } else {
    const config: RunConfig = {
      label: 'single',
      model,
      ollamaUrl: BASE_URL,
      runs,
      seed,
      temperature: Number(args.temperature) || 0.7,
      numPredict: Number(args['num-predict']) || 256,
      topP: Number(args['top-p']) || 0.9,
    }

    console.log(`=== phila benchmark ===`)
    console.log(`model: ${config.model} | t=${config.temperature} tp=${config.topP} np=${config.numPredict} | runs: ${config.runs}`)
    console.log()

    const results = await runBenchmark(config)
    const s = summarize(results, config)

    console.log()
    console.log(`accuracy: ${s.accuracy}% (${s.totalPasses}/${s.totalRuns})`)
    console.log(`latency: ${s.avgLat}ms avg | ${s.p50}ms p50 | ${s.p95}ms p95`)

    if (args.out) {
      writeFileSync(args.out, JSON.stringify({ config, results, summary: s }, null, 2))
      console.log(`results written to ${args.out}`)
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
