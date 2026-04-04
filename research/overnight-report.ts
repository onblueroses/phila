// Generates a markdown morning summary report from a single overnight campaign round.
// Reads tournament JSON, adversarial JSON, and quality-dive data from a round directory.
// Produces overnight-round-{N}.md with full analysis and an actionable recommendation.

import { parseArgs } from 'node:util'
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// -- Types (minimal - we only parse what we need for the report) --

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
  hackingCheck: { hacking: boolean; reason?: string }
}

interface BaselineResult {
  compositeScore: number
  gateScore: number
  responseQuality: number
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

interface TournamentOutput {
  baseline: BaselineResult
  tournament: TournamentEntry[]
  winner: WinnerResult
  qualityDive?: ScenarioDistribution[]
  timestamp: string
}

interface AdversarialScenario {
  name: string
  conversation: string
  expect: 'silent' | 'speak'
  category: string
}

interface AdversarialResult {
  name: string
  expect: 'silent' | 'speak'
  actual: 'silent' | 'speak'
  pass: boolean
}

interface AdversarialOutput {
  scenarios: AdversarialScenario[]
  results: AdversarialResult[]
  failureRate: number
}

// -- CLI --

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    round: { type: 'string', default: '1' },
    out: { type: 'string' },
  },
  strict: true,
})

if (!values.dir) {
  console.error(
    'Usage: node --experimental-strip-types research/overnight-report.ts --dir <round-dir> [--round N] [--out <path>]',
  )
  process.exit(1)
}

const roundNum = parseInt(values.round ?? '1', 10)
const roundLabel = String(roundNum).padStart(3, '0')

// -- Find and load files --

function findLatestJson(dir: string, prefix: string): string | undefined {
  if (!existsSync(dir)) return undefined
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .reverse()
  return files[0] ? join(dir, files[0]) : undefined
}

function loadJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (e) {
    console.warn(`Could not load ${path}:`, e instanceof Error ? e.message : e)
    return undefined
  }
}

const tournamentPath = findLatestJson(values.dir, 'tournament-')
const adversarialPath = findLatestJson(values.dir, 'adversarial-')

const tournament = tournamentPath ? loadJson<TournamentOutput>(tournamentPath) : undefined
const adversarial = adversarialPath ? loadJson<AdversarialOutput>(adversarialPath) : undefined

if (!tournament) {
  console.error(`No tournament-*.json found in ${values.dir}`)
  process.exit(1)
}

// -- Report helpers --

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function scoreFmt(n: number): string {
  return n.toFixed(4)
}

// -- Recommendation logic --

const winner = tournament.winner
const baseline = tournament.baseline
const trainDelta = winner.trainScore - baseline.compositeScore
const holdoutDelta = winner.holdoutScore - baseline.compositeScore
const hacking = winner.hackingCheck.hacking
const significantImprovement = trainDelta > 0.01 && holdoutDelta > 0

let recommendation: string
let recommendationLabel: 'SHIP' | 'NO_IMPROVEMENT' | 'CAUTION'

if (hacking) {
  recommendation = `**CAUTION - Reward hacking detected.** The winning prompt improved on train but the holdout gap suggests overfitting. Reason: ${winner.hackingCheck.reason ?? 'unknown'}. Do not ship without further investigation.`
  recommendationLabel = 'CAUTION'
} else if (significantImprovement) {
  recommendation = `**SHIP THIS PROMPT.** Train improvement: +${scoreFmt(trainDelta)} (+${pct(trainDelta / baseline.compositeScore)}). Holdout improvement: +${scoreFmt(holdoutDelta)}. No reward hacking detected. Winner: \`${winner.name}\`.`
  recommendationLabel = 'SHIP'
} else {
  const reasons: string[] = []
  if (trainDelta <= 0.01) reasons.push(`train improvement marginal (${scoreFmt(trainDelta)})`)
  if (holdoutDelta <= 0) reasons.push(`holdout did not improve (${scoreFmt(holdoutDelta)})`)
  recommendation = `**NO IMPROVEMENT FOUND.** ${reasons.join('; ')}. Baseline remains the best prompt. Check adversarial failures for new mutation ideas.`
  recommendationLabel = 'NO_IMPROVEMENT'
}

// -- Build report sections --

const sections: string[] = []

sections.push(`# Overnight Campaign - Round ${roundNum} Report
Generated: ${new Date().toISOString()}
Tournament: ${tournamentPath ?? 'n/a'}
Adversarial: ${adversarialPath ?? 'n/a'}
`)

