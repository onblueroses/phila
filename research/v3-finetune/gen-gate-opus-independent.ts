// Generate training examples matching the independent scenario distribution.
// Closes the ~6pp distribution gap between synthetic training data and independent eval.
// Uses OpenRouter (free models) with parallel requests.
//
// Usage: node --experimental-strip-types research/v3-finetune/gen-gate-opus-independent.ts --count 1500

import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { buildSystemPrompt } from "../../src/gate.ts";
import type { GroupProfile } from "../../src/types.ts";
import {
	callOpenRouter,
	getStats,
	rateLimitDelay,
} from "./openrouter-client.ts";

// Load .env
const envPath = new URL("../../.env", import.meta.url).pathname;
if (existsSync(envPath)) {
	for (const line of readFileSync(envPath, "utf-8").split("\n")) {
		const m = line.match(/^(\w+)=(.*)$/);
		if (m) process.env[m[1]!] = m[2]!;
	}
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
	console.error("OPENROUTER_API_KEY not set");
	process.exit(1);
}

const { values: args } = parseArgs({
	options: {
		out: {
			type: "string",
			default: "data/v3-finetune/gate-opus-independent.jsonl",
		},
		count: { type: "string", default: "1500" },
		concurrency: { type: "string", default: "15" },
	},
});

const TARGET = parseInt(args.count!, 10);
const CONCURRENCY = parseInt(args.concurrency!, 10);
const profile: GroupProfile = {
	chatId: "train",
	speakBias: 0.0,
	updatedAt: Date.now(),
};
const systemPrompt = buildSystemPrompt(profile);

// Distribution matches independent-scenarios.json proportions (174 total)
const CATEGORIES = [
	{
		category: "speak-correction",
		expect: "speak" as const,
		weight: 26,
		description:
			"someone states a WRONG fact (wrong date, wrong name, wrong number, wrong science, wrong geography, wrong history) and NOBODY corrects them. the agent should correct the error.",
	},
	{
		category: "silent-social",
		expect: "silent" as const,
		weight: 21,
		description:
			"casual group chat: small talk, emotions, opinions, celebrations, jokes, banter, gossip, venting, compliments, dating talk, workout chat, food debates, weekend recaps, goodnight messages",
	},
	{
		category: "speak-unanswered",
		expect: "speak" as const,
		weight: 9,
		description:
			'someone asks a factual question and nobody answers correctly. others say "idk", give wrong answers, or change the subject. the agent should answer.',
	},
	{
		category: "speak-memory-logistics",
		expect: "speak" as const,
		weight: 9,
		description:
			'someone asks about plans/logistics discussed EARLIER in the conversation. e.g. "where are we meeting?", "what time again?", "which restaurant?" - the answer was stated earlier.',
	},
	{
		category: "speak-memory-commitment",
		expect: "speak" as const,
		weight: 7,
		description:
			'someone asks about WHO committed to doing WHAT, discussed earlier. e.g. "who said theyd bring drinks?", "whos driving?"',
	},
	{
		category: "silent-corrected",
		expect: "silent" as const,
		weight: 7,
		description:
			'someone states a wrong fact BUT another person already corrected them. uses "actually", "no its", "thats not right"',
	},
	{
		category: "speak-direct",
		expect: "speak" as const,
		weight: 5,
		description:
			'someone addresses "phila" by name - greeting, question, request. phila should respond.',
	},
	{
		category: "adversarial",
		expect: "silent" as const,
		weight: 5,
		description:
			'edge cases: sarcastic wrong facts, jokes with false claims, "philo"/"philadelphia"/"philanthropy" (not "phila"), opinion questions, hypothetical wrong facts',
	},
	{
		category: "silent-rhetorical",
		expect: "silent" as const,
		weight: 4,
		description:
			'rhetorical questions, hypotheticals, self-answered questions, existential musings, "would you rather" games',
	},
	{
		category: "silent-logistics",
		expect: "silent" as const,
		weight: 4,
		description:
			"planning and coordination already handled: rides sorted, bills split, times agreed, tasks assigned",
	},
	{
		category: "speak-memory-personal",
		expect: "speak" as const,
		weight: 3,
		description:
			"someone asks about a personal fact stated earlier. allergies, dietary restrictions, preferences, birthdays mentioned earlier.",
	},
];

