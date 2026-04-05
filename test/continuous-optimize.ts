// Continuous optimization loop for phila's speak gate.
// Runs indefinitely on VPS, generating mutations, testing them, keeping improvements.
// Designed for overnight/multi-day runs. Graceful shutdown on SIGINT/SIGTERM.
//
// Scoring: auto-rebalancing composite of weighted gate accuracy (3:1 silence bias),
// 5-dimension response quality, and latency. Paired t-test for significance.
// Reward hacking detection via train/holdout divergence.
//
// Usage:
//   node --experimental-strip-types test/continuous-optimize.ts
//   node --experimental-strip-types test/continuous-optimize.ts --runs 5
//   node --experimental-strip-types test/continuous-optimize.ts --generations 50
//   node --experimental-strip-types test/continuous-optimize.ts --checkpoint test/checkpoint.json

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildSystemPrompt } from "../src/gate.ts";
import type { GroupProfile } from "../src/types.ts";
import type { CVResult } from "./cross-validation.ts";
import { crossValidate } from "./cross-validation.ts";
import type { EvalResult, HackingState } from "./eval-shared.ts";
import {
	detectRewardHacking,
	evaluate,
	pairedTTest,
	T_TEST_THRESHOLD,
} from "./eval-shared.ts";
import type { InferenceConfig } from "./inference.ts";
import { holdoutScenarios, trainScenarios } from "./scenarios.ts";
import { compositeWeights } from "./scorer.ts";

// -- CLI --

const { values: args } = parseArgs({
	options: {
		runs: { type: "string", default: "5" },
		generations: { type: "string", default: "0" },
		checkpoint: { type: "string", default: "test/checkpoint.json" },
		"cv-interval": { type: "string", default: "10" },
		"no-cv": { type: "boolean", default: false },
		model: { type: "string" }, // restrict to a single model (e.g. --model llama3.2)
	},
});

const BASE_URL = process.env.PHILA_OLLAMA_URL ?? "http://localhost:11434";
const RUNS = Number(args.runs) || 5;
const MAX_GENERATIONS = Number(args.generations) || 0; // 0 = infinite
const CHECKPOINT_PATH = args.checkpoint!;
const CV_INTERVAL = Number(args["cv-interval"]) || 10;
const CV_ENABLED = !args["no-cv"];
const MODEL_FILTER = args.model ?? null;

// -- Scenarios --

const train = trainScenarios();
const holdout = holdoutScenarios();

// -- Mutation Dimension Registry --

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}

function roundTo(v: number, decimals: number): number {
	const f = 10 ** decimals;
	return Math.round(v * f) / f;
}

function pickRandom<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]!;
}

interface TrialState {
	config: InferenceConfig;
	prompt: string;
	mutationLabels: string[];
}

interface MutationDimension {
	name: string;
	weight: number; // relative selection probability
	apply: (state: TrialState, ctx: MutationContext) => void;
}

interface MutationContext {
	basePrompt: string;
	models: string[];
}

// -- Param Dimensions --

