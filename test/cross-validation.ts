// Stratified k-fold cross-validation for phila's speak gate.
// Folds are stratified on expect + difficulty to ensure proportional representation.
//
// Usage (standalone):
//   node --experimental-strip-types test/cross-validation.ts
//   node --experimental-strip-types test/cross-validation.ts --k 5 --runs 3
//
// Also importable by continuous-optimize.ts for periodic validation.

import { parseArgs } from "node:util";
import { buildSystemPrompt, parseDecision } from "../src/gate.ts";
import type { GroupProfile } from "../src/types.ts";
import { GateAction } from "../src/types.ts";
import type { InferenceConfig } from "./inference.ts";
import { infer } from "./inference.ts";
import type { Scenario } from "./scenarios.ts";
import { trainScenarios } from "./scenarios.ts";
import { compositeWeights, scoreResponse } from "./scorer.ts";

// -- Types --

export interface FoldResult {
	fold: number;
	compositeScore: number;
	gateScore: number;
	scenarioCount: number;
	perScenarioScores: Map<string, number[]>; // scenario name -> scores across runs
}

export interface CVResult {
	k: number;
	foldResults: FoldResult[];
	mean: number;
	std: number;
	ci95: [number, number];
	flakyScenarios: FlakyScenario[];
}

export interface FlakyScenario {
	name: string;
	variance: number;
	passRate: number;
}

// -- Stratified K-Fold --

export function stratifiedKFold(
	scenarios: Scenario[],
	k: number,
): Scenario[][] {
	// Group by stratification key: expect + difficulty
	const groups = new Map<string, Scenario[]>();
	for (const s of scenarios) {
		const key = `${s.expect}-${s.difficulty}`;
		const group = groups.get(key) ?? [];
		group.push(s);
		groups.set(key, group);
	}

	// Shuffle each group
	for (const group of groups.values()) {
		for (let i = group.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[group[i], group[j]] = [group[j]!, group[i]!];
		}
	}

	// Distribute round-robin into k folds
	const folds: Scenario[][] = Array.from({ length: k }, () => []);
	for (const group of groups.values()) {
		for (let i = 0; i < group.length; i++) {
			folds[i % k]!.push(group[i]!);
		}
	}

	return folds;
}

