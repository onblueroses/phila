// Autonomous optimization loop for phila's speak gate.
// Runs on VPS where Ollama lives. Tests prompt variants, inference params, and models.
// Keeps improvements, discards regressions.
//
// Usage:
//   node --experimental-strip-types test/autooptimize.ts
//   node --experimental-strip-types test/autooptimize.ts --iterations 20
//   node --experimental-strip-types test/autooptimize.ts --dimension prompt
//   node --experimental-strip-types test/autooptimize.ts --dimension params
//   node --experimental-strip-types test/autooptimize.ts --dimension models

import { parseArgs } from 'node:util'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { buildSystemPrompt, parseDecision } from '../src/gate.ts'
import { GateAction } from '../src/types.ts'
import type { GroupProfile } from '../src/types.ts'

// -- CLI --

const { values: args } = parseArgs({
  options: {
    iterations: { type: 'string', default: '10' },
    dimension: { type: 'string', default: 'all' },
    runs: { type: 'string', default: '3' },
    out: { type: 'string', default: 'test/optimize-results.json' },
  },
})

const BASE_URL = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'
const RUNS = Number(args.runs) || 3
const ITERATIONS = Number(args.iterations) || 10

// -- Scenarios (same as benchmark.ts) --

interface Scenario {
  name: string
  conversation: string
  expect: 'silent' | 'speak' | 'either'
}

const scenarios: Scenario[] = [
  { name: 'small talk', conversation: 'person1: hey whats up\nperson2: not much, you?\nperson1: same lol', expect: 'silent' },
  { name: 'direct question', conversation: 'person1: phila what year did the moon landing happen?', expect: 'speak' },
  { name: 'emotional', conversation: 'person1: i just got fired from my job\nperson2: oh no im so sorry\nperson3: that sucks, are you ok?', expect: 'silent' },
  { name: 'factual error', conversation: 'person1: the eiffel tower is in london right?\nperson2: yeah i think so', expect: 'speak' },
  { name: 'jokes', conversation: 'person1: why did the chicken cross the road\nperson2: why\nperson1: to get to the other side lmao\nperson2: bruh', expect: 'silent' },
  { name: 'unanswered question', conversation: 'person1: whats the tallest mountain in the world?\nperson2: idk', expect: 'speak' },
  { name: 'opinions', conversation: 'person1: i think pineapple on pizza is amazing\nperson2: no way thats disgusting\nperson3: i agree with person1 its great', expect: 'silent' },
  { name: 'already answered', conversation: 'person1: what is the capital of france?\nperson2: paris', expect: 'silent' },
  { name: 'planning', conversation: 'person1: should we meet at 7 or 8?\nperson2: lets do 7:30\nperson3: works for me', expect: 'silent' },
  { name: 'phila greeting', conversation: 'person1: hey phila, how are you?', expect: 'speak' },
  { name: 'wrong date', conversation: 'person1: world war 2 ended in 1943\nperson2: yeah around then', expect: 'speak' },
  { name: 'celebrating', conversation: 'person1: I GOT THE JOB!!!\nperson2: LETS GOOOO congrats!!\nperson3: so happy for you!!', expect: 'silent' },
  { name: 'gossip', conversation: 'person1: did you hear about jake and sarah\nperson2: no what happened\nperson1: they broke up last week\nperson2: no way i had no idea', expect: 'silent' },
]

// -- Inference --

interface InferenceConfig {
  model: string
  temperature: number
  numPredict: number
  topP: number
}

async function infer(system: string, user: string, config: InferenceConfig): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      options: { temperature: config.temperature, num_predict: config.numPredict, top_p: config.topP },
    }),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}`)
  return ((await res.json()) as { message: { content: string } }).message.content
}

// -- Evaluation --

interface EvalResult {
  accuracy: number
  totalPasses: number
  totalRuns: number
  avgLatencyMs: number
  failures: string[]
}

async function evaluate(systemPrompt: string, config: InferenceConfig, runs: number): Promise<EvalResult> {
  let passes = 0
  let total = 0
  let latencySum = 0
  let latencyCount = 0
  const failures: string[] = []

  for (const scenario of scenarios) {
    if (scenario.expect === 'either') continue
    for (let r = 0; r < runs; r++) {
      const start = performance.now()
      try {
        const raw = await infer(systemPrompt, scenario.conversation, config)
        const decision = parseDecision(raw)
        latencySum += performance.now() - start
        latencyCount++

        if (decision.action === scenario.expect) {
          passes++
        } else {
          failures.push(`${scenario.name}: expected ${scenario.expect}, got ${decision.action}`)
        }
      } catch {
        failures.push(`${scenario.name}: inference error`)
      }
      total++
    }
  }

  return {
    accuracy: total ? passes / total : 0,
    totalPasses: passes,
    totalRuns: total,
    avgLatencyMs: latencyCount ? Math.round(latencySum / latencyCount) : 0,
    failures,
  }
}

// -- Prompt Variants --

function generatePromptVariants(basePrompt: string): string[] {
  const variants: string[] = []

  // Variant: add more few-shot examples
  variants.push(basePrompt.replace(
    'correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}',
    `correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

