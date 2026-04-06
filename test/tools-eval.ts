// Evaluation script for v4 tools-specific behaviors.
//
// Tests three behaviors that ft-v4 is trained to handle:
//   1. Recall tool: emit tools:["recall"] when someone references prior conversation
//   2. Verify tool: emit tools:["verify"] on wrong-fact corrections
//   3. Tools false-positive: do NOT emit any tools on social/general scenarios
//
// Success criteria (aligned with spec):
//   - Recall trigger rate >= 70%
//   - Verify trigger rate >= 80%
//   - Tools false positive rate < 5%
//
// Usage:
//   node --experimental-strip-types test/tools-eval.ts --model phila-ft-v4 --runs 5

import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildSystemPrompt, parseDecision } from "../src/gate.ts";
import type { InferenceConfig } from "./inference.ts";
import { infer } from "./inference.ts";

interface ToolsScenario {
	name: string;
	category:
		| "recall-trigger"
		| "recall-negative"
		| "verify-trigger"
		| "verify-negative"
		| "tools-false-positive";
	conversation: string;
	expectedAction: "silent" | "speak";
	expectedTools: string[] | null; // null = no tools field expected
	systemPrompt?: string; // override if null, uses default
}

const OLLAMA_URL = process.env.PHILA_OLLAMA_URL ?? "http://localhost:11434";
const DEFAULT_SYSTEM = buildSystemPrompt({
	chatId: "eval",
	speakBias: 0,
	updatedAt: 0,
});

// ---- Recall trigger (15): someone explicitly references prior chat ----
// Expected: action=silent, tools=["recall"]

