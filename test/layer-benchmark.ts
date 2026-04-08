// Layer experiment: progressively add worked examples to the prompt.
// Tests 5 layers (0-4), each adding more examples, to find the sweet spot.
//
// Usage:
//   node --experimental-strip-types test/layer-benchmark.ts
//   node --experimental-strip-types test/layer-benchmark.ts --runs 3 --ollama-url http://localhost:11434
//   node --experimental-strip-types test/layer-benchmark.ts --model phila-ft-v5

import { parseArgs } from "node:util";
import { parseDecision } from "../src/gate.ts";
import { type BootstrapCI, bootstrapCI } from "./eval-shared.ts";
import type { InferenceConfig } from "./inference.ts";
import { infer } from "./inference.ts";
import {
	SCENARIOS as BUILTIN_SCENARIOS,
	holdoutScenarios,
} from "./scenarios.ts";

const { values: args } = parseArgs({
	options: {
		runs: { type: "string", default: "3" },
		model: { type: "string", default: "phila-ft-v5" },
		"ollama-url": { type: "string", default: "http://127.0.0.1:11434" },
		"holdout-only": { type: "boolean", default: false },
	},
});

const RUNS = Number(args.runs);
const MODEL = args.model!;
const OLLAMA_URL = args["ollama-url"]!;
const HOLDOUT_ONLY = args["holdout-only"];

// -- Layer definitions --
// Each layer adds more worked examples to the base prompt.
// Layer 0 = original 3 examples (rule 1, rule 2, rule 3)
// Layer 1 = +2 (gen 46 winner: extra direct address + silence example)
// Layer 2 = +2 (already corrected + rhetorical)
// Layer 3 = +2 (near-miss phila name + sarcastic wrong fact)
// Layer 4 = +2 (multi-person silence + unanswered directed question)

const LAYER_EXAMPLES = [
	// Layer 0: no extras (base prompt has 3 examples already)
	[],

	// Layer 1: gen 46 winner
	[
		`EXAMPLE of rule 1 - direct address:
person1: hey phila, whats the tallest mountain?
correct response: {"action":"speak","reason":"direct question","response":"mount everest, about 8849 meters"}`,

		`EXAMPLE of staying silent:
person1: i had such a bad day
person2: oh no what happened
correct response: {"action":"silent"}`,
	],

	// Layer 2: correction already handled + rhetorical
	[
		`EXAMPLE of rule 1 - direct address:
person1: hey phila, whats the tallest mountain?
correct response: {"action":"speak","reason":"direct question","response":"mount everest, about 8849 meters"}`,

		`EXAMPLE of staying silent:
person1: i had such a bad day
person2: oh no what happened
correct response: {"action":"silent"}`,

		`EXAMPLE of already corrected (STAY SILENT):
person1: einstein invented the lightbulb
person2: no thats edison lol
correct response: {"action":"silent"}`,

		`EXAMPLE of rhetorical question (STAY SILENT):
person1: who even does that??
person2: right like why would anyone
correct response: {"action":"silent"}`,
	],

	// Layer 3: near-miss name + sarcastic
	[
		`EXAMPLE of rule 1 - direct address:
person1: hey phila, whats the tallest mountain?
correct response: {"action":"speak","reason":"direct question","response":"mount everest, about 8849 meters"}`,

		`EXAMPLE of staying silent:
person1: i had such a bad day
person2: oh no what happened
correct response: {"action":"silent"}`,

		`EXAMPLE of already corrected (STAY SILENT):
person1: einstein invented the lightbulb
person2: no thats edison lol
correct response: {"action":"silent"}`,

		`EXAMPLE of rhetorical question (STAY SILENT):
person1: who even does that??
person2: right like why would anyone
correct response: {"action":"silent"}`,

		`EXAMPLE of near-miss name (STAY SILENT):
person1: have you tried the phila cream cheese?
person2: yeah its pretty good
correct response: {"action":"silent"}`,

		`EXAMPLE of sarcasm with wrong fact (STAY SILENT):
person1: yeah and the moon is made of cheese lmao
person2: haha totally
correct response: {"action":"silent"}`,
	],

	// Layer 4: group chat noise + directed question
	[
		`EXAMPLE of rule 1 - direct address:
person1: hey phila, whats the tallest mountain?
correct response: {"action":"speak","reason":"direct question","response":"mount everest, about 8849 meters"}`,

		`EXAMPLE of staying silent:
person1: i had such a bad day
person2: oh no what happened
correct response: {"action":"silent"}`,

		`EXAMPLE of already corrected (STAY SILENT):
person1: einstein invented the lightbulb
person2: no thats edison lol
correct response: {"action":"silent"}`,

		`EXAMPLE of rhetorical question (STAY SILENT):
person1: who even does that??
person2: right like why would anyone
correct response: {"action":"silent"}`,

		`EXAMPLE of near-miss name (STAY SILENT):
person1: have you tried the phila cream cheese?
person2: yeah its pretty good
correct response: {"action":"silent"}`,

		`EXAMPLE of sarcasm with wrong fact (STAY SILENT):
person1: yeah and the moon is made of cheese lmao
person2: haha totally
correct response: {"action":"silent"}`,

		`EXAMPLE of group banter (STAY SILENT):
person1: that movie was insane
person2: the ending though
person3: no spoilers!!
correct response: {"action":"silent"}`,

		`EXAMPLE of question directed at someone (STAY SILENT):
person1: hey person2 did you finish the report?
person2: almost done
correct response: {"action":"silent"}`,
	],
];