EXAMPLE of rule 1 - you must speak here:
person1: hey phila, whats the tallest mountain?
correct response: {"action":"speak","reason":"direct question","response":"mount everest, about 8849 meters"}

EXAMPLE of staying silent:
person1: i had such a bad day
person2: oh no what happened
correct response: {"action":"silent"}`,
  ))

  // Variant: stricter silence framing
  variants.push(basePrompt.replace(
    'your default is silence - you only speak when it matters.',
    'your default is ABSOLUTE silence. you almost never speak. the bar for speaking is extremely high.',
  ))

  // Variant: numbered priority with weights
  variants.push(basePrompt.replace(
    'ALWAYS SPEAK (these override silence):',
    'RULES (in order of priority, 1 is highest):',
  ).replace(
    'STAY SILENT for everything else:',
    'ALL OTHER CASES -> {"action":"silent"}:',
  ))

  // Variant: shorter prompt (fewer silent examples)
  variants.push(basePrompt.replace(
    `- greetings and small talk
- emotions (venting, celebrating, grieving)
- jokes and banter
- opinions and preferences
- someone already answered correctly`,
    '- everything that is not rules 1 or 2 above',
  ))

  // Variant: explicit "phila" trigger emphasis
  variants.push(basePrompt.replace(
    '1. someone says "phila" and asks you something -> answer it',
    '1. someone mentions your name "phila" in ANY way (greeting, question, request) -> respond to them',
  ))

  return variants
}

// -- Param Variants --

function generateParamVariants(base: InferenceConfig): InferenceConfig[] {
  return [
    { ...base, temperature: 0.05 },
    { ...base, temperature: 0.0 },
    { ...base, temperature: 0.2, topP: 0.7 },
    { ...base, numPredict: 64 },
    { ...base, numPredict: 192 },
    { ...base, temperature: 0.05, topP: 0.3 },
    { ...base, temperature: 0.15, numPredict: 96, topP: 0.6 },
  ]
}

// -- Model Variants --

async function getAvailableModels(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE_URL}/api/tags`)
    const data = (await res.json()) as { models: { name: string }[] }
    return data.models.map((m) => m.name)
  } catch {
    return ['llama3.2']
  }
}

// -- Main Loop --

interface TrialResult {
  iteration: number
  dimension: string
  label: string
  accuracy: number
  avgLatencyMs: number
  improvement: boolean
  failures: string[]
}