const PARAM_DIMENSIONS: MutationDimension[] = [
	{
		name: "temperature",
		weight: 3,
		apply(state) {
			state.config.temperature = roundTo(
				clamp(state.config.temperature + (Math.random() - 0.5) * 0.15, 0, 0.5),
				2,
			);
			state.mutationLabels.push(`t=${state.config.temperature}`);
		},
	},
	{
		name: "topP",
		weight: 2,
		apply(state) {
			state.config.topP = roundTo(
				clamp(state.config.topP + (Math.random() - 0.5) * 0.3, 0.1, 1.0),
				2,
			);
			state.mutationLabels.push(`tp=${state.config.topP}`);
		},
	},
	{
		name: "numPredict",
		weight: 2,
		apply(state) {
			const deltas = [-32, -16, 16, 32, 64];
			state.config.numPredict = clamp(
				state.config.numPredict + pickRandom(deltas),
				32,
				256,
			);
			state.mutationLabels.push(`np=${state.config.numPredict}`);
		},
	},
	{
		name: "repeatPenalty",
		weight: 1,
		apply(state) {
			state.config.repeatPenalty = roundTo(0.9 + Math.random() * 0.4, 2); // 0.9-1.3
			state.mutationLabels.push(`rp=${state.config.repeatPenalty}`);
		},
	},
	{
		name: "mirostat",
		weight: 1,
		apply(state) {
			// mirostat 0=off, 1=v1, 2=v2
			const mode = pickRandom([0, 1, 2]);
			state.config.mirostat = mode;
			if (mode > 0) {
				state.config.mirostatTau = roundTo(
					2.0 + (Math.random() - 0.5) * 3.0,
					1,
				); // 0.5-3.5
				state.config.mirostatEta = roundTo(0.05 + Math.random() * 0.2, 2); // 0.05-0.25
				state.mutationLabels.push(
					`miro=${mode} tau=${state.config.mirostatTau} eta=${state.config.mirostatEta}`,
				);
			} else {
				state.config.mirostat = undefined;
				state.config.mirostatTau = undefined;
				state.config.mirostatEta = undefined;
				state.mutationLabels.push("miro=off");
			}
		},
	},
	{
		name: "model",
		weight: 1,
		apply(state, ctx) {
			const others = ctx.models.filter((m) => m !== state.config.model);
			if (others.length) {
				state.config.model = pickRandom(others);
				state.mutationLabels.push(`m=${state.config.model}`);
			}
		},
	},
];

// -- Prompt Dimensions --