const PERSONAS = [
	"college students in a dorm group chat",
	"coworkers at a tech company",
	"friends planning a weekend trip",
	"roommates coordinating household stuff",
	"a sports fan group chat",
	"parents in a school parents group",
	"musicians in a band group chat",
	"gym buddies",
	"book club members",
	"neighbors in an apartment building",
	"siblings family group chat",
	"hiking group",
	"cooking enthusiasts",
	"gaming clan chat",
	"old friends from high school reconnecting",
	"grad students in the same program",
	"volunteer group organizing events",
	"travel buddies planning next trip",
	"dog owners at the same park",
	"new employees at same company",
];

async function generateOne(
	category: (typeof CATEGORIES)[number],
	persona: string,
): Promise<string | null> {
	const prompt = `Generate a realistic group chat conversation for the category "${category.category}".
The expected bot decision is: ${category.expect.toUpperCase()}

Category: ${category.description}

Persona context: ${persona}

Use person1, person2, person3 (etc) as speaker names. Write 3-7 messages.
Make it feel like a REAL group chat - lowercase, abbreviations, slang, varied sentence length.
Use diverse topics, cultural references, real-world scenarios.

${category.expect === "speak" ? "The conversation MUST contain a clear reason for the bot to speak. INCLUDE the correct factual answer." : "The bot should stay SILENT."}
${category.category.startsWith("speak-memory") ? "IMPORTANT: the relevant fact/plan/commitment MUST appear earlier in the conversation, then someone asks about it later." : ""}

Respond with ONLY a JSON object:
{"conversation":"person1: ...\\nperson2: ...\\nperson3: ...","correct_response":"brief factual answer if speak scenario, empty string if silent"}`;

	const raw = await callOpenRouter(
		OPENROUTER_API_KEY!,
		[
			{
				role: "system",
				content:
					"You generate realistic group chat conversations for training a chat bot. Respond with only valid JSON. No markdown, no code blocks.",
			},
			{ role: "user", content: prompt },
		],
		{ maxTokens: 500 },
	);
	if (!raw) return null;

	try {
		let cleaned = raw.replace(/```(?:json)?\s*|```\s*/g, "").trim();
		if (!cleaned.startsWith("{")) {
			const start = cleaned.indexOf("{");
			const end = cleaned.lastIndexOf("}");
			if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
		}
		cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

		const parsed = JSON.parse(cleaned) as {
			conversation?: string;
			correct_response?: string;
		};
		if (!parsed.conversation || parsed.conversation.length < 20) return null;

		const assistant =
			category.expect === "speak"
				? JSON.stringify({
						action: "speak",
						reason: category.category,
						response: parsed.correct_response || "relevant response",
					})
				: JSON.stringify({ action: "silent" });

		const example = {
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: parsed.conversation },
				{ role: "assistant", content: assistant },
			],
		};

		return JSON.stringify(example);
	} catch {
		return null;
	}
}

async function main() {
	let written = 0;
	if (existsSync(args.out!)) {
		const existing = readFileSync(args.out!, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean);
		written = existing.length;
		console.log(`Resuming from ${written} existing examples`);
	} else {
		writeFileSync(args.out!, "");
	}

	const pool: (typeof CATEGORIES)[number][] = [];
	for (const cat of CATEGORIES) {
		for (let i = 0; i < cat.weight; i++) pool.push(cat);
	}

	let attempts = 0;
	const maxAttempts = TARGET * 3;
	const startTime = Date.now();

	while (written < TARGET && attempts < maxAttempts) {
		const batch = Array.from(
			{ length: Math.min(CONCURRENCY, TARGET - written) },
			() => {
				const cat = pool[Math.floor(Math.random() * pool.length)]!;
				const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)]!;
				return generateOne(cat, persona);
			},
		);

		attempts += batch.length;
		const results = await Promise.all(batch);
		const valid = results.filter((r): r is string => r !== null);

		for (const line of valid) {
			appendFileSync(args.out!, `${line}\n`);
			written++;
		}

		const elapsed = (Date.now() - startTime) / 1000;
		const rate = written / elapsed;
		const eta = rate > 0 ? Math.round((TARGET - written) / rate) : "?";
		process.stdout.write(
			`\r[${written}/${TARGET}] ${Math.round((written / attempts) * 100)}% ok | ${rate.toFixed(1)}/s | ETA ${eta}s | ${getStats()}    `,
		);

		await rateLimitDelay(CONCURRENCY);
	}

	console.log(
		`\n\nDone: ${written} examples, ${attempts} attempts (${Math.round((written / attempts) * 100)}% success rate)`,
	);
	console.log(`Output: ${args.out}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