async function main() {
  const dimension = args.dimension ?? 'all'
  const profile: GroupProfile = { chatId: 'bench', speakBias: 0.0, updatedAt: Date.now() }
  const basePrompt = buildSystemPrompt(profile)
  const baseConfig: InferenceConfig = { model: 'llama3.2', temperature: 0.1, numPredict: 128, topP: 0.5 }

  console.log(`=== phila autooptimize ===`)
  console.log(`dimension: ${dimension} | runs per eval: ${RUNS} | max iterations: ${ITERATIONS}`)
  console.log()

  // Establish baseline
  console.log('--- baseline ---')
  const baseline = await evaluate(basePrompt, baseConfig, RUNS)
  console.log(`  accuracy: ${(baseline.accuracy * 100).toFixed(1)}% | latency: ${baseline.avgLatencyMs}ms`)
  if (baseline.failures.length) console.log(`  failures: ${baseline.failures.slice(0, 5).join(', ')}`)
  console.log()

  let bestAccuracy = baseline.accuracy
  let bestLatency = baseline.avgLatencyMs
  let bestPrompt = basePrompt
  let bestConfig = baseConfig
  const results: TrialResult[] = []
  let iteration = 0

  // Prompt optimization
  if (dimension === 'all' || dimension === 'prompt') {
    const variants = generatePromptVariants(bestPrompt)
    for (const variant of variants) {
      if (iteration >= ITERATIONS) break
      iteration++
      const label = `prompt-v${iteration}`
      console.log(`--- ${label} ---`)
      const result = await evaluate(variant, bestConfig, RUNS)
      const improved = result.accuracy > bestAccuracy || (result.accuracy === bestAccuracy && result.avgLatencyMs < bestLatency)

      console.log(`  accuracy: ${(result.accuracy * 100).toFixed(1)}% | latency: ${result.avgLatencyMs}ms | ${improved ? 'KEEP' : 'discard'}`)
      if (result.failures.length) console.log(`  failures: ${result.failures.slice(0, 3).join(', ')}`)

      if (improved) {
        bestAccuracy = result.accuracy
        bestLatency = result.avgLatencyMs
        bestPrompt = variant
      }
      results.push({ iteration, dimension: 'prompt', label, accuracy: result.accuracy, avgLatencyMs: result.avgLatencyMs, improvement: improved, failures: result.failures })
    }
  }

  // Param optimization
  if (dimension === 'all' || dimension === 'params') {
    const variants = generateParamVariants(bestConfig)
    for (const variant of variants) {
      if (iteration >= ITERATIONS) break
      iteration++
      const label = `params-t${variant.temperature}-tp${variant.topP}-np${variant.numPredict}`
      console.log(`--- ${label} ---`)
      const result = await evaluate(bestPrompt, variant, RUNS)
      const improved = result.accuracy > bestAccuracy || (result.accuracy === bestAccuracy && result.avgLatencyMs < bestLatency)

      console.log(`  accuracy: ${(result.accuracy * 100).toFixed(1)}% | latency: ${result.avgLatencyMs}ms | ${improved ? 'KEEP' : 'discard'}`)

      if (improved) {
        bestAccuracy = result.accuracy
        bestLatency = result.avgLatencyMs
        bestConfig = variant
      }
      results.push({ iteration, dimension: 'params', label, accuracy: result.accuracy, avgLatencyMs: result.avgLatencyMs, improvement: improved, failures: result.failures })
    }
  }

  // Model optimization
  if (dimension === 'all' || dimension === 'models') {
    const models = await getAvailableModels()
    for (const model of models) {
      if (model === bestConfig.model) continue
      if (iteration >= ITERATIONS) break
      iteration++
      const variant = { ...bestConfig, model }
      const label = `model-${model}`
      console.log(`--- ${label} ---`)
      const result = await evaluate(bestPrompt, variant, RUNS)
      const improved = result.accuracy > bestAccuracy || (result.accuracy === bestAccuracy && result.avgLatencyMs < bestLatency)

      console.log(`  accuracy: ${(result.accuracy * 100).toFixed(1)}% | latency: ${result.avgLatencyMs}ms | ${improved ? 'KEEP' : 'discard'}`)

      if (improved) {
        bestAccuracy = result.accuracy
        bestLatency = result.avgLatencyMs
        bestConfig = variant
      }
      results.push({ iteration, dimension: 'models', label, accuracy: result.accuracy, avgLatencyMs: result.avgLatencyMs, improvement: improved, failures: result.failures })
    }
  }

  // Summary
  console.log()
  console.log('=== summary ===')
  console.log(`baseline: ${(baseline.accuracy * 100).toFixed(1)}% accuracy, ${baseline.avgLatencyMs}ms`)
  console.log(`best:     ${(bestAccuracy * 100).toFixed(1)}% accuracy, ${bestLatency}ms`)
  console.log(`model:    ${bestConfig.model} | t=${bestConfig.temperature} tp=${bestConfig.topP} np=${bestConfig.numPredict}`)
  console.log(`improvements: ${results.filter((r) => r.improvement).length}/${results.length} trials`)

  if (bestPrompt !== basePrompt) {
    console.log()
    console.log('best prompt differs from current - review and apply manually')
    writeFileSync('test/best-prompt.txt', bestPrompt)
    console.log('saved to test/best-prompt.txt')
  }

  const output = { baseline: { accuracy: baseline.accuracy, latency: baseline.avgLatencyMs }, best: { accuracy: bestAccuracy, latency: bestLatency, config: bestConfig }, trials: results }
  writeFileSync(args.out!, JSON.stringify(output, null, 2))
  console.log(`full results: ${args.out}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
