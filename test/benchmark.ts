// Full sweep benchmark for phila's speak gate.
// Measures accuracy (pass rate over N runs) and latency per scenario.
//
// Usage:
//   node --experimental-strip-types test/benchmark.ts
//   node --experimental-strip-types test/benchmark.ts --runs 10 --temperature 0.3
//   node --experimental-strip-types test/benchmark.ts --sweep
//   node --experimental-strip-types test/benchmark.ts --model llama3.2:1b
//   node --experimental-strip-types test/benchmark.ts --scenarios path/to/external.json
//
// Requires PHILA_OLLAMA_URL or localhost Ollama running.

import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { buildSystemPrompt, parseDecision, buildConversation } from '../src/gate.ts'
import { evaluateHierarchical } from '../src/gate-hierarchical.ts'
import { evaluateDual } from '../src/gate-dual.ts'
import { Memory } from '../src/memory.ts'
import { extractFacts } from '../src/memory-extract.ts'
import type { GroupProfile, PhilaConfig, ConversationContext, ChatMessage } from '../src/types.ts'
import { SCENARIOS as BUILTIN_SCENARIOS, holdoutScenarios } from './scenarios.ts'
import { readFileSync } from 'node:fs'
import { confusionMatrix, formatConfusionMatrix, bootstrapCI } from './eval-shared.ts'
import type { ConfusionMatrix } from './eval-shared.ts'
import { infer } from './inference.ts'
import type { InferenceConfig } from './inference.ts'

// -- Config --

interface RunConfig extends InferenceConfig {
  label: string
  ollamaUrl: string
  runs: number
}

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    model: { type: 'string', default: 'llama3.2' },
    temperature: { type: 'string', default: '0.1' },
    'num-predict': { type: 'string', default: '64' },
    'top-p': { type: 'string', default: '0.52' },
    seed: { type: 'string' },
    gate: { type: 'string', default: 'monolithic' },
    scenarios: { type: 'string' },
    sweep: { type: 'boolean', default: false },
    'model-sweep': { type: 'boolean', default: false },
    out: { type: 'string' },
  },
})

const BASE_URL = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'

// Load external scenarios if --scenarios flag is set, otherwise use built-in
function loadScenarios() {
  if (args.scenarios) {
    const raw = readFileSync(args.scenarios, 'utf-8')
    const external = JSON.parse(raw) as Array<{ name: string; conversation: string; expect: string; category?: string; difficulty?: string; topic?: string }>
    console.log(`loaded ${external.length} external scenarios from ${args.scenarios}`)
    return external.map(s => ({
      name: s.name,
      conversation: s.conversation,
      expect: s.expect as 'silent' | 'speak',
      split: 'holdout' as const,
      category: (s.category ?? 'unknown') as any,
      difficulty: (s.difficulty ?? 'medium') as any,
      topic: s.topic,
    }))
  }
  return BUILTIN_SCENARIOS
}
const SCENARIOS = loadScenarios()

// -- Timed inference wrapper --

