// Shared evaluation utilities extracted from continuous-optimize.ts.
// Used by tournament.ts and continuous-optimize.ts for consistent scoring.

import { parseDecision } from '../src/gate.ts'
import { GateAction } from '../src/types.ts'
import type { Scenario } from './scenarios.ts'
import { scoreResponse, compositeWeights } from './scorer.ts'
import { infer } from './inference.ts'
import type { InferenceConfig } from './inference.ts'

export interface EvalResult {
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
  perScenarioScores: number[]
  details: string[]
}

export async function evaluate(
  systemPrompt: string,
  config: InferenceConfig,
  scenarios: Scenario[],
  runs: number,
  baseUrl: string,
): Promise<EvalResult> {
  let correctSilent = 0
  let correctSpeak = 0
  let falseSpeak = 0
  let falseSilent = 0
  let qualitySum = 0
  let qualityCount = 0
  let latencySum = 0
  let latencyCount = 0
  const details: string[] = []
  const perScenarioScores: number[] = []

  for (const scenario of scenarios) {
    let scenarioScore = 0
    for (let r = 0; r < runs; r++) {
      const start = performance.now()
      try {
        const raw = await infer(systemPrompt, scenario.conversation, config, baseUrl)
        const elapsed = performance.now() - start
        latencySum += elapsed
        latencyCount++

        const decision = parseDecision(raw)

        if (scenario.expect === 'silent') {
          if (decision.action === GateAction.SILENT) {
            correctSilent++
            scenarioScore += 1
          } else {
            falseSpeak++
            details.push(`FALSE SPEAK: ${scenario.name} (run ${r + 1})`)
          }
        } else {
          if (decision.action === GateAction.SPEAK) {
            correctSpeak++
            const breakdown = scoreResponse(decision.response, scenario)
            qualitySum += breakdown.composite
            qualityCount++
            scenarioScore += breakdown.composite
          } else {
            falseSilent++
            details.push(`FALSE SILENT: ${scenario.name} (run ${r + 1})`)
          }
        }
      } catch (e) {
        falseSilent++
        details.push(`ERROR: ${scenario.name} (run ${r + 1}): ${e instanceof Error ? e.message : e}`)
      }
    }
    perScenarioScores.push(scenarioScore / runs)
  }

  const totalRuns = correctSilent + correctSpeak + falseSpeak + falseSilent

  // Gate score: weighted accuracy with 3:1 silence bias
  const weightedCorrect = correctSilent + correctSpeak
  const weightedErrors = falseSpeak * 3 + falseSilent
  const gateScore = totalRuns ? weightedCorrect / (weightedCorrect + weightedErrors) : 0

  // Response quality: average of speak scenario quality scores
  const responseQuality = qualityCount ? qualitySum / qualityCount : 0

  // Latency score: 0-1 where <500ms = 1.0, >5000ms = 0.0
  const avgLatency = latencyCount ? latencySum / latencyCount : 10000
  const latencyScore = Math.max(0, Math.min(1, 1 - (avgLatency - 500) / 4500))

  // Auto-rebalancing composite weights based on gate accuracy
  const w = compositeWeights(gateScore)
  const compositeScore = gateScore * w.gate + responseQuality * w.quality + latencyScore * w.latency

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
    perScenarioScores,
    details,
  }
}

// -- Paired t-test --

export function pairedTTest(a: number[], b: number[]): { t: number; p: number } {
  const n = a.length
  if (n < 2) return { t: 0, p: 1 }

  const diffs = a.map((v, i) => v - (b[i] ?? 0))
  const mean = diffs.reduce((s, d) => s + d, 0) / n
  const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1)
  const se = Math.sqrt(variance / n)
  if (se === 0) return { t: mean === 0 ? 0 : Infinity, p: mean === 0 ? 1 : 0 }

  const t = mean / se
  const df = n - 1

  // One-tailed p-value via t-distribution approximation (Abramowitz & Stegun)
  const x = df / (df + t * t)
  const p = t > 0 ? incompleteBeta(df / 2, 0.5, x) / 2 : 1
  return { t, p }
}

// Regularized incomplete beta function (continued fraction, sufficient for t-test)
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1

  const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b)
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta)

  // Lentz's continued fraction
  let f = 1, c = 1, d = 1 - (a + b) * x / (a + 1)
  if (Math.abs(d) < 1e-30) d = 1e-30
  d = 1 / d
  f = d

  for (let m = 1; m <= 200; m++) {
    // Even step
    let num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m))
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30
    f *= d * c

    // Odd step
    num = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30
    const delta = d * c
    f *= delta

    if (Math.abs(delta - 1) < 1e-10) break
  }

  return front * f / a
}

// Log-gamma (Lanczos approximation)
export function lgamma(z: number): number {
  const g = 7
  const coef = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z)
  z -= 1
  let x = coef[0]!
  for (let i = 1; i < g + 2; i++) x += coef[i]! / (z + i)
  const t = z + g + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

export const T_TEST_THRESHOLD = 0.10 // one-tailed p-value

// -- Reward Hacking Detection --

export interface HackingState {
  holdoutPeak: number
  holdoutPeakGen: number
  gapHistory: number[] // train - holdout gap per generation
}

export function detectRewardHacking(
  trainScore: number,
  holdoutScore: number,
  generation: number,
  state: HackingState,
): { hacking: boolean; reason: string } {
  // Update peak tracking
  if (holdoutScore > state.holdoutPeak) {
    state.holdoutPeak = holdoutScore
    state.holdoutPeakGen = generation
  }

  const gap = trainScore - holdoutScore
  state.gapHistory.push(gap)

  // Check 1: holdout dropped > 3% from peak while train improved
  if (state.holdoutPeak - holdoutScore > 0.03) {
    return { hacking: true, reason: `holdout dropped ${((state.holdoutPeak - holdoutScore) * 100).toFixed(1)}% from peak` }
  }

  // Check 2: gap increasing monotonically over 5 generations
  if (state.gapHistory.length >= 5) {
    const last5 = state.gapHistory.slice(-5)
    let monotonic = true
    for (let i = 1; i < last5.length; i++) {
      if ((last5[i] ?? 0) <= (last5[i - 1] ?? 0)) { monotonic = false; break }
    }
    if (monotonic) {
      return { hacking: true, reason: 'train-holdout gap increased monotonically over 5 generations' }
    }
  }

  return { hacking: false, reason: '' }
}