// Executive Summary
sections.push(`## Executive Summary

| Metric | Baseline | Winner (${winner.name}) | Delta |
|--------|----------|---------|-------|
| Train composite | ${scoreFmt(baseline.compositeScore)} | ${scoreFmt(winner.trainScore)} | ${trainDelta >= 0 ? '+' : ''}${scoreFmt(trainDelta)} |
| Holdout composite | - | ${scoreFmt(winner.holdoutScore)} | ${holdoutDelta >= 0 ? '+' : ''}${scoreFmt(holdoutDelta)} |
| Baseline gate score | ${scoreFmt(baseline.gateScore)} | - | - |
| Reward hacking | - | ${hacking ? 'YES' : 'none'} | - |
| Mutations evaluated | - | ${tournament.tournament.length} | - |
| Mutations accepted | - | ${tournament.tournament.filter((e) => e.accepted).length} | - |

### Recommendation

${recommendation}
`)

// Best Prompt Candidate
sections.push(`## Best Prompt Candidate

**Name:** \`${winner.name}\`
**Train score:** ${scoreFmt(winner.trainScore)}
**Holdout score:** ${scoreFmt(winner.holdoutScore)}

\`\`\`
${winner.prompt}
\`\`\`
`)

// Before/After Metrics
sections.push(`## Before/After Metrics

| | Baseline | Winner |
|---|---------|--------|
| Composite | ${scoreFmt(baseline.compositeScore)} | ${scoreFmt(winner.trainScore)} |
| Gate accuracy | ${scoreFmt(baseline.gateScore)} | *(not separately tracked for winner)* |
| Response quality | ${scoreFmt(baseline.responseQuality)} | *(not separately tracked for winner)* |
| Holdout composite | *(baseline not evaluated on holdout)* | ${scoreFmt(winner.holdoutScore)} |
`)

// Tournament Results
if (tournament.tournament.length > 0) {
  const rows = tournament.tournament
    .map((e) => `| ${e.name} | ${scoreFmt(e.trainScore)} | ${e.tTestP.toFixed(4)} | ${e.accepted ? 'accepted' : 'rejected'} |`)
    .join('\n')
  sections.push(`## Tournament Results

| Mutation | Train score | p-value | Decision |
|---------|------------|---------|---------|
| baseline | ${scoreFmt(baseline.compositeScore)} | - | champion |
${rows}
`)
} else {
  sections.push(`## Tournament Results

No mutations were provided. Baseline is the winner by default.
`)
}

// Adversarial Findings
if (adversarial) {
  const failures = adversarial.results.filter((r) => !r.pass)
  sections.push(`## Adversarial Findings

**Scenarios generated:** ${adversarial.scenarios.length}
**Gate failures:** ${failures.length}/${adversarial.results.length} (${pct(adversarial.failureRate)})

${
  failures.length > 0
    ? `### Failure Cases\n\n${failures.map((f) => `- **${f.name}**: expected \`${f.expect}\`, got \`${f.actual}\``).join('\n')}`
    : 'No gate failures - model handled all adversarial scenarios correctly.'
}
`)
} else {
  sections.push(`## Adversarial Findings

No adversarial data found in round directory.
`)
}

// Quality Distributions
if (tournament.qualityDive && tournament.qualityDive.length > 0) {
  const rows = tournament.qualityDive
    .map((d) => `| ${d.name} | ${scoreFmt(d.mean)} | ${scoreFmt(d.stddev)} | ${scoreFmt(d.min)} | ${scoreFmt(d.max)} |`)
    .join('\n')
  sections.push(`## Quality Distributions (Speak Scenarios)

Distributions are over ${tournament.qualityDive[0]?.runs ?? 10} runs of the winning prompt on each speak scenario.

| Scenario | Mean | Stddev | Min | Max |
|---------|------|--------|-----|-----|
${rows}
`)
} else {
  sections.push(`## Quality Distributions

No quality dive data available. Run tournament with \`--quality-dive\` to populate this section.
`)
}

// -- Assemble and write report --

const report = sections.join('\n---\n\n')
const outPath = values.out ?? `test/research-reports/overnight-round-${roundLabel}.md`
writeFileSync(outPath, report)
console.log(`Report written to ${outPath}`)
console.log(`Recommendation: ${recommendationLabel}`)