const PROMPT_DIMENSIONS: MutationDimension[] = [
	{
		name: "extra-examples",
		weight: 2,
		apply(state) {
			state.prompt = state.prompt.replace(
				'correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}',
				`correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

EXAMPLE of rule 1 - direct address:
person1: hey phila, whats the tallest mountain?
correct response: {"action":"speak","reason":"direct question","response":"mount everest, about 8849 meters"}

EXAMPLE of staying silent:
person1: i had such a bad day
person2: oh no what happened
correct response: {"action":"silent"}`,
			);
			state.mutationLabels.push("extra-examples");
		},
	},
	{
		name: "silence-emphasis",
		weight: 2,
		apply(state) {
			const variants = [
				"your default is ABSOLUTE silence. you almost never speak. only rules 1 and 2 override this.",
				"your default is silence. you speak ONLY for rules 1, 2, and 3. nothing else. ever.",
				"SILENCE is your natural state. speaking requires explicit justification via rules 1-3.",
			];
			state.prompt = state.prompt.replace(
				"your default is silence - you only speak when it matters.",
				pickRandom(variants),
			);
			state.mutationLabels.push("silence-emphasis");
		},
	},
	{
		name: "phila-detection",
		weight: 2,
		apply(state) {
			const variants = [
				'1. someone mentions your name "phila" in ANY context (greeting, question, request) -> ALWAYS respond',
				'1. someone says your name "phila" in ANY context (question, greeting, request) -> you MUST respond',
				'1. your name "phila" appears in ANY message -> respond to whoever said it',
			];
			state.prompt = state.prompt.replace(
				'1. someone says "phila" anywhere in a message (greeting, question, request) -> respond. even if combined with emoji or punctuation.',
				pickRandom(variants),
			);
			state.mutationLabels.push("phila-detection");
		},
	},
	{
		name: "compressed-silence",
		weight: 1,
		apply(state) {
			const variants = [
				"- everything except rules 1, 2, and 3 above",
				`- anything that isnt rules 1/2/3
- especially: small talk, emotions, jokes, opinions, gossip, rhetorical questions
- if someone already answered correctly: stay silent`,
			];
			state.prompt = state.prompt.replace(
				`- small talk between others
- emotions, venting, celebrating
- jokes, banter, memes, sarcasm (even if they contain wrong facts)
- opinions, preferences, debates
- gossip, drama, personal stories
- someone already corrected the error (look for "actually", "no", "thats not right")
- rhetorical questions`,
				pickRandom(variants),
			);
			state.mutationLabels.push("compressed-silence");
		},
	},
	{
		name: "json-format",
		weight: 1,
		apply(state) {
			const variants = [
				"CRITICAL: respond with ONLY valid json. no explanation, no markdown, just the json object:",
				"OUTPUT: exactly one json object, nothing else. no text before or after:",
			];
			state.prompt = state.prompt.replace(
				"respond with ONLY json, no other text:",
				pickRandom(variants),
			);
			state.mutationLabels.push("json-format");
		},
	},
	{
		name: "speak-triggers",
		weight: 2,
		apply(state) {
			state.prompt = state.prompt.replace(
				"3. a factual question goes unanswered by others -> answer it",
				"3. a factual question goes unanswered by others -> ALWAYS answer it. if you know the answer, speak up.",
			);
			state.mutationLabels.push("speak-triggers");
		},
	},
	{
		name: "response-style",
		weight: 2,
		apply(state) {
			const variants = [
				'style: lowercase, BRIEF (under 60 chars ideal), casual like texting a friend. never say "great question", "happy to help", "certainly", or anything an AI assistant would say. sound human.',
				"style: lowercase, max 1 sentence, like a group chat message. no formal language ever.",
				"style: lowercase, short, casual. respond like a friend texting. no AI-sounding phrases.",
			];
			state.prompt = state.prompt.replace(
				'style: lowercase, 1-2 sentences, casual like a friend. no "great question" or "happy to help".',
				pickRandom(variants),
			);
			state.mutationLabels.push("response-style");
		},
	},
	{
		name: "correction-format",
		weight: 1,
		apply(state) {
			state.prompt = state.prompt.replace(
				'correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}',
				'correct response: {"action":"speak","reason":"wrong fact","response":"nah the great wall is in china not japan"}',
			);
			state.mutationLabels.push("correction-format");
		},
	},
	{
		name: "rule-ordering",
		weight: 1,
		apply(state) {
			state.prompt = state.prompt.replace(
				`ALWAYS SPEAK (these override silence):
1. someone says "phila" anywhere in a message (greeting, question, request) -> respond. even if combined with emoji or punctuation.
2. someone states a wrong fact (wrong date, wrong name, wrong number) and nobody corrects them -> correct it
   BUT if someone already corrected it (said "actually", "no its", "thats not right", etc.) -> STAY SILENT
3. a factual question goes unanswered by others -> answer it`,
				`ALWAYS SPEAK (these override silence):
1. someone states a WRONG FACT (wrong date, wrong name, wrong number) and nobody corrects them -> you MUST correct it briefly
   BUT if someone already corrected it (said "actually", "no its", "thats not right", etc.) -> STAY SILENT
2. someone says "phila" anywhere in a message (greeting, question, request) -> respond. even if combined with emoji or punctuation.
3. a factual question goes unanswered by others -> answer it`,
			);
			state.mutationLabels.push("rule-ordering");
		},
	},
];

// -- Dimension Selection --

const _ALL_DIMENSIONS = [...PARAM_DIMENSIONS, ...PROMPT_DIMENSIONS];

function selectDimension(dims: MutationDimension[]): MutationDimension {
	const totalWeight = dims.reduce((s, d) => s + d.weight, 0);
	let roll = Math.random() * totalWeight;
	for (const dim of dims) {
		roll -= dim.weight;
		if (roll <= 0) return dim;
	}
	return dims[dims.length - 1]!;
}

function applyPromptDimension(
	state: TrialState,
	ctx: MutationContext,
): boolean {
	const before = state.prompt;
	selectDimension(PROMPT_DIMENSIONS).apply(state, ctx);
	if (state.prompt === before) {
		state.mutationLabels.pop(); // no-op, remove label
		return false;
	}
	return true;
}

