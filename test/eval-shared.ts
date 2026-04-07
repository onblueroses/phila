// Shared evaluation utilities extracted from continuous-optimize.ts.
// Used by tournament.ts and continuous-optimize.ts for consistent scoring.

import { parseDecision } from "../src/gate.ts";
import { GateAction } from "../src/types.ts";
import type { InferenceConfig } from "./inference.ts";
import { infer } from "./inference.ts";
import type { Scenario } from "./scenarios.ts";
import { compositeWeights, scoreResponse } from "./scorer.ts";

export interface EvalResult {
	compositeScore: number;
	gateScore: number;
	responseQuality: number;
	latencyScore: number;
	avgLatencyMs: number;
	correctSilent: number;
	correctSpeak: number;
	falseSpeak: number;
	falseSilent: number;
	totalRuns: number;
	perScenarioScores: number[];
	details: string[];
}

export async function evaluate(
	systemPrompt: string,
	config: InferenceConfig,
	scenarios: Scenario[],
	runs: number,
	baseUrl: string,
): Promise<EvalResult> {
	let correctSilent = 0;
	let correctSpeak = 0;
	let falseSpeak = 0;
	let falseSilent = 0;
	let qualitySum = 0;
	let qualityCount = 0;
	let latencySum = 0;
	let latencyCount = 0;
	const details: string[] = [];
	const perScenarioScores: number[] = [];

	for (const scenario of scenarios) {
		let scenarioScore = 0;
		for (let r = 0; r < runs; r++) {
			const start = performance.now();
			try {
				const raw = await infer(
					systemPrompt,
					scenario.conversation,
					config,
					baseUrl,
				);
				const elapsed = performance.now() - start;
				latencySum += elapsed;
				latencyCount++;

				const decision = parseDecision(raw);

				if (scenario.expect === "silent") {
					if (decision.action === GateAction.SILENT) {
						correctSilent++;
						scenarioScore += 1;
					} else {
						falseSpeak++;
						details.push(`FALSE SPEAK: ${scenario.name} (run ${r + 1})`);
					}
				} else {
					if (decision.action === GateAction.SPEAK) {
						correctSpeak++;
						const breakdown = scoreResponse(decision.response, scenario);
						qualitySum += breakdown.composite;
						qualityCount++;
						scenarioScore += breakdown.composite;
					} else {
						falseSilent++;
						details.push(`FALSE SILENT: ${scenario.name} (run ${r + 1})`);
					}
				}
			} catch (e) {
				falseSilent++;
				details.push(
					`ERROR: ${scenario.name} (run ${r + 1}): ${e instanceof Error ? e.message : e}`,
				);
			}
		}
		perScenarioScores.push(scenarioScore / runs);
	}

	const totalRuns = correctSilent + correctSpeak + falseSpeak + falseSilent;

	// Gate score: weighted accuracy with 3:1 silence bias
	const weightedCorrect = correctSilent + correctSpeak;
	const weightedErrors = falseSpeak * 3 + falseSilent;
	const gateScore = totalRuns
		? weightedCorrect / (weightedCorrect + weightedErrors)
		: 0;

	// Response quality: average of speak scenario quality scores
	const responseQuality = qualityCount ? qualitySum / qualityCount : 0;

	// Latency score: 0-1 where <500ms = 1.0, >5000ms = 0.0
	const avgLatency = latencyCount ? latencySum / latencyCount : 10000;
	const latencyScore = Math.max(0, Math.min(1, 1 - (avgLatency - 500) / 4500));

	// Auto-rebalancing composite weights based on gate accuracy
	const w = compositeWeights(gateScore);
	const compositeScore =
		gateScore * w.gate + responseQuality * w.quality + latencyScore * w.latency;

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
	};
}

