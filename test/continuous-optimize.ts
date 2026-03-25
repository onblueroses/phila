// Continuous optimization loop for phila's speak gate.
// Runs indefinitely on VPS, generating mutations, testing them, keeping improvements.
// Designed for overnight/multi-day runs. Graceful shutdown on SIGINT/SIGTERM.
//
// Scoring: composite of weighted gate accuracy (3:1 silence bias),
// response quality heuristics, and latency.
//
// Usage:
//   node --experimental-strip-types test/continuous-optimize.ts
//   node --experimental-strip-types test/continuous-optimize.ts --runs 5
//   node --experimental-strip-types test/continuous-optimize.ts --checkpoint test/checkpoint.json

import { parseArgs } from 'node:util'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { buildSystemPrompt, parseDecision } from '../src/gate.ts'
import { constrain } from '../src/voice.ts'
import { GateAction } from '../src/types.ts'
import type { GroupProfile } from '../src/types.ts'

// -- CLI --

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    checkpoint: { type: 'string', default: 'test/checkpoint.json' },
  },
})

const BASE_URL = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'
const RUNS = Number(args.runs) || 5
const CHECKPOINT_PATH = args.checkpoint!

// -- Scenarios --

interface Scenario {
  name: string
  conversation: string
  expect: 'silent' | 'speak'
  // For speak scenarios: what the response should address
  topic?: string
}