function mutate(
	baseConfig: InferenceConfig,
	basePrompt: string,
	models: string[],
): TrialState {
	const state: TrialState = {
		config: { ...baseConfig },
		prompt: basePrompt,
		mutationLabels: [],
	};
	const ctx: MutationContext = { basePrompt, models };

	// 50% param-only, 30% prompt-only, 20% both
	const roll = Math.random();
	if (roll < 0.5) {
		selectDimension(PARAM_DIMENSIONS).apply(state, ctx);
	} else if (roll < 0.8) {
		// If prompt mutation was a no-op (target string not in prompt), fall back to param
		if (!applyPromptDimension(state, ctx)) {
			selectDimension(PARAM_DIMENSIONS).apply(state, ctx);
		} else if (Math.random() < 0.3) {
			// 30% chance of stacking a second prompt mutation
			applyPromptDimension(state, ctx);
		}
	} else {
		selectDimension(PARAM_DIMENSIONS).apply(state, ctx);
		applyPromptDimension(state, ctx); // no-op is fine here, param mutation already applied
	}

	return state;
}

// -- Available Models --

async function getAvailableModels(): Promise<string[]> {
	try {
		const res = await fetch(`${BASE_URL}/api/tags`);
		const data = (await res.json()) as { models: { name: string }[] };
		return data.models.map((m) => m.name);
	} catch {
		return ["llama3.2"];
	}
}

// -- Checkpoint --

interface Checkpoint {
	generation: number;
	bestScore: number;
	bestConfig: InferenceConfig;
	bestPromptIndex: number | null;
	holdoutScores: number[];
	hackingState: HackingState;
	history: GenerationResult[];
	cvResults: CVResult[];
	startedAt: string;
	lastUpdated: string;
}

interface GenerationResult {
	generation: number;
	timestamp: string;
	mutationType: string;
	config: InferenceConfig;
	result: EvalResult;
	holdoutResult?: EvalResult;
	kept: boolean;
}

function loadCheckpoint(): Checkpoint | null {
	if (!existsSync(CHECKPOINT_PATH)) return null;
	try {
		const cp = JSON.parse(readFileSync(CHECKPOINT_PATH, "utf-8")) as Checkpoint;
		// Backward compat: old checkpoints may lack newer fields
		cp.cvResults = cp.cvResults ?? [];
		cp.holdoutScores = cp.holdoutScores ?? [];
		cp.hackingState = cp.hackingState ?? {
			holdoutPeak: 0,
			holdoutPeakGen: 0,
			gapHistory: [],
		};
		cp.history = cp.history ?? [];
		return cp;
	} catch {
		return null;
	}
}