// Split-model evaluation: gate model classifies, response model generates.
// Only the gate prompt is optimized; response prompt is fixed.
export async function evaluateSplit(
	gatePrompt: string,
	gateConfig: InferenceConfig,
	responsePrompt: string,
	responseConfig: InferenceConfig,
	scenarios: Scenario[],
	runs: number,
	baseUrl: string,
): Promise<EvalResult> {
	let correctSilent = 0;
	let correctSpeak = 0;
	let falseSpeak = 0;
	let falseSilent = 0;
	let qualitySum = 0;
	let qualityCount = 0;
	let latencySum = 0;
	let latencyCount = 0;
	const details: string[] = [];
	const perScenarioScores: number[] = [];

	for (const scenario of scenarios) {
		let scenarioScore = 0;
		for (let r = 0; r < runs; r++) {
			const start = performance.now();
			try {
				// Pass 1: gate model decides speak/silent
				const gateRaw = await infer(
					gatePrompt,
					scenario.conversation,
					gateConfig,
					baseUrl,
				);
				const gateDecision = parseDecision(gateRaw);

				if (scenario.expect === "silent") {
					if (gateDecision.action === GateAction.SILENT) {
						correctSilent++;
						scenarioScore += 1;
					} else {
						falseSpeak++;
						details.push(`FALSE SPEAK: ${scenario.name} (run ${r + 1})`);
					}
				} else {
					if (gateDecision.action === GateAction.SPEAK) {
						// Pass 2: response model generates answer
						const reason = gateDecision.reason ?? "direct address";
						const respPrompt = responsePrompt.replace(/\$\{reason\}/g, reason);
						const respRaw = await infer(
							respPrompt,
							scenario.conversation,
							responseConfig,
							baseUrl,
						);
						correctSpeak++;
						const respDecision = parseDecision(respRaw);
						if (
							respDecision.action === GateAction.SPEAK &&
							respDecision.response
						) {
							const breakdown = scoreResponse(respDecision.response, scenario);
							qualitySum += breakdown.composite;
							qualityCount++;
							scenarioScore += breakdown.composite;
						} else {
							scenarioScore += 0.5; // gate correct but response parse failed
						}
					} else {
						falseSilent++;
						details.push(`FALSE SILENT: ${scenario.name} (run ${r + 1})`);
					}
				}

				const elapsed = performance.now() - start;
				latencySum += elapsed;
				latencyCount++;
			} catch (e) {
				falseSilent++;
				details.push(
					`ERROR: ${scenario.name} (run ${r + 1}): ${e instanceof Error ? e.message : e}`,
				);
			}
		}
		perScenarioScores.push(scenarioScore / runs);
	}

	const totalRuns = correctSilent + correctSpeak + falseSpeak + falseSilent;
	const weightedCorrect = correctSilent + correctSpeak;
	const weightedErrors = falseSpeak * 3 + falseSilent;
	const gateScore = totalRuns
		? weightedCorrect / (weightedCorrect + weightedErrors)
		: 0;
	const responseQuality = qualityCount ? qualitySum / qualityCount : 0;
	const avgLatency = latencyCount ? latencySum / latencyCount : 10000;
	const latencyScore = Math.max(0, Math.min(1, 1 - (avgLatency - 500) / 4500));
	const w = compositeWeights(gateScore);
	const compositeScore =
		gateScore * w.gate + responseQuality * w.quality + latencyScore * w.latency;

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
	};
}

// -- Confusion Matrix --

export interface ConfusionMatrix {
	truePositive: number; // correctly spoke
	trueNegative: number; // correctly silent
	falsePositive: number; // false-speak (spoke when should be silent)
	falseNegative: number; // false-silent (silent when should speak)
	precision: number; // TP / (TP + FP)
	recall: number; // TP / (TP + FN)
	specificity: number; // TN / (TN + FP)
	falsePositiveRate: number; // FP / (FP + TN)
	f1: number;
	accuracy: number;
}

export function confusionMatrix(result: EvalResult): ConfusionMatrix {
	const tp = result.correctSpeak;
	const tn = result.correctSilent;
	const fp = result.falseSpeak;
	const fn = result.falseSilent;

	const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
	const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
	const specificity = tn + fp > 0 ? tn / (tn + fp) : 1;
	const falsePositiveRate = tn + fp > 0 ? fp / (tn + fp) : 0;
	const f1 =
		precision + recall > 0
			? (2 * precision * recall) / (precision + recall)
			: 0;
	const accuracy = result.totalRuns > 0 ? (tp + tn) / result.totalRuns : 0;

	return {
		truePositive: tp,
		trueNegative: tn,
		falsePositive: fp,
		falseNegative: fn,
		precision,
		recall,
		specificity,
		falsePositiveRate,
		f1,
		accuracy,
	};
}

export function formatConfusionMatrix(cm: ConfusionMatrix): string {
	const lines = [
		"confusion matrix:",
		"                  predicted-speak  predicted-silent",
		`  actual-speak         ${String(cm.truePositive).padStart(4)}            ${String(cm.falseNegative).padStart(4)}`,
		`  actual-silent        ${String(cm.falsePositive).padStart(4)}            ${String(cm.trueNegative).padStart(4)}`,
		"",
		`  precision: ${cm.precision.toFixed(3)}  recall: ${cm.recall.toFixed(3)}  specificity: ${cm.specificity.toFixed(3)}  FPR: ${cm.falsePositiveRate.toFixed(3)}  F1: ${cm.f1.toFixed(3)}`,
	];
	return lines.join("\n");
}

// -- Bootstrap Confidence Interval --

export interface BootstrapCI {
	lower: number;
	upper: number;
	mean: number;
}