const scenarios: Scenario[] = [
  // SILENT scenarios (false speak = 3x penalty)
  { name: 'small talk', conversation: 'person1: hey whats up\nperson2: not much, you?\nperson1: same lol', expect: 'silent' },
  { name: 'emotional', conversation: 'person1: i just got fired from my job\nperson2: oh no im so sorry\nperson3: that sucks, are you ok?', expect: 'silent' },
  { name: 'jokes', conversation: 'person1: why did the chicken cross the road\nperson2: why\nperson1: to get to the other side lmao\nperson2: bruh', expect: 'silent' },
  { name: 'opinions', conversation: 'person1: i think pineapple on pizza is amazing\nperson2: no way thats disgusting\nperson3: i agree with person1 its great', expect: 'silent' },
  { name: 'already answered', conversation: 'person1: what is the capital of france?\nperson2: paris', expect: 'silent' },
  { name: 'planning', conversation: 'person1: should we meet at 7 or 8?\nperson2: lets do 7:30\nperson3: works for me', expect: 'silent' },
  { name: 'celebrating', conversation: 'person1: I GOT THE JOB!!!\nperson2: LETS GOOOO congrats!!\nperson3: so happy for you!!', expect: 'silent' },
  { name: 'gossip', conversation: 'person1: did you hear about jake and sarah\nperson2: no what happened\nperson1: they broke up last week\nperson2: no way i had no idea', expect: 'silent' },
  { name: 'venting', conversation: 'person1: this professor is the worst\nperson2: what happened\nperson1: gave us a 20 page paper due monday\nperson2: thats insane', expect: 'silent' },
  { name: 'music opinions', conversation: 'person1: new kendrick album is fire\nperson2: eh i prefer drake\nperson3: both mid honestly', expect: 'silent' },
  { name: 'making plans', conversation: 'person1: wanna grab dinner tonight?\nperson2: sure where\nperson1: that thai place on main?\nperson2: perfect see you at 7', expect: 'silent' },
  { name: 'sharing memes', conversation: 'person1: lmao look at this\nperson2: DEAD 💀\nperson3: im crying', expect: 'silent' },
  { name: 'complaining weather', conversation: 'person1: its so cold today\nperson2: i know right\nperson1: i hate winter', expect: 'silent' },
  // Adversarial: questions that are rhetorical or already handled
  { name: 'rhetorical question', conversation: 'person1: why does this always happen to me\nperson2: i feel you\nperson1: like seriously why', expect: 'silent' },
  { name: 'self-answered', conversation: 'person1: wait what year was that?\nperson1: oh nvm it was 2019', expect: 'silent' },

  // SPEAK scenarios (false silent = 1x penalty)
  { name: 'direct question', conversation: 'person1: phila what year did the moon landing happen?', expect: 'speak', topic: '1969' },
  { name: 'factual error', conversation: 'person1: the eiffel tower is in london right?\nperson2: yeah i think so', expect: 'speak', topic: 'paris' },
  { name: 'phila greeting', conversation: 'person1: hey phila, how are you?', expect: 'speak', topic: 'greeting' },
  { name: 'wrong date', conversation: 'person1: world war 2 ended in 1943\nperson2: yeah around then', expect: 'speak', topic: '1945' },
  { name: 'phila asked opinion', conversation: 'person1: phila whats a good movie to watch tonight?', expect: 'speak', topic: 'movie' },
  { name: 'wrong geography', conversation: 'person1: tokyo is the capital of china right\nperson2: pretty sure yeah', expect: 'speak', topic: 'japan' },
  { name: 'unanswered question', conversation: 'person1: whats the tallest mountain in the world?\nperson2: idk\nperson3: no clue', expect: 'speak', topic: 'everest' },
  { name: 'phila help request', conversation: 'person1: phila can you settle something for us - is a hotdog a sandwich?', expect: 'speak', topic: 'hotdog' },
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

// -- Response Quality --

const AI_SPEAK = /\b(great question|i'?d be happy to help|happy to help|glad you asked|absolutely|certainly|i think you'll find|let me help|allow me to)\b/i

function scoreResponseQuality(response: string, topic?: string): number {
  if (!response) return 0
  let score = 1.0

  // Length: ideal is 10-80 chars. Penalize verbose responses.
  const len = response.length
  if (len > 150) score -= 0.3
  else if (len > 100) score -= 0.15

  // AI-speak penalty
  if (AI_SPEAK.test(response)) score -= 0.3

  // Constrained voice check: does it survive the voice filter mostly intact?
  const constrained = constrain(response)
  if (!constrained) score -= 0.5

  // Topic relevance: if we know what the response should address, check for it
  if (topic && !response.toLowerCase().includes(topic.toLowerCase())) {
    // Soft penalty - topic words might not appear literally
    score -= 0.1
  }

  return Math.max(0, Math.min(1, score))
}

// -- Composite Scoring --

interface EvalResult {
  compositeScore: number
  gateScore: number
  responseQuality: number
  latencyScore: number
  avgLatencyMs: number
  correctSilent: number
  correctSpeak: number
  falseSpeak: number
  falseSilent: number
  totalRuns: number
  details: string[]
}

async function evaluate(systemPrompt: string, config: InferenceConfig, runs: number): Promise<EvalResult> {
  let correctSilent = 0
  let correctSpeak = 0
  let falseSpeak = 0
  let falseSilent = 0
  let qualitySum = 0
  let qualityCount = 0
  let latencySum = 0
  let latencyCount = 0
  const details: string[] = []

  for (const scenario of scenarios) {
    for (let r = 0; r < runs; r++) {
      const start = performance.now()
      try {
        const raw = await infer(systemPrompt, scenario.conversation, config)
        const elapsed = performance.now() - start
        latencySum += elapsed
        latencyCount++

        const decision = parseDecision(raw)

        if (scenario.expect === 'silent') {
          if (decision.action === GateAction.SILENT) {
            correctSilent++
          } else {
            falseSpeak++
            details.push(`FALSE SPEAK: ${scenario.name} (run ${r + 1})`)
          }
        } else {
          if (decision.action === GateAction.SPEAK) {
            correctSpeak++
            const quality = scoreResponseQuality(
              (decision as { response: string }).response,
              scenario.topic,
            )
            qualitySum += quality
            qualityCount++
          } else {
            falseSilent++
            details.push(`FALSE SILENT: ${scenario.name} (run ${r + 1})`)
          }
        }
      } catch (e) {
        falseSilent++ // inference failure = missed opportunity
        details.push(`ERROR: ${scenario.name} (run ${r + 1}): ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  const totalRuns = (correctSilent + correctSpeak + falseSpeak + falseSilent)

  // Gate score: weighted accuracy with 3:1 silence bias
  // false speaks cost 3x more in the denominator
  const weightedCorrect = correctSilent + correctSpeak
  const weightedErrors = falseSpeak * 3 + falseSilent
  const gateScore = totalRuns ? weightedCorrect / (weightedCorrect + weightedErrors) : 0

  // Response quality: average of speak scenario quality scores
  const responseQuality = qualityCount ? qualitySum / qualityCount : 0

  // Latency score: 0-1 where <500ms = 1.0, >5000ms = 0.0
  const avgLatency = latencyCount ? latencySum / latencyCount : 10000
  const latencyScore = Math.max(0, Math.min(1, 1 - (avgLatency - 500) / 4500))

  // Composite: 70% gate + 15% quality + 15% latency
  const compositeScore = gateScore * 0.70 + responseQuality * 0.15 + latencyScore * 0.15

  return {
    compositeScore,
    gateScore,
    responseQuality,
    latencyScore,
    avgLatencyMs: Math.round(avgLatency),
    correctSilent,
    correctSpeak,
    falseSpeak,
    falseSilent,
    totalRuns,
    details,
  }
}

// -- Mutation --

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function mutateConfig(base: InferenceConfig, models: string[]): InferenceConfig {
  const config = { ...base }
  const dim = Math.random()

  if (dim < 0.35) {
    // Mutate temperature
    config.temperature = clamp(config.temperature + (Math.random() - 0.5) * 0.15, 0, 0.5)
    config.temperature = Math.round(config.temperature * 100) / 100
  } else if (dim < 0.6) {
    // Mutate topP
    config.topP = clamp(config.topP + (Math.random() - 0.5) * 0.3, 0.1, 1.0)
    config.topP = Math.round(config.topP * 100) / 100
  } else if (dim < 0.8) {
    // Mutate numPredict
    const deltas = [-32, -16, 16, 32, 64]
    config.numPredict = clamp(config.numPredict + deltas[Math.floor(Math.random() * deltas.length)]!, 32, 256)
  } else if (models.length > 1) {
    // Swap model
    const others = models.filter((m) => m !== config.model)
    if (others.length) config.model = others[Math.floor(Math.random() * others.length)]!
  }

  return config
}

const PROMPT_MUTATIONS: ((prompt: string) => string)[] = [
  // Add more few-shot examples
  (p) => p.replace(
    'correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}',
    `correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

EXAMPLE of rule 1 - direct address:
person1: hey phila, whats the tallest mountain?
correct response: {"action":"speak","reason":"direct question","response":"mount everest, about 8849 meters"}

EXAMPLE of staying silent:
person1: i had such a bad day
person2: oh no what happened
correct response: {"action":"silent"}`,
  ),

  // Stricter silence framing
  (p) => p.replace(
    'your default is silence - you only speak when it matters.',
    'your default is ABSOLUTE silence. you almost never speak. only rules 1 and 2 override this.',
  ),

  // Emphasize phila name recognition
  (p) => p.replace(
    '1. someone says "phila" and asks you something -> answer it',
    '1. someone mentions your name "phila" (greeting, question, request) -> ALWAYS respond',
  ),

  // Shorter silent examples
  (p) => p.replace(
    `- greetings and small talk
- emotions (venting, celebrating, grieving)
- jokes and banter
- opinions and preferences
- someone already answered correctly`,
    '- everything except rules 1 and 2 above',
  ),

  // Add explicit JSON format emphasis
  (p) => p.replace(
    'respond with ONLY json, no other text:',
    'CRITICAL: respond with ONLY valid json. no explanation, no markdown, just the json object:',
  ),

  // Combine: stronger name trigger + more examples
  (p) => p.replace(
    '1. someone says "phila" and asks you something -> answer it',
    '1. someone says your name "phila" in ANY context (question, greeting, request) -> you MUST respond',
  ).replace(
    'correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}',
    `correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

EXAMPLE of rule 1:
person1: hey phila how are you
correct response: {"action":"speak","reason":"direct address","response":"doing good, whats up"}`,
  ),
]

function mutatePrompt(basePrompt: string): string {
  const mutation = PROMPT_MUTATIONS[Math.floor(Math.random() * PROMPT_MUTATIONS.length)]!
  const result = mutation(basePrompt)
  // If mutation didn't change anything (already applied), return original
  return result
}

// -- Available Models --

async function getAvailableModels(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE_URL}/api/tags`)
    const data = (await res.json()) as { models: { name: string }[] }
    return data.models.map((m) => m.name)
  } catch {
    return ['llama3.2']
  }
}

// -- Checkpoint --

interface Checkpoint {
  generation: number
  bestScore: number
  bestConfig: InferenceConfig
  bestPromptIndex: number | null // which mutation produced the best prompt, null = base
  history: GenerationResult[]
  startedAt: string
  lastUpdated: string
}

interface GenerationResult {
  generation: number
  timestamp: string
  mutationType: string
  config: InferenceConfig
  result: EvalResult
  kept: boolean
}

function loadCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT_PATH)) return null
  try {
    return JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf-8')) as Checkpoint
  } catch {
    return null
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  cp.lastUpdated = new Date().toISOString()
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2))
}