async function inferTimed(
  system: string,
  user: string,
  config: RunConfig,
): Promise<{ content: string; latencyMs: number }> {
  const start = performance.now()
  const content = await infer(system, user, config, config.ollamaUrl)
  return { content, latencyMs: Math.round(performance.now() - start) }
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

// Convert scenario conversation string to ChatMessage[] for hierarchical gate
function conversationToMessages(conversation: string): ChatMessage[] {
  return conversation.split('\n').map((line, i) => {
    const colonIdx = line.indexOf(':')
    const sender = colonIdx > 0 ? line.slice(0, colonIdx).trim() : `person${i + 1}`
    const text = colonIdx > 0 ? line.slice(colonIdx + 1).trim() : line.trim()
    return { sender, text, chatId: 'bench', timestamp: Date.now() - (100 - i) * 1000 }
  })
}

async function runBenchmark(config: RunConfig): Promise<ScenarioResult[]> {
  const profile: GroupProfile = { chatId: 'bench', speakBias: 0.0, updatedAt: Date.now() }
  const system = buildSystemPrompt(profile)
  const results: ScenarioResult[] = []

  for (const scenario of SCENARIOS) {
    const result: ScenarioResult = { name: scenario.name, expect: scenario.expect, passes: 0, fails: 0, errors: 0, latencies: [] }

    for (let i = 0; i < config.runs; i++) {
      try {
        const { content, latencyMs } = await inferTimed(system, scenario.conversation, config)
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

async function runHierarchicalBenchmark(config: RunConfig): Promise<ScenarioResult[]> {
  const profile: GroupProfile = { chatId: 'bench', speakBias: 0.0, updatedAt: Date.now() }
  const philaConfig: PhilaConfig = {
    model: config.model, ollamaUrl: config.ollamaUrl, batchWindowMs: 3000,
    memoryWindowSize: 50, dbPath: ':memory:', pruneAfterDays: 7, gateMode: 'hierarchical',
  }
  const ctx: ConversationContext = { correctionHint: false, messagesPerMinute: null, latestMessageHour: 14, groupNotes: null }
  const results: ScenarioResult[] = []

  for (const scenario of SCENARIOS) {
    const result: ScenarioResult = { name: scenario.name, expect: scenario.expect, passes: 0, fails: 0, errors: 0, latencies: [] }
    const messages = conversationToMessages(scenario.conversation)

    for (let i = 0; i < config.runs; i++) {
      try {
        const start = performance.now()
        const decision = await evaluateHierarchical(messages, profile, philaConfig, ctx, messages)
        const latencyMs = Math.round(performance.now() - start)
        result.latencies.push(latencyMs)

        if (decision.action === scenario.expect) {
          result.passes++
        } else {
          result.fails++
          if (i === 0) {
            process.stdout.write(`    FAIL: expected=${scenario.expect} got=${decision.action} stages=${decision.stages.join('->')}\n`)
          }
        }
      } catch (err) {
        result.errors++
        if (i === 0) process.stdout.write(`    ERROR: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }

    results.push(result)
    const rate = `${Math.round(result.passes / config.runs * 100)}%`
    const avgMs = result.latencies.length ? Math.round(avg(result.latencies)) : '-'
    process.stdout.write(`  ${pad(scenario.name, 40)} ${result.passes}/${config.runs}  ${pad(rate, 6)} ${avgMs}ms\n`)
  }

  return results
}

async function runDualBenchmark(config: RunConfig): Promise<ScenarioResult[]> {
  const profile: GroupProfile = { chatId: 'bench', speakBias: 0.0, updatedAt: Date.now() }
  const philaConfig: PhilaConfig = {
    model: config.model, ollamaUrl: config.ollamaUrl, batchWindowMs: 3000,
    memoryWindowSize: 50, dbPath: ':memory:', pruneAfterDays: 7, gateMode: 'dual',
  }
  const ctx: ConversationContext = { correctionHint: false, messagesPerMinute: null, latestMessageHour: 14, groupNotes: null }
  const mem = new Memory({ ...philaConfig, dbPath: ':memory:' })
  const results: ScenarioResult[] = []

  for (const [si, scenario] of SCENARIOS.entries()) {
    const result: ScenarioResult = { name: scenario.name, expect: scenario.expect, passes: 0, fails: 0, errors: 0, latencies: [] }
    const scenarioChatId = `bench-${si}`
    const messages = conversationToMessages(scenario.conversation).map(m => ({ ...m, chatId: scenarioChatId }))
    const scenarioProfile: GroupProfile = { chatId: scenarioChatId, speakBias: 0.0, updatedAt: Date.now() }

    // Pre-extract facts from THIS conversation only (isolated per scenario)
    try {
      const facts = await extractFacts(messages, philaConfig)
      for (const fact of facts) {
        mem.storeFact({ chatId: scenarioChatId, type: fact.type, key: fact.key, value: fact.value, messageId: 0, timestamp: Date.now() })
      }
    } catch { /* extraction failure is non-fatal */ }

    for (let i = 0; i < config.runs; i++) {
      try {
        const start = performance.now()
        const decision = await evaluateDual(messages, messages, scenarioProfile, philaConfig, ctx, mem)
        const latencyMs = Math.round(performance.now() - start)
        result.latencies.push(latencyMs)

        if (decision.action === scenario.expect) {
          result.passes++
        } else {
          result.fails++
          if (i === 0) {
            process.stdout.write(`    FAIL: expected=${scenario.expect} got=${decision.action} stages=${decision.stages.join('->')}\n`)
          }
        }
      } catch (err) {
        result.errors++
        if (i === 0) process.stdout.write(`    ERROR: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }

    results.push(result)
    const rate = `${Math.round(result.passes / config.runs * 100)}%`
    const avgMs = result.latencies.length ? Math.round(avg(result.latencies)) : '-'
    process.stdout.write(`  ${pad(scenario.name, 40)} ${result.passes}/${config.runs}  ${pad(rate, 6)} ${avgMs}ms\n`)
  }

  mem.close()
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
  const totalPasses = results.reduce((s, r) => s + r.passes, 0)
  const totalRuns = results.length * config.runs
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

function parseNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isNaN(n) ? fallback : n
}

async function main() {
  const model = args.model ?? 'llama3.2'
  const runs = Number(args.runs) || 5
  const seed = args.seed !== undefined ? Number(args.seed) : null
  const temperature = parseNum(args.temperature, 0.1)
  const numPredict = parseNum(args['num-predict'], 64)
  const topP = parseNum(args['top-p'], 0.52)

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
        temperature, numPredict, topP,
      }
      console.log(`\n--- ${m} ---`)
      const results = await runBenchmark(config)
      const s = summarize(results, config)
      console.log(`  accuracy: ${s.accuracy}% | latency: ${s.avgLat}ms avg, ${s.p50}ms p50\n`)
    }
  } else {
    const gateMode = args.gate ?? 'monolithic'
    const config: RunConfig = {
      label: 'single', model, ollamaUrl: BASE_URL, runs, seed,
      temperature, numPredict, topP,
    }

    console.log(`=== phila benchmark ===`)
    console.log(`model: ${config.model} | gate: ${gateMode} | t=${config.temperature} tp=${config.topP} np=${config.numPredict} | runs: ${config.runs}`)
    console.log()

    const results = gateMode === 'dual'
      ? await runDualBenchmark(config)
      : gateMode === 'hierarchical'
        ? await runHierarchicalBenchmark(config)
        : await runBenchmark(config)
    const s = summarize(results, config)

    // Confusion matrix from scenario results
    let tp = 0, tn = 0, fp = 0, fn = 0
    for (const r of results) {
      if (r.expect === 'speak') { tp += r.passes; fn += r.fails }
      else { tn += r.passes; fp += r.fails }
    }
    const cm = confusionMatrix({
      correctSpeak: tp, correctSilent: tn, falseSpeak: fp, falseSilent: fn,
      totalRuns: tp + tn + fp + fn,
      compositeScore: 0, gateScore: 0, responseQuality: 0, latencyScore: 0,
      avgLatencyMs: 0, perScenarioScores: [], details: [],
    })

    // Bootstrap CI on holdout scenarios
    const holdoutNames = new Set(holdoutScenarios().map(h => h.name))
    const holdoutResults = results.filter(r => holdoutNames.has(r.name))
    const holdoutScores = holdoutResults.map(r => r.passes / (r.passes + r.fails + r.errors))
    const ci = bootstrapCI(holdoutScores)

    console.log()
    console.log(formatConfusionMatrix(cm))
    console.log()
    console.log(`accuracy: ${s.accuracy}% (${s.totalPasses}/${s.totalRuns})`)
    console.log(`holdout accuracy: ${(ci.mean * 100).toFixed(1)}% [${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%] (95% CI, 10000 bootstrap)`)
    console.log(`latency: ${s.avgLat}ms avg | ${s.p50}ms p50 | ${s.p95}ms p95`)

    if (args.out) {
      writeFileSync(args.out, JSON.stringify({ config, gateMode, results, summary: s, confusionMatrix: cm, holdoutCI: ci }, null, 2))
      console.log(`results written to ${args.out}`)
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
