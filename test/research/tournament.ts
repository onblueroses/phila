// Single-elimination tournament for prompt mutation benchmarking.
// Selects the best gate prompt candidate using paired t-test significance testing.
// Holdout scenarios are evaluated AFTER the winner is determined - never used for selection.

import { parseArgs } from 'node:util'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'

import { buildSystemPrompt } from '../../src/gate.ts'
import { evaluate, pairedTTest, detectRewardHacking, T_TEST_THRESHOLD } from '../eval-shared.ts'
import type { EvalResult, HackingState } from '../eval-shared.ts'
import { trainScenarios, holdoutScenarios } from '../scenarios.ts'
import type { Scenario } from '../scenarios.ts'
import type { InferenceConfig } from '../inference.ts'

// -- Types --

interface PromptMutation {
  name: string
  description: string
  fullPrompt: string
}

interface MutationsFile {
  mutations: PromptMutation[]
  basePromptLength?: number
  generatedAt?: string
}

interface TournamentEntry {
  name: string
  trainScore: number
  holdoutScore?: number
  tTestP: number
  accepted: boolean
}

interface WinnerResult {
  name: string
  prompt: string
  trainScore: number
  holdoutScore: number
  hackingCheck: { hacking: boolean; reason: string }
}

interface ScenarioDistribution {
  name: string
  category: string
  expect: 'silent' | 'speak'
  mean: number
  stddev: number
  min: number
  max: number
  runs: number
}

interface OutputFile {
  baseline: { compositeScore: number; gateScore: number; responseQuality: number }
  tournament: TournamentEntry[]
  winner: WinnerResult
  qualityDive?: ScenarioDistribution[]
  timestamp: string
}

// -- Partial results for signal handling --

interface PartialOutput {
  baseline?: { compositeScore: number; gateScore: number; responseQuality: number }
  tournament: TournamentEntry[]
  winner?: Partial<WinnerResult>
  timestamp: string
  partial: true
}

// -- CLI --

const { values } = parseArgs({
  options: {
    mutations: { type: 'string' },
    runs: { type: 'string', default: '3' },
    model: { type: 'string', default: 'llama3.2' },
    out: { type: 'string' },
    'quality-dive': { type: 'boolean', default: false },
  },
  strict: true,
})

if (!values.out) {
  console.error(
    'Usage: node --experimental-strip-types test/research/tournament.ts --out <path> [--mutations <path>] [--runs N] [--model <name>]',
  )
  process.exit(1)
}

const outPath = values.out
const runs = parseInt(values.runs ?? '3', 10)
if (isNaN(runs) || runs < 1) {
  console.error('--runs must be a positive integer')
  process.exit(1)
}

const baseUrl = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'

const config: InferenceConfig = {
  model: values.model ?? 'llama3.2',
  temperature: 0.1,
  topP: 0.52,
  numPredict: 64,
}

const candidatesDir = 'test/research-reports/candidates'
mkdirSync(candidatesDir, { recursive: true })

// -- Signal handling: write partial results before exit --

const partial: PartialOutput = { tournament: [], timestamp: new Date().toISOString(), partial: true }

function writePartialAndExit(): void {
  try {
    writeFileSync(outPath, JSON.stringify(partial, null, 2))
    console.error(`\nInterrupted. Partial results written to ${outPath}`)
  } catch (e) {
    console.error('Failed to write partial results:', e instanceof Error ? e.message : e)
  }
  process.exit(0)
}

process.on('SIGINT', writePartialAndExit)
process.on('SIGTERM', writePartialAndExit)

// -- Load mutations --

let mutations: PromptMutation[] = []

if (values.mutations) {
  if (!existsSync(values.mutations)) {
    console.error(`--mutations file not found: ${values.mutations}`)
    process.exit(1)
  }
  let parsed: MutationsFile
  try {
    parsed = JSON.parse(readFileSync(values.mutations, 'utf8')) as MutationsFile
  } catch (e) {
    console.error('Failed to parse --mutations file:', e instanceof Error ? e.message : e)
    process.exit(1)
  }
  mutations = parsed.mutations ?? []
  console.log(`Loaded ${mutations.length} mutations from ${values.mutations}`)
} else {
  console.log('No --mutations file provided - running tournament with baseline only')
}

// -- Scenarios --

const train = trainScenarios()
const holdout = holdoutScenarios()
console.log(`Scenarios: ${train.length} train, ${holdout.length} holdout`)
console.log(`Config: model=${config.model}, runs=${runs}, temperature=${config.temperature}`)
console.log()

// -- Evaluate baseline --

const baselinePrompt = buildSystemPrompt({ chatId: 'benchmark', speakBias: 0, updatedAt: 0 })
console.log('Evaluating baseline...')
const baselineResult: EvalResult = await evaluate(baselinePrompt, config, train, runs, baseUrl)
console.log(`  baseline: composite=${baselineResult.compositeScore.toFixed(4)} gate=${baselineResult.gateScore.toFixed(4)}`)

partial.baseline = {
  compositeScore: baselineResult.compositeScore,
  gateScore: baselineResult.gateScore,
  responseQuality: baselineResult.responseQuality,
}

// -- Tournament --

// Champion tracks both the prompt text and last eval result so we can do t-tests
let championPrompt = baselinePrompt
let championResult = baselineResult
let championName = 'baseline'

const tournamentLog: TournamentEntry[] = []
partial.tournament = tournamentLog