// -- Main --

let running = true
process.on('SIGINT', () => { running = false; console.log('\nshutting down after current trial...') })
process.on('SIGTERM', () => { running = false; console.log('\nshutting down after current trial...') })

async function main() {
  const profile: GroupProfile = { chatId: 'bench', speakBias: 0.0, updatedAt: Date.now() }
  const basePrompt = buildSystemPrompt(profile)
  const models = await getAvailableModels()

  console.log('=== phila continuous optimizer ===')
  console.log(`models: ${models.join(', ')}`)
  console.log(`scenarios: ${scenarios.length} (${scenarios.filter((s) => s.expect === 'silent').length} silent, ${scenarios.filter((s) => s.expect === 'speak').length} speak)`)
  console.log(`runs per eval: ${RUNS}`)
  console.log(`scoring: 70% gate (3:1 weighted) + 15% quality + 15% latency`)
  console.log(`checkpoint: ${CHECKPOINT_PATH}`)
  console.log()

  // Load or create checkpoint
  let cp = loadCheckpoint()
  let bestConfig: InferenceConfig
  let bestPrompt: string
  let generation: number

  if (cp) {
    console.log(`resuming from generation ${cp.generation}, best score: ${(cp.bestScore * 100).toFixed(1)}%`)
    bestConfig = cp.bestConfig
    bestPrompt = cp.bestPromptIndex !== null ? mutatePrompt(basePrompt) : basePrompt
    generation = cp.generation
  } else {
    bestConfig = { model: 'llama3.2', temperature: 0.1, numPredict: 64, topP: 0.5 }

    // Establish baseline
    console.log('--- baseline ---')
    const baseline = await evaluate(basePrompt, bestConfig, RUNS)
    printResult(baseline)

    bestPrompt = basePrompt
    generation = 0
    cp = {
      generation: 0,
      bestScore: baseline.compositeScore,
      bestConfig,
      bestPromptIndex: null,
      history: [{
        generation: 0,
        timestamp: new Date().toISOString(),
        mutationType: 'baseline',
        config: bestConfig,
        result: baseline,
        kept: true,
      }],
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    }
    saveCheckpoint(cp)
    console.log()
  }

  // Continuous loop
  while (running) {
    generation++

    // Decide mutation type: 50% config, 40% prompt, 10% both
    const roll = Math.random()
    let trialPrompt = bestPrompt
    let trialConfig = bestConfig
    let mutationType: string

    if (roll < 0.5) {
      trialConfig = mutateConfig(bestConfig, models)
      mutationType = `config: t=${trialConfig.temperature} tp=${trialConfig.topP} np=${trialConfig.numPredict} m=${trialConfig.model}`
    } else if (roll < 0.9) {
      trialPrompt = mutatePrompt(basePrompt)
      mutationType = 'prompt mutation'
    } else {
      trialConfig = mutateConfig(bestConfig, models)
      trialPrompt = mutatePrompt(basePrompt)
      mutationType = `both: t=${trialConfig.temperature} tp=${trialConfig.topP} np=${trialConfig.numPredict}`
    }

    console.log(`--- gen ${generation} [${mutationType}] ---`)

    try {
      const result = await evaluate(trialPrompt, trialConfig, RUNS)
      const improved = result.compositeScore > cp.bestScore

      printResult(result)
      console.log(`  ${improved ? '>>> IMPROVEMENT <<<' : 'no improvement'} (best: ${(cp.bestScore * 100).toFixed(1)}%)`)

      if (improved) {
        cp.bestScore = result.compositeScore
        cp.bestConfig = trialConfig
        bestConfig = trialConfig
        bestPrompt = trialPrompt
        if (trialPrompt !== basePrompt) {
          cp.bestPromptIndex = generation
        }
      }

      cp.generation = generation
      cp.history.push({
        generation,
        timestamp: new Date().toISOString(),
        mutationType,
        config: trialConfig,
        result,
        kept: improved,
      })

      // Keep history manageable - only last 200 entries
      if (cp.history.length > 200) {
        cp.history = cp.history.slice(-200)
      }

      saveCheckpoint(cp)
    } catch (e) {
      console.log(`  ERROR: ${e instanceof Error ? e.message : e}`)
    }

    console.log()

    // Refresh model list every 10 generations
    if (generation % 10 === 0) {
      const newModels = await getAvailableModels()
      if (newModels.length !== models.length) {
        console.log(`models updated: ${newModels.join(', ')}`)
        models.length = 0
        models.push(...newModels)
      }
    }
  }

  console.log()
  console.log('=== final summary ===')
  console.log(`generations: ${generation}`)
  console.log(`best composite: ${(cp.bestScore * 100).toFixed(1)}%`)
  console.log(`best config: ${JSON.stringify(cp.bestConfig)}`)
  console.log(`improvements: ${cp.history.filter((h) => h.kept).length}/${cp.history.length}`)
  console.log(`checkpoint saved: ${CHECKPOINT_PATH}`)
}

function printResult(r: EvalResult): void {
  console.log(`  composite: ${(r.compositeScore * 100).toFixed(1)}% | gate: ${(r.gateScore * 100).toFixed(1)}% | quality: ${(r.responseQuality * 100).toFixed(1)}% | latency: ${r.avgLatencyMs}ms (${(r.latencyScore * 100).toFixed(0)}%)`)
  console.log(`  correct: ${r.correctSilent}s ${r.correctSpeak}sp | errors: ${r.falseSpeak} false-speak (3x) ${r.falseSilent} false-silent`)
  if (r.details.length) console.log(`  ${r.details.slice(0, 5).join(', ')}${r.details.length > 5 ? ` (+${r.details.length - 5} more)` : ''}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