export function bootstrapCI(
	perScenarioScores: number[],
	nBootstrap = 10_000,
	alpha = 0.05,
): BootstrapCI {
	const n = perScenarioScores.length;
	if (n === 0) return { lower: 0, upper: 0, mean: 0 };

	const means: number[] = [];
	for (let i = 0; i < nBootstrap; i++) {
		let sum = 0;
		for (let j = 0; j < n; j++) {
			sum += perScenarioScores[Math.floor(Math.random() * n)]!;
		}
		means.push(sum / n);
	}
	means.sort((a, b) => a - b);

	const lo = Math.floor((alpha / 2) * nBootstrap);
	const hi = Math.floor((1 - alpha / 2) * nBootstrap);
	const mean = perScenarioScores.reduce((s, v) => s + v, 0) / n;

	return { lower: means[lo]!, upper: means[hi]!, mean };
}

// -- Paired t-test --

export function pairedTTest(
	a: number[],
	b: number[],
): { t: number; p: number } {
	const n = a.length;
	if (n < 2) return { t: 0, p: 1 };

	const diffs = a.map((v, i) => v - (b[i] ?? 0));
	const mean = diffs.reduce((s, d) => s + d, 0) / n;
	const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1);
	const se = Math.sqrt(variance / n);
	if (se === 0) return { t: mean === 0 ? 0 : Infinity, p: mean === 0 ? 1 : 0 };

	const t = mean / se;
	const df = n - 1;

	// One-tailed p-value via t-distribution approximation (Abramowitz & Stegun)
	const x = df / (df + t * t);
	const p = t > 0 ? incompleteBeta(df / 2, 0.5, x) / 2 : 1;
	return { t, p };
}

// Regularized incomplete beta function (continued fraction, sufficient for t-test)
export function incompleteBeta(a: number, b: number, x: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;

	const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b);
	const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);

	// Lentz's continued fraction
	let f = 1,
		c = 1,
		d = 1 - ((a + b) * x) / (a + 1);
	if (Math.abs(d) < 1e-30) d = 1e-30;
	d = 1 / d;
	f = d;

	for (let m = 1; m <= 200; m++) {
		// Even step
		let num = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
		d = 1 + num * d;
		if (Math.abs(d) < 1e-30) d = 1e-30;
		d = 1 / d;
		c = 1 + num / c;
		if (Math.abs(c) < 1e-30) c = 1e-30;
		f *= d * c;

		// Odd step
		num = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
		d = 1 + num * d;
		if (Math.abs(d) < 1e-30) d = 1e-30;
		d = 1 / d;
		c = 1 + num / c;
		if (Math.abs(c) < 1e-30) c = 1e-30;
		const delta = d * c;
		f *= delta;

		if (Math.abs(delta - 1) < 1e-10) break;
	}

	return (front * f) / a;
}

// Log-gamma (Lanczos approximation)
export function lgamma(z: number): number {
	const g = 7;
	const coef = [
		0.99999999999980993, 676.5203681218851, -1259.1392167224028,
		771.32342877765313, -176.61502916214059, 12.507343278686905,
		-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
	];
	if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
	z -= 1;
	let x = coef[0]!;
	for (let i = 1; i < g + 2; i++) x += coef[i]! / (z + i);
	const t = z + g + 0.5;
	return (
		0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
	);
}

export const T_TEST_THRESHOLD = 0.1; // one-tailed p-value

// -- Reward Hacking Detection --

export interface HackingState {
	holdoutPeak: number;
	holdoutPeakGen: number;
	gapHistory: number[]; // train - holdout gap per generation
}

export function detectRewardHacking(
	trainScore: number,
	holdoutScore: number,
	generation: number,
	state: HackingState,
): { hacking: boolean; reason: string } {
	// Update peak tracking
	if (holdoutScore > state.holdoutPeak) {
		state.holdoutPeak = holdoutScore;
		state.holdoutPeakGen = generation;
	}

	const gap = trainScore - holdoutScore;
	state.gapHistory.push(gap);

	// Check 1: holdout dropped > 3% from peak while train improved
	if (state.holdoutPeak - holdoutScore > 0.03) {
		return {
			hacking: true,
			reason: `holdout dropped ${((state.holdoutPeak - holdoutScore) * 100).toFixed(1)}% from peak`,
		};
	}

	// Check 2: gap increasing monotonically over 5 generations
	if (state.gapHistory.length >= 5) {
		const last5 = state.gapHistory.slice(-5);
		let monotonic = true;
		for (let i = 1; i < last5.length; i++) {
			if ((last5[i] ?? 0) <= (last5[i - 1] ?? 0)) {
				monotonic = false;
				break;
			}
		}
		if (monotonic) {
			return {
				hacking: true,
				reason: "train-holdout gap increased monotonically over 5 generations",
			};
		}
	}

	return { hacking: false, reason: "" };
}