for (const mutation of mutations) {
  console.log(`Evaluating mutation: ${mutation.name}`)
  const mutResult: EvalResult = await evaluate(mutation.fullPrompt, config, train, runs, baseUrl)
  console.log(`  ${mutation.name}: composite=${mutResult.compositeScore.toFixed(4)} gate=${mutResult.gateScore.toFixed(4)}`)

  // pairedTTest(champion, challenger): t > 0 means champion beats challenger, p < threshold means significant
  // We want to detect if challenger is significantly BETTER than champion, so we test challenger vs champion.
  // The function computes diffs as a[i] - b[i], positive t means a > b. To detect challenger improvement,
  // pass challenger as a and champion as b so t > 0 means challenger wins.
  const tResult = pairedTTest(mutResult.perScenarioScores, championResult.perScenarioScores)

  // Both conditions must hold: statistical significance AND composite score improvement
  const accepted = tResult.p < T_TEST_THRESHOLD && mutResult.compositeScore > championResult.compositeScore

  if (accepted) {
    console.log(`  -> ACCEPTED (p=${tResult.p.toFixed(4)}, score improvement ${championResult.compositeScore.toFixed(4)} -> ${mutResult.compositeScore.toFixed(4)})`)
    championPrompt = mutation.fullPrompt
    championResult = mutResult
    championName = mutation.name
  } else {
    const reason = tResult.p >= T_TEST_THRESHOLD ? `p=${tResult.p.toFixed(4)} not significant` : `score ${mutResult.compositeScore.toFixed(4)} <= champion ${championResult.compositeScore.toFixed(4)}`
    console.log(`  -> rejected (${reason})`)
  }

  tournamentLog.push({
    name: mutation.name,
    trainScore: mutResult.compositeScore,
    tTestP: tResult.p,
    accepted,
  })
}

console.log(`\nTournament complete. Winner: ${championName} (composite=${championResult.compositeScore.toFixed(4)})`)

// -- Holdout evaluation (reporting only, never affects selection) --

console.log(`\nEvaluating winner on holdout scenarios...`)
const holdoutResult: EvalResult = await evaluate(championPrompt, config, holdout, runs, baseUrl)
console.log(`  holdout: composite=${holdoutResult.compositeScore.toFixed(4)} gate=${holdoutResult.gateScore.toFixed(4)}`)

// Back-fill holdout score on tournament entry if the winner was a mutation (not baseline)
if (championName !== 'baseline') {
  const entry = tournamentLog.find((e) => e.name === championName)
  if (entry) entry.holdoutScore = holdoutResult.compositeScore
}

// -- Reward hacking check --

// generation=1 since tournament runs once per campaign - not a rolling series
const hackingState: HackingState = { holdoutPeak: 0, holdoutPeakGen: 0, gapHistory: [] }
const hackingCheck = detectRewardHacking(
  championResult.compositeScore,
  holdoutResult.compositeScore,
  1,
  hackingState,
)
console.log(`  hacking: ${hackingCheck.hacking ? `YES - ${hackingCheck.reason}` : 'none detected'}`)

// -- Write outputs --

const winner: WinnerResult = {
  name: championName,
  prompt: championPrompt,
  trainScore: championResult.compositeScore,
  holdoutScore: holdoutResult.compositeScore,
  hackingCheck,
}

partial.winner = winner

const output: OutputFile = {
  baseline: {
    compositeScore: baselineResult.compositeScore,
    gateScore: baselineResult.gateScore,
    responseQuality: baselineResult.responseQuality,
  },
  tournament: tournamentLog,
  winner,
  timestamp: new Date().toISOString(),
}

// -- Quality dive (optional): per-scenario score distributions on speak train scenarios --

let qualityDive: ScenarioDistribution[] | undefined

if (values['quality-dive']) {
  const QUALITY_RUNS = 10
  const speakScenarios: Scenario[] = train.filter((s) => s.expect === 'speak')
  console.log(`\nQuality dive: ${speakScenarios.length} speak scenarios x ${QUALITY_RUNS} runs each...`)

  qualityDive = []
  for (const scenario of speakScenarios) {
    // Run the single scenario multiple times to collect a score distribution
    const scores: number[] = []
    for (let i = 0; i < QUALITY_RUNS; i++) {
      const r: EvalResult = await evaluate(championPrompt, config, [scenario], 1, baseUrl)
      scores.push(r.compositeScore)
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length
    const distribution: ScenarioDistribution = {
      name: scenario.name,
      category: scenario.category,
      expect: scenario.expect,
      mean,
      stddev: Math.sqrt(variance),
      min: Math.min(...scores),
      max: Math.max(...scores),
      runs: QUALITY_RUNS,
    }
    qualityDive.push(distribution)
    console.log(`  [${scenario.name}] mean=${mean.toFixed(4)} stddev=${distribution.stddev.toFixed(4)} min=${distribution.min.toFixed(4)} max=${distribution.max.toFixed(4)}`)
  }
}

writeFileSync(outPath, JSON.stringify({ ...output, qualityDive }, null, 2))
console.log(`\nResults written to ${outPath}`)

// Write winning prompt text for direct use in future benchmark/optimize runs
const candidatePath = `${candidatesDir}/best-${Date.now()}.txt`
writeFileSync(candidatePath, championPrompt)
console.log(`Winning prompt written to ${candidatePath}`)