async function evaluateFold(
	systemPrompt: string,
	config: InferenceConfig,
	scenarios: Scenario[],
	runs: number,
	ollamaUrl: string,
): Promise<{
	gateScore: number;
	compositeScore: number;
	perScenarioScores: Map<string, number[]>;
}> {
	let correctSilent = 0;
	let correctSpeak = 0;
	let falseSpeak = 0;
	let falseSilent = 0;
	let qualitySum = 0;
	let qualityCount = 0;
	let latencySum = 0;
	let latencyCount = 0;
	const perScenarioScores = new Map<string, number[]>();

	for (const scenario of scenarios) {
		const scores: number[] = [];
		for (let r = 0; r < runs; r++) {
			const start = performance.now();
			try {
				const raw = await infer(
					systemPrompt,
					scenario.conversation,
					config,
					ollamaUrl,
				);
				latencySum += performance.now() - start;
				latencyCount++;
				const decision = parseDecision(raw);

				if (scenario.expect === "silent") {
					if (decision.action === GateAction.SILENT) {
						correctSilent++;
						scores.push(1);
					} else {
						falseSpeak++;
						scores.push(0);
					}
				} else {
					if (decision.action === GateAction.SPEAK) {
						correctSpeak++;
						const breakdown = scoreResponse(decision.response, scenario);
						qualitySum += breakdown.composite;
						qualityCount++;
						scores.push(breakdown.composite);
					} else {
						falseSilent++;
						scores.push(0);
					}
				}
			} catch {
				falseSilent++;
				scores.push(0);
			}
		}
		perScenarioScores.set(scenario.name, scores);
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

	return { gateScore, compositeScore, perScenarioScores };
}

// -- Cross-Validate --

export async function crossValidate(
	systemPrompt: string,
	config: InferenceConfig,
	scenarios: Scenario[],
	k: number,
	runs: number,
	ollamaUrl: string,
): Promise<CVResult> {
	const folds = stratifiedKFold(scenarios, k);
	const foldResults: FoldResult[] = [];
	const allPerScenario = new Map<string, number[]>();

	for (let i = 0; i < k; i++) {
		// Validation fold is folds[i], train is everything else (but we evaluate on validation)
		const valFold = folds[i]!;
		const result = await evaluateFold(
			systemPrompt,
			config,
			valFold,
			runs,
			ollamaUrl,
		);

		foldResults.push({
			fold: i,
			compositeScore: result.compositeScore,
			gateScore: result.gateScore,
			scenarioCount: valFold.length,
			perScenarioScores: result.perScenarioScores,
		});

		// Merge per-scenario scores
		for (const [name, scores] of result.perScenarioScores) {
			const existing = allPerScenario.get(name) ?? [];
			existing.push(...scores);
			allPerScenario.set(name, existing);
		}
	}

	const scores = foldResults.map((f) => f.compositeScore);
	const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
	const variance =
		scores.reduce((s, v) => s + (v - mean) ** 2, 0) / (scores.length - 1);
	const std = Math.sqrt(variance);
	const ci95: [number, number] = [
		mean - (1.96 * std) / Math.sqrt(k),
		mean + (1.96 * std) / Math.sqrt(k),
	];

	// Detect flaky scenarios (variance > 0.25 across runs)
	const flakyScenarios: FlakyScenario[] = [];
	for (const [name, scores] of allPerScenario) {
		if (scores.length < 2) continue;
		const sMean = scores.reduce((a, b) => a + b, 0) / scores.length;
		const sVar =
			scores.reduce((s, v) => s + (v - sMean) ** 2, 0) / (scores.length - 1);
		if (sVar > 0.25) {
			flakyScenarios.push({ name, variance: sVar, passRate: sMean });
		}
	}

	return { k, foldResults, mean, std, ci95, flakyScenarios };
}

// -- CLI --

async function main() {
	const { values: args } = parseArgs({
		options: {
			k: { type: "string", default: "5" },
			runs: { type: "string", default: "3" },
		},
	});

	const k = Number(args.k) || 5;
	const runs = Number(args.runs) || 3;
	const ollamaUrl = process.env.PHILA_OLLAMA_URL ?? "http://localhost:11434";

	const scenarios = trainScenarios();
	const profile: GroupProfile = {
		chatId: "bench",
		speakBias: 0.0,
		updatedAt: Date.now(),
	};
	const systemPrompt = buildSystemPrompt(profile);
	const config: InferenceConfig = {
		model: "llama3.2",
		temperature: 0.1,
		numPredict: 64,
		topP: 0.52,
	};

	console.log(`=== phila cross-validation ===`);
	console.log(
		`k=${k} | runs=${runs} | scenarios=${scenarios.length} (train only)`,
	);
	console.log();

	const result = await crossValidate(
		systemPrompt,
		config,
		scenarios,
		k,
		runs,
		ollamaUrl,
	);

	for (const fold of result.foldResults) {
		console.log(
			`  fold ${fold.fold}: composite=${(fold.compositeScore * 100).toFixed(1)}% gate=${(fold.gateScore * 100).toFixed(1)}% (${fold.scenarioCount} scenarios)`,
		);
	}

	console.log();
	console.log(`mean: ${(result.mean * 100).toFixed(1)}%`);
	console.log(`std:  ${(result.std * 100).toFixed(1)}%`);
	console.log(
		`95% CI: [${(result.ci95[0] * 100).toFixed(1)}%, ${(result.ci95[1] * 100).toFixed(1)}%]`,
	);

	if (result.flakyScenarios.length) {
		console.log();
		console.log(`flaky scenarios (variance > 0.25):`);
		for (const f of result.flakyScenarios) {
			console.log(
				`  ${f.name}: variance=${f.variance.toFixed(2)} passRate=${(f.passRate * 100).toFixed(0)}%`,
			);
		}
	}
}

// Only run CLI when executed directly (not when imported)
if (process.argv[1]?.endsWith("cross-validation.ts")) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