const RECALL_TRIGGER_SCENARIOS: ToolsScenario[] = [
	{
		name: "recall: what time did we say",
		category: "recall-trigger",
		conversation:
			"person1: hey are we still on for tonight\nperson2: yeah def\nperson1: wait what time did we say again",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: who said they'd drive",
		category: "recall-trigger",
		conversation:
			"person1: lol this traffic\nperson2: same\nperson3: wait who said theyd drive tonight, was it person1 or person2",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: where were we meeting",
		category: "recall-trigger",
		conversation:
			"person1: hey almost ready\nperson2: me too\nperson1: where are we meeting again i forgot",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: what did we decide about the trip",
		category: "recall-trigger",
		conversation:
			"person1: ok so about the weekend thing\nperson2: yeah\nperson1: what did we end up deciding about the trip",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: who was bringing snacks",
		category: "recall-trigger",
		conversation:
			"person1: heading to the store now\nperson2: oh nice\nperson1: didnt someone say theyd bring snacks or was that me",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: what restaurant did we pick",
		category: "recall-trigger",
		conversation:
			"person2: on my way\nperson1: same\nperson3: wait what restaurant did we land on for tonight",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: remind me what we said",
		category: "recall-trigger",
		conversation:
			"person1: ok ready to plan\nperson2: sure\nperson1: remind me what we said about the budget for this",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: someone mentioned earlier",
		category: "recall-trigger",
		conversation:
			"person1: random but\nperson2: yeah\nperson1: someone mentioned earlier what the deal was with parking, what was it",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: what time was the reservation",
		category: "recall-trigger",
		conversation:
			"person1: getting ready now\nperson2: same, almost there\nperson1: hey what time was the reservation again",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: didnt we decide on saturday",
		category: "recall-trigger",
		conversation:
			"person2: what day are we doing this\nperson1: idk\nperson3: didnt we decide on a day already earlier",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: what was that thing person2 mentioned",
		category: "recall-trigger",
		conversation:
			"person1: ok switching topics\nperson2: sure\nperson1: what was that thing person2 mentioned before about the cost",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: how much was everyones share",
		category: "recall-trigger",
		conversation:
			"person1: venmo me\nperson2: for how much\nperson1: i thought we worked out how much everyone owes earlier",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: what was the plan if it rains",
		category: "recall-trigger",
		conversation:
			"person1: weather looks bad\nperson2: ugh\nperson1: what was the backup plan we talked about if it rains",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: does person3 have any dietary restrictions",
		category: "recall-trigger",
		conversation:
			"person1: making reservations\nperson2: cool\nperson1: wait did person3 mention any food restrictions earlier",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
	{
		name: "recall: when did we say the deadline was",
		category: "recall-trigger",
		conversation:
			"person1: starting on this now\nperson2: nice\nperson1: when did we say the deadline was for this again",
		expectedAction: "silent",
		expectedTools: ["recall"],
	},
];

// ---- Recall negative (10): no recall needed ----
// Questions answered by general knowledge or visible in conversation. No tools.

const RECALL_NEGATIVE_SCENARIOS: ToolsScenario[] = [
	{
		name: "no-recall: direct address geography",
		category: "recall-negative",
		conversation: "person1: phila what is the capital of japan",
		expectedAction: "speak",
		expectedTools: null,
	},
	{
		name: "no-recall: answer visible in conversation",
		category: "recall-negative",
		conversation:
			"person1: meeting at 7pm at joes place\nperson2: perfect\nperson3: wait what time are we meeting",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-recall: unanswered general question",
		category: "recall-negative",
		conversation: "person1: what year did ww2 end\nperson2: no idea",
		expectedAction: "speak",
		expectedTools: null,
	},
	{
		name: "no-recall: direct address science",
		category: "recall-negative",
		conversation: "person1: hey phila how many bones in the human body",
		expectedAction: "speak",
		expectedTools: null,
	},
	{
		name: "no-recall: social chatter no memory",
		category: "recall-negative",
		conversation:
			"person1: anyone seen the new season\nperson2: not yet\nperson3: heard its good",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-recall: answer introduced earlier in same window",
		category: "recall-negative",
		conversation:
			"person1: we're doing thai food tonight\nperson2: nice\nperson3: oh what are we eating\nperson1: thai place on main",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-recall: phila + history question",
		category: "recall-negative",
		conversation:
			"person2: random\nperson1: phila when did the french revolution start",
		expectedAction: "speak",
		expectedTools: null,
	},
	{
		name: "no-recall: factual question about public figure",
		category: "recall-negative",
		conversation:
			"person1: does anyone know how tall lebron james is\nperson2: no idea\nperson3: pretty tall lol",
		expectedAction: "speak",
		expectedTools: null,
	},
	{
		name: "no-recall: opinion question stays silent",
		category: "recall-negative",
		conversation:
			"person1: who do you think will win the championship\nperson2: not sure\nperson3: hard to say",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-recall: logistics visible in context",
		category: "recall-negative",
		conversation:
			"person1: train leaves at 8:15am from central\nperson2: ok\nperson3: when does the train leave",
		expectedAction: "silent",
		expectedTools: null,
	},
];

// ---- Verify trigger (15): wrong fact + nobody corrected → SPEAK + tools:["verify"] ----

const VERIFY_TRIGGER_SCENARIOS: ToolsScenario[] = [
	{
		name: "verify: eiffel tower in london",
		category: "verify-trigger",
		conversation:
			"person1: the eiffel tower is in london right\nperson2: yeah i think so",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: great wall in japan",
		category: "verify-trigger",
		conversation:
			"person1: the great wall of china is in japan\nperson2: oh interesting",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: einstein won nobel for relativity",
		category: "verify-trigger",
		conversation:
			"person1: einstein won the nobel prize for his theory of relativity\nperson2: yeah that makes sense",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: australia is smallest continent",
		category: "verify-trigger",
		conversation:
			"person1: australia is the smallest continent in the world\nperson2: yeah totally",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: napoleon was very short",
		category: "verify-trigger",
		conversation:
			"person1: napoleon was like 5 foot 2 right that's why he had a complex\nperson2: lol yeah famous for it",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: water boils at 50 degrees",
		category: "verify-trigger",
		conversation:
			"person1: water boils at 50 degrees celsius\nperson2: really i thought it was higher",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: amazon river in africa",
		category: "verify-trigger",
		conversation:
			"person1: the amazon river is in africa\nperson2: yeah thats what i thought too",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: shakespeare born 1616",
		category: "verify-trigger",
		conversation:
			"person1: shakespeare was born in 1616\nperson2: sounds about right",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: mount everest tallest at 7000m",
		category: "verify-trigger",
		conversation:
			"person1: everest is like 7000 meters tall right\nperson2: yeah something like that\nperson3: sounds right",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: usa 51 states",
		category: "verify-trigger",
		conversation:
			"person1: the us has 51 states\nperson2: hmm yeah i always forget if its 50 or 51",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: wrong inventor of telephone",
		category: "verify-trigger",
		conversation:
			"person1: thomas edison invented the telephone\nperson2: oh cool i didnt know that",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: light travels slower than sound",
		category: "verify-trigger",
		conversation:
			"person1: lightning and thunder arrive at same time cause light and sound travel same speed\nperson2: oh that makes sense",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: russia smallest country",
		category: "verify-trigger",
		conversation:
			"person1: russia is the smallest country in the world by area\nperson2: that doesnt sound right but ok",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: ww2 ended 1950",
		category: "verify-trigger",
		conversation:
			"person1: world war 2 ended in 1950 right\nperson2: yeah i think so\nperson3: sounds about right",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
	{
		name: "verify: humans only use 10% of brain",
		category: "verify-trigger",
		conversation:
			"person1: you know humans only use like 10 percent of their brains\nperson2: wild right",
		expectedAction: "speak",
		expectedTools: ["verify"],
	},
];

// ---- Verify negative (10): correct facts, jokes, or already-corrected → no verify ----

const VERIFY_NEGATIVE_SCENARIOS: ToolsScenario[] = [
	{
		name: "no-verify: correct fact",
		category: "verify-negative",
		conversation:
			"person1: paris is the capital of france right\nperson2: yeah exactly",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-verify: sarcastic wrong fact",
		category: "verify-negative",
		conversation:
			"person1: oh yeah the moon is made of cheese obviously\nperson2: lol obviously",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-verify: already corrected",
		category: "verify-negative",
		conversation:
			"person1: the nile is in south america\nperson2: no it's in africa\nperson1: oh right",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-verify: joke about wrong fact",
		category: "verify-negative",
		conversation:
			"person1: as everyone knows gravity doesnt exist its just a theory\nperson2: lmaooo",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-verify: correct historical date",
		category: "verify-negative",
		conversation: "person1: ww2 ended in 1945\nperson2: yep",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-verify: already corrected with actually",
		category: "verify-negative",
		conversation:
			"person1: einstein invented the telephone\nperson2: actually that was alexander graham bell\nperson1: oh right",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-verify: hyperbole not a factual claim",
		category: "verify-negative",
		conversation:
			"person1: this coffee is literally the worst in the universe\nperson2: lol tell me how you really feel",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-verify: opinion presented as fact",
		category: "verify-negative",
		conversation:
			"person1: pineapple on pizza is objectively terrible\nperson2: hard agree\nperson3: fight me on that",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-verify: rhetorical statement",
		category: "verify-negative",
		conversation: "person1: ugh mondays are literally illegal\nperson2: same",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-verify: meme reference",
		category: "verify-negative",
		conversation:
			"person1: did you know shrek is love shrek is life\nperson2: classic",
		expectedAction: "silent",
		expectedTools: null,
	},
];

// ---- Tools false-positive (15): social/general scenarios → no tools at all ----

const TOOLS_FALSE_POSITIVE_SCENARIOS: ToolsScenario[] = [
	{
		name: "no-tools: weekend plans",
		category: "tools-false-positive",
		conversation:
			"person1: anyone doing anything this weekend\nperson2: probably just chilling\nperson3: same honestly",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: celebrating news",
		category: "tools-false-positive",
		conversation:
			"person1: I GOT THE JOB\nperson2: omg congrats!!\nperson3: thats amazing!",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: venting about work",
		category: "tools-false-positive",
		conversation:
			"person1: this week has been brutal\nperson2: ugh same\nperson3: hang in there",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: movie recommendation",
		category: "tools-false-positive",
		conversation:
			"person1: anyone seen anything good lately\nperson2: rewatched inception last night\nperson3: classic",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: food debate",
		category: "tools-false-positive",
		conversation:
			"person1: pizza or tacos\nperson2: tacos obviously\nperson3: pizza all day",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: meme",
		category: "tools-false-positive",
		conversation:
			"person1: this is fine [meme]\nperson2: lmaooo\nperson3: too real",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: travel logistics between people",
		category: "tools-false-positive",
		conversation:
			"person1: getting an uber\nperson2: ok let me know when you're close\nperson3: same eta",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: gossip",
		category: "tools-false-positive",
		conversation:
			"person1: did you hear about person4\nperson2: no what happened\nperson3: spill",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: complaining about weather",
		category: "tools-false-positive",
		conversation:
			"person1: it is so cold today\nperson2: right?? feels like winter again\nperson3: global warming they said",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: sports reaction",
		category: "tools-false-positive",
		conversation:
			"person1: LETS GOOOO\nperson2: amazing game\nperson3: did you see that last play",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: direct-address speak no tools",
		category: "tools-false-positive",
		conversation: "person1: hey phila how are you doing",
		expectedAction: "speak",
		expectedTools: null,
	},
	{
		name: "no-tools: relationship advice",
		category: "tools-false-positive",
		conversation:
			"person1: ugh person5 is being so weird lately\nperson2: what happened\nperson3: drama",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: music recommendations",
		category: "tools-false-positive",
		conversation:
			"person1: anyone know any good playlists for running\nperson2: try lofi\nperson3: yeah lofi is great for that",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: reacting to meme",
		category: "tools-false-positive",
		conversation:
			"person1: [sends image]\nperson2: lmaoooo\nperson3: why is this so accurate",
		expectedAction: "silent",
		expectedTools: null,
	},
	{
		name: "no-tools: cooking question between people",
		category: "tools-false-positive",
		conversation:
			"person1: how long do you cook chicken at 375\nperson2: like 25-30 min per pound\nperson3: yeah that sounds right",
		expectedAction: "silent",
		expectedTools: null,
	},
];

// --- All scenarios ---

const ALL_SCENARIOS: ToolsScenario[] = [
	...RECALL_TRIGGER_SCENARIOS,
	...RECALL_NEGATIVE_SCENARIOS,
	...VERIFY_TRIGGER_SCENARIOS,
	...VERIFY_NEGATIVE_SCENARIOS,
	...TOOLS_FALSE_POSITIVE_SCENARIOS,
];

// --- Eval runner ---

interface ScenarioResult {
	name: string;
	category: string;
	expectedTools: string[] | null;
	recallHitRate: number;
	verifyHitRate: number;
	recallFpRate: number;
	verifyFpRate: number;
	rawRuns: Array<{ action: string; tools: string[] | undefined; raw: string }>;
}

async function runEval(
	scenarios: ToolsScenario[],
	config: InferenceConfig,
	runs: number,
	ollamaUrl: string,
): Promise<ScenarioResult[]> {
	const results: ScenarioResult[] = [];

	for (const scenario of scenarios) {
		process.stdout.write(`  ${scenario.name}... `);
		const system = scenario.systemPrompt ?? DEFAULT_SYSTEM;
		const rawRuns: Array<{
			action: string;
			tools: string[] | undefined;
			raw: string;
		}> = [];

		for (let i = 0; i < runs; i++) {
			try {
				const raw = await infer(
					system,
					scenario.conversation,
					config,
					ollamaUrl,
				);
				const decision = parseDecision(raw);
				rawRuns.push({
					action: decision.action,
					tools: decision.tools,
					raw,
				});
			} catch (e) {
				rawRuns.push({ action: "error", tools: undefined, raw: String(e) });
			}
		}

		// Compute rates
		const recallHitRate =
			scenario.category === "recall-trigger"
				? rawRuns.filter((r) => r.tools?.includes("recall")).length / runs
				: 0;

		const verifyHitRate =
			scenario.category === "verify-trigger"
				? rawRuns.filter((r) => r.tools?.includes("verify")).length / runs
				: 0;

		// Per-tool false-positive rates on non-trigger scenarios.
		// recallFpRate: did the model falsely emit recall when it shouldn't?
		// verifyFpRate: did the model falsely emit verify when it shouldn't?
		const recallFpRate =
			scenario.category !== "recall-trigger"
				? rawRuns.filter((r) => r.tools?.includes("recall")).length / runs
				: 0;

		const verifyFpRate =
			scenario.category !== "verify-trigger"
				? rawRuns.filter((r) => r.tools?.includes("verify")).length / runs
				: 0;

		process.stdout.write(
			scenario.category === "recall-trigger"
				? `recall=${(recallHitRate * 100).toFixed(0)}%\n`
				: scenario.category === "verify-trigger"
					? `verify=${(verifyHitRate * 100).toFixed(0)}%\n`
					: `recall-fp=${(recallFpRate * 100).toFixed(0)}% verify-fp=${(verifyFpRate * 100).toFixed(0)}%\n`,
		);

		results.push({
			name: scenario.name,
			category: scenario.category,
			expectedTools: scenario.expectedTools,
			recallHitRate,
			verifyHitRate,
			recallFpRate,
			verifyFpRate,
			rawRuns,
		});
	}

	return results;
}

function printReport(
	results: ScenarioResult[],
	runs: number,
): {
	recallRate: number;
	verifyRate: number;
	recallFpRate: number;
	verifyFpRate: number;
	passed: boolean;
} {
	const recallTrigger = results.filter((r) => r.category === "recall-trigger");
	const verifyTrigger = results.filter((r) => r.category === "verify-trigger");
	const nonRecall = results.filter((r) => r.category !== "recall-trigger");
	const nonVerify = results.filter((r) => r.category !== "verify-trigger");

	const recallRate =
		recallTrigger.reduce((s, r) => s + r.recallHitRate, 0) /
		recallTrigger.length;
	const verifyRate =
		verifyTrigger.reduce((s, r) => s + r.verifyHitRate, 0) /
		verifyTrigger.length;
	// Average per-scenario FP rates across all non-trigger scenarios
	const recallFpRate =
		nonRecall.reduce((s, r) => s + r.recallFpRate, 0) / nonRecall.length;
	const verifyFpRate =
		nonVerify.reduce((s, r) => s + r.verifyFpRate, 0) / nonVerify.length;

	console.log("\n=== Tools Eval Results ===");
	console.log(`  Runs per scenario: ${runs}`);
	console.log(`  Scenarios: ${results.length}`);
	console.log("");
	console.log(
		`  Recall trigger rate:   ${(recallRate * 100).toFixed(1)}% (target: ≥70%) ${recallRate >= 0.7 ? "✓ PASS" : "✗ FAIL"}`,
	);
	console.log(
		`  Verify trigger rate:   ${(verifyRate * 100).toFixed(1)}% (target: ≥80%) ${verifyRate >= 0.8 ? "✓ PASS" : "✗ FAIL"}`,
	);
	console.log(
		`  Recall false positive: ${(recallFpRate * 100).toFixed(1)}% (target: <5%)  ${recallFpRate < 0.05 ? "✓ PASS" : "✗ FAIL"}`,
	);
	console.log(
		`  Verify false positive: ${(verifyFpRate * 100).toFixed(1)}% (target: <5%)  ${verifyFpRate < 0.05 ? "✓ PASS" : "✗ FAIL"}`,
	);

	// Per-category table
	console.log("\n  Per-category breakdown:");
	const categories = [
		"recall-trigger",
		"recall-negative",
		"verify-trigger",
		"verify-negative",
		"tools-false-positive",
	] as const;

	for (const cat of categories) {
		const catResults = results.filter((r) => r.category === cat);
		if (catResults.length === 0) continue;
		const metric =
			cat === "recall-trigger"
				? `${((catResults.reduce((s, r) => s + r.recallHitRate, 0) / catResults.length) * 100).toFixed(1)}% recall`
				: cat === "verify-trigger"
					? `${((catResults.reduce((s, r) => s + r.verifyHitRate, 0) / catResults.length) * 100).toFixed(1)}% verify`
					: `recall-fp=${((catResults.reduce((s, r) => s + r.recallFpRate, 0) / catResults.length) * 100).toFixed(1)}% verify-fp=${((catResults.reduce((s, r) => s + r.verifyFpRate, 0) / catResults.length) * 100).toFixed(1)}%`;
		console.log(
			`    ${cat.padEnd(24)} ${catResults.length} scenarios  ${metric}`,
		);
	}

	const passed =
		recallRate >= 0.7 &&
		verifyRate >= 0.8 &&
		recallFpRate < 0.05 &&
		verifyFpRate < 0.05;
	console.log(`\n  Overall: ${passed ? "PASS" : "FAIL"}`);
	return { recallRate, verifyRate, recallFpRate, verifyFpRate, passed };
}

// --- Entry point ---

const { values: args } = parseArgs({
	options: {
		model: { type: "string", default: "phila-ft-v4" },
		runs: { type: "string", default: "5" },
		out: { type: "string" },
		category: { type: "string" },
	},
	strict: true,
});

const RUNS = parseInt(args.runs!, 10);
const MODEL = args.model!;

if (Number.isNaN(RUNS) || RUNS < 1) {
	console.error("--runs must be a positive integer");
	process.exit(1);
}

const config: InferenceConfig = {
	model: MODEL,
	temperature: 0.1,
	numPredict: 96,
	topP: 0.52,
};

// Filter by category if requested
const scenarios = args.category
	? ALL_SCENARIOS.filter((s) => s.category === args.category)
	: ALL_SCENARIOS;

if (scenarios.length === 0) {
	console.error(`No scenarios for category: ${args.category}`);
	process.exit(1);
}

console.log(
	`\nTools eval: model=${MODEL}, runs=${RUNS}, scenarios=${scenarios.length}`,
);
console.log(`Ollama: ${OLLAMA_URL}\n`);

const results = await runEval(scenarios, config, RUNS, OLLAMA_URL);
const { recallRate, verifyRate, recallFpRate, verifyFpRate, passed } =
	printReport(results, RUNS);

// Write JSON report
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const reportPath =
	args.out ?? `test/research-reports/tools-eval-${timestamp}.json`;
mkdirSync("test/research-reports", { recursive: true });
writeFileSync(
	reportPath,
	JSON.stringify(
		{
			model: MODEL,
			runs: RUNS,
			timestamp: new Date().toISOString(),
			summary: {
				recallRate,
				verifyRate,
				recallFpRate,
				verifyFpRate,
				passed,
				recallTarget: 0.7,
				verifyTarget: 0.8,
				fpTarget: 0.05,
			},
			scenarios: results.map((r) => ({
				name: r.name,
				category: r.category,
				expectedTools: r.expectedTools,
				recallHitRate: r.recallHitRate,
				verifyHitRate: r.verifyHitRate,
				recallFpRate: r.recallFpRate,
				verifyFpRate: r.verifyFpRate,
			})),
		},
		null,
		2,
	),
);
console.log(`\nReport written to ${reportPath}`);
process.exit(passed ? 0 : 1);