function buildLayerPrompt(layer: number): string {
	const extras = LAYER_EXAMPLES[layer];
	const extraBlock = extras.length > 0 ? `\n\n${extras.join("\n\n")}\n` : "";

	return `you are phila, a member of a group chat. your name is phila.
your default is silence - you only speak when it matters.

ALWAYS SPEAK (these override silence):
1. someone says "phila" anywhere in a message (greeting, question, request) -> respond. even if combined with emoji or punctuation.
2. someone states a wrong fact (wrong date, wrong name, wrong number) and nobody corrects them -> correct it
   BUT if someone already corrected it (said "actually", "no its", "thats not right", etc.) -> STAY SILENT
3. a factual question goes unanswered by others -> answer it

EXAMPLE of rule 1:
person1: hey phila how are you
correct response: {"action":"speak","reason":"direct address","response":"doing good, whats up"}

EXAMPLE of rule 2:
person1: the great wall of china is in japan
person2: yeah i think so
correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

EXAMPLE of rule 3:
person1: whats the tallest mountain in the world?
person2: idk
correct response: {"action":"speak","reason":"unanswered question","response":"mount everest, 8849 meters"}
${extraBlock}
STAY SILENT for everything else. examples:
- small talk between others
- emotions, venting, celebrating
- jokes, banter, memes, sarcasm (even if they contain wrong facts)
- opinions, preferences, debates
- gossip, drama, personal stories
- someone already corrected the error (look for "actually", "no", "thats not right")
- rhetorical questions

style: lowercase, 1-2 sentences, casual like a friend. no "great question" or "happy to help".

respond with ONLY json, no other text:
{"action":"silent"}
or
{"action":"speak","reason":"why","response":"your message"}

optionally request tools by adding a "tools" field:
{"action":"silent","tools":["recall"]} - search memory before deciding (use when someone asks about something discussed earlier)
{"action":"speak","reason":"wrong fact","response":"...","tools":["verify"]} - verify a factual claim before sending

only request tools when actually needed. most responses need no tools.`;
}

// -- Evaluation --

interface LayerResult {
	layer: number;
	exampleCount: number;
	accuracy: number;
	holdoutAccuracy: number;
	holdoutCI: BootstrapCI;
	gateScore: number;
	falseSpeak: number;
	falseSilent: number;
	avgLatencyMs: number;
	promptLength: number;
}