function saveCheckpoint(cp: Checkpoint): void {
	cp.lastUpdated = new Date().toISOString();
	writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

// -- Main --

let running = true;
process.on("SIGINT", () => {
	running = false;
	console.log("\nshutting down after current trial...");
});
process.on("SIGTERM", () => {
	running = false;
	console.log("\nshutting down after current trial...");
});

async function main() {
	const profile: GroupProfile = {
		chatId: "bench",
		speakBias: 0.0,
		updatedAt: Date.now(),
	};
	const basePrompt = buildSystemPrompt(profile);
	const models = MODEL_FILTER ? [MODEL_FILTER] : await getAvailableModels();

	const allScenarios = [...train, ...holdout];
	console.log("=== phila continuous optimizer ===");
	console.log(`models: ${models.join(", ")}`);
	console.log(
		`scenarios: ${allScenarios.length} total (${train.length} train, ${holdout.length} holdout)`,
	);
	console.log(
		`  train: ${train.filter((s) => s.expect === "silent").length} silent, ${train.filter((s) => s.expect === "speak").length} speak`,
	);
	console.log(
		`  holdout: ${holdout.filter((s) => s.expect === "silent").length} silent, ${holdout.filter((s) => s.expect === "speak").length} speak`,
	);
	console.log(`runs per eval: ${RUNS}`);
	console.log(`max generations: ${MAX_GENERATIONS || "infinite"}`);
	console.log(
		`scoring: auto-rebalancing (gate>=99%: 40/45/15, else: 70/20/10)`,
	);
	console.log(`significance: paired t-test, p < ${T_TEST_THRESHOLD}`);
	console.log(`checkpoint: ${CHECKPOINT_PATH}`);
	console.log(
		`cross-validation: ${CV_ENABLED ? `every ${CV_INTERVAL} generations (k=5)` : "disabled"}`,
	);
	console.log();

	// Load or create checkpoint
	let cp = loadCheckpoint();
	let bestConfig: InferenceConfig;
	let bestPrompt: string;
	let generation: number;
	let baselinePerScenario: number[] | null = null;

	if (cp) {
		console.log(
			`resuming from generation ${cp.generation}, best score: ${(cp.bestScore * 100).toFixed(1)}%`,
		);
		bestConfig = cp.bestConfig;
		bestPrompt = basePrompt; // prompt mutations are applied fresh each generation
		generation = cp.generation;
	} else {
		bestConfig = {
			model: MODEL_FILTER ?? "llama3.2",
			temperature: 0.1,
			numPredict: 64,
			topP: 0.52,
		};

		console.log("--- baseline (train) ---");
		const baseline = await evaluate(
			basePrompt,
			bestConfig,
			train,
			RUNS,
			BASE_URL,
		);
		printResult(baseline);

		console.log("--- baseline (holdout) ---");
		const holdoutBaseline = await evaluate(
			basePrompt,
			bestConfig,
			holdout,
			RUNS,
			BASE_URL,
		);
		printResult(holdoutBaseline);

		baselinePerScenario = baseline.perScenarioScores;

		bestPrompt = basePrompt;
		generation = 0;
		cp = {
			generation: 0,
			bestScore: baseline.compositeScore,
			bestConfig,
			bestPromptIndex: null,
			holdoutScores: [holdoutBaseline.compositeScore],
			hackingState: {
				holdoutPeak: holdoutBaseline.compositeScore,
				holdoutPeakGen: 0,
				gapHistory: [baseline.compositeScore - holdoutBaseline.compositeScore],
			},
			history: [
				{
					generation: 0,
					timestamp: new Date().toISOString(),
					mutationType: "baseline",
					config: bestConfig,
					result: baseline,
					holdoutResult: holdoutBaseline,
					kept: true,
				},
			],
			cvResults: [],
			startedAt: new Date().toISOString(),
			lastUpdated: new Date().toISOString(),
		};
		saveCheckpoint(cp);
		console.log();
	}

	// Continuous loop
	while (running && (MAX_GENERATIONS === 0 || generation < MAX_GENERATIONS)) {
		generation++;

		// Select and apply mutations via dimension registry
		const trial = mutate(bestConfig, basePrompt, models);
		const trialConfig = trial.config;
		const trialPrompt = trial.prompt;
		const mutationType = trial.mutationLabels.join(" + ") || "no-op";

		console.log(`--- gen ${generation} [${mutationType}] ---`);

		try {
			const trainResult = await evaluate(
				trialPrompt,
				trialConfig,
				train,
				RUNS,
				BASE_URL,
			);
			const holdoutResult = await evaluate(
				trialPrompt,
				trialConfig,
				holdout,
				RUNS,
				BASE_URL,
			);

			printResult(trainResult);
			console.log(
				`  holdout: ${(holdoutResult.compositeScore * 100).toFixed(1)}%`,
			);

			// Paired t-test: is the improvement statistically significant?
			if (!baselinePerScenario) {
				// Resuming from checkpoint - accept based on score comparison only
				baselinePerScenario = trainResult.perScenarioScores;
			}

			const { t, p } = pairedTTest(
				trainResult.perScenarioScores,
				baselinePerScenario,
			);
			const significant =
				p < T_TEST_THRESHOLD && trainResult.compositeScore > cp.bestScore;

			// Reward hacking detection
			const hackCheck = detectRewardHacking(
				trainResult.compositeScore,
				holdoutResult.compositeScore,
				generation,
				cp.hackingState,
			);

			if (hackCheck.hacking) {
				console.log(`  REWARD HACKING DETECTED: ${hackCheck.reason}`);
				console.log(`  reverting to gen ${cp.hackingState.holdoutPeakGen}`);
				// Reset gap history
				cp.hackingState.gapHistory = [];
			} else if (significant) {
				console.log(
					`  >>> IMPROVEMENT <<< (t=${t.toFixed(2)}, p=${p.toFixed(3)})`,
				);
				cp.bestScore = trainResult.compositeScore;
				cp.bestConfig = trialConfig;
				bestConfig = trialConfig;
				bestPrompt = trialPrompt;
				baselinePerScenario = trainResult.perScenarioScores;
				if (trialPrompt !== basePrompt) cp.bestPromptIndex = generation;
			} else {
				console.log(
					`  no significant improvement (best: ${(cp.bestScore * 100).toFixed(1)}%, t=${t.toFixed(2)}, p=${p.toFixed(3)})`,
				);
			}

			cp.generation = generation;
			cp.holdoutScores.push(holdoutResult.compositeScore);
			cp.history.push({
				generation,
				timestamp: new Date().toISOString(),
				mutationType,
				config: trialConfig,
				result: trainResult,
				holdoutResult,
				kept: significant && !hackCheck.hacking,
			});

			if (cp.history.length > 200) cp.history = cp.history.slice(-200);
			saveCheckpoint(cp);
		} catch (e) {
			console.log(`  ERROR: ${e instanceof Error ? e.message : e}`);
		}

		console.log();

		// Periodic cross-validation checkpoint
		if (CV_ENABLED && generation % CV_INTERVAL === 0) {
			console.log(`--- cross-validation (gen ${generation}) ---`);
			try {
				const cvResult = await crossValidate(
					bestPrompt,
					bestConfig,
					train,
					5,
					RUNS,
					BASE_URL,
				);
				console.log(
					`  CV mean: ${(cvResult.mean * 100).toFixed(1)}% +/- ${(cvResult.std * 100).toFixed(1)}%`,
				);
				console.log(
					`  95% CI: [${(cvResult.ci95[0] * 100).toFixed(1)}%, ${(cvResult.ci95[1] * 100).toFixed(1)}%]`,
				);
				if (cvResult.flakyScenarios.length) {
					console.log(
						`  flaky: ${cvResult.flakyScenarios.map((f) => f.name).join(", ")}`,
					);
				}
				cp.cvResults = cp.cvResults ?? [];
				cp.cvResults.push(cvResult);
				saveCheckpoint(cp);
			} catch (e) {
				console.log(`  CV ERROR: ${e instanceof Error ? e.message : e}`);
			}
			console.log();
		}

		if (generation % 10 === 0) {
			const newModels = await getAvailableModels();
			if (newModels.length !== models.length) {
				console.log(`models updated: ${newModels.join(", ")}`);
				models.length = 0;
				models.push(...newModels);
			}
		}
	}

	console.log();
	console.log("=== final summary ===");
	console.log(`generations: ${generation}`);
	console.log(`best composite: ${(cp.bestScore * 100).toFixed(1)}%`);
	console.log(`best config: ${JSON.stringify(cp.bestConfig)}`);
	console.log(
		`improvements: ${cp.history.filter((h) => h.kept).length}/${cp.history.length}`,
	);
	if (cp.holdoutScores.length) {
		const lastHoldout = cp.holdoutScores[cp.holdoutScores.length - 1]!;
		console.log(
			`holdout final: ${(lastHoldout * 100).toFixed(1)}% (peak: ${(cp.hackingState.holdoutPeak * 100).toFixed(1)}%)`,
		);
	}
	console.log(`checkpoint saved: ${CHECKPOINT_PATH}`);
}

function printResult(r: EvalResult): void {
	const w = compositeWeights(r.gateScore);
	console.log(
		`  composite: ${(r.compositeScore * 100).toFixed(1)}% | gate: ${(r.gateScore * 100).toFixed(1)}% | quality: ${(r.responseQuality * 100).toFixed(1)}% | latency: ${r.avgLatencyMs}ms (${(r.latencyScore * 100).toFixed(0)}%)`,
	);
	console.log(
		`  weights: ${(w.gate * 100).toFixed(0)}/${(w.quality * 100).toFixed(0)}/${(w.latency * 100).toFixed(0)} | correct: ${r.correctSilent}s ${r.correctSpeak}sp | errors: ${r.falseSpeak} false-speak (3x) ${r.falseSilent} false-silent`,
	);
	if (r.details.length)
		console.log(
			`  ${r.details.slice(0, 5).join(", ")}${r.details.length > 5 ? ` (+${r.details.length - 5} more)` : ""}`,
		);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