async function evaluateLayer(layer: number): Promise<LayerResult> {
	const prompt = buildLayerPrompt(layer);
	const config: InferenceConfig = {
		model: MODEL,
		temperature: 0.1,
		numPredict: 64,
		topP: 0.52,
	};

	const scenarios = HOLDOUT_ONLY
		? holdoutScenarios()
		: [
				...BUILTIN_SCENARIOS.filter((s) => s.split === "train"),
				...holdoutScenarios(),
			];
	const holdout = holdoutScenarios();
	const holdoutNames = new Set(holdout.map((s) => s.name));

	let correct = 0;
	let total = 0;
	let falseSpeak = 0;
	let falseSilent = 0;
	let totalLatency = 0;
	let latencyCount = 0;

	// Per-scenario holdout results for bootstrap
	const holdoutScoreMap = new Map<string, number[]>();

	for (const scenario of scenarios) {
		const isHoldout = holdoutNames.has(scenario.name);
		let scenarioCorrect = 0;

		for (let r = 0; r < RUNS; r++) {
			const start = Date.now();
			const raw = await infer(
				prompt,
				scenario.conversation,
				config,
				OLLAMA_URL,
			);
			const elapsed = Date.now() - start;
			totalLatency += elapsed;
			latencyCount++;

			const decision = parseDecision(raw);
			const predicted = decision.action;
			const expected = scenario.expect;
			const isCorrect = predicted === expected;

			if (isCorrect) {
				correct++;
				scenarioCorrect++;
			} else if (predicted === "speak" && expected === "silent") {
				falseSpeak++;
			} else {
				falseSilent++;
			}
			total++;
		}

		if (isHoldout) {
			const score = scenarioCorrect / RUNS;
			if (!holdoutScoreMap.has(scenario.name))
				holdoutScoreMap.set(scenario.name, []);
			holdoutScoreMap.get(scenario.name)!.push(score);
		}

		const pct = ((scenarioCorrect / RUNS) * 100).toFixed(0);
		const tag = isHoldout ? " (holdout)" : "";
		process.stdout.write(
			`  [${pct === "100" ? "OK" : `${pct}%`}] ${scenario.name}${tag}\n`,
		);
	}

	// Bootstrap CI on holdout
	const holdoutPerScenario = Array.from(holdoutScoreMap.values()).map(
		(scores) => scores.reduce((a, b) => a + b, 0) / scores.length,
	);
	const holdoutAcc =
		holdoutPerScenario.length > 0
			? holdoutPerScenario.reduce((a, b) => a + b, 0) /
				holdoutPerScenario.length
			: 0;
	const ci = bootstrapCI(holdoutPerScenario);

	return {
		layer,
		exampleCount: 3 + LAYER_EXAMPLES[layer].length, // 3 base + extras
		accuracy: total > 0 ? correct / total : 0,
		holdoutAccuracy: holdoutAcc,
		holdoutCI: ci,
		gateScore: total > 0 ? correct / total : 0,
		falseSpeak,
		falseSilent,
		avgLatencyMs: latencyCount > 0 ? totalLatency / latencyCount : 0,
		promptLength: prompt.length,
	};
}

async function main() {
	console.log("=== phila layer benchmark ===");
	console.log(`model: ${MODEL} | runs: ${RUNS} | url: ${OLLAMA_URL}`);
	console.log(
		`layers: 0-${LAYER_EXAMPLES.length - 1} (${LAYER_EXAMPLES.map((l, i) => `L${i}=${3 + l.length}ex`).join(", ")})`,
	);
	console.log();

	const results: LayerResult[] = [];

	for (let layer = 0; layer < LAYER_EXAMPLES.length; layer++) {
		console.log(
			`\n--- Layer ${layer} (${3 + LAYER_EXAMPLES[layer].length} examples, ${buildLayerPrompt(layer).length} chars) ---`,
		);
		const result = await evaluateLayer(layer);
		results.push(result);

		console.log(
			`  accuracy: ${(result.accuracy * 100).toFixed(1)}% | holdout: ${(result.holdoutAccuracy * 100).toFixed(1)}% [${(result.holdoutCI.lower * 100).toFixed(1)}%, ${(result.holdoutCI.upper * 100).toFixed(1)}%]`,
		);
		console.log(
			`  false-speak: ${result.falseSpeak} | false-silent: ${result.falseSilent} | latency: ${result.avgLatencyMs.toFixed(0)}ms | prompt: ${result.promptLength} chars`,
		);
	}

	// Summary table
	console.log("\n\n=== LAYER COMPARISON ===");
	console.log(
		"Layer | Examples | Prompt | Holdout Acc | 95% CI          | F-Speak | F-Silent | Latency",
	);
	console.log(
		"------|----------|--------|-------------|-----------------|---------|----------|--------",
	);
	for (const r of results) {
		console.log(
			`  ${r.layer}   |    ${String(r.exampleCount).padStart(2)}    | ${String(r.promptLength).padStart(5)}  | ${(r.holdoutAccuracy * 100).toFixed(1).padStart(10)}% | [${(r.holdoutCI.lower * 100).toFixed(1)}%, ${(r.holdoutCI.upper * 100).toFixed(1)}%] | ${String(r.falseSpeak).padStart(7)} | ${String(r.falseSilent).padStart(8)} | ${r.avgLatencyMs.toFixed(0).padStart(5)}ms`,
		);
	}

	// Write results JSON
	const outPath = `/root/v5-campaign-results/layer-benchmark-${Date.now()}.json`;
	try {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			outPath,
			JSON.stringify(
				{ model: MODEL, runs: RUNS, url: OLLAMA_URL, results },
				null,
				2,
			),
		);
		console.log(`\nResults written to ${outPath}`);
	} catch {
		// Local machine might not have /root
		console.log("\nResults not written (no write access to results dir)");
	}
}

main().catch(console.error);
