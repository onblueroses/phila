// Generate diverse gate training examples using Step 3.5 Flash via OpenRouter.
// Targets weak categories from benchmark data with persona diversity.
// Runs parallel requests for throughput.
//
// Usage: node --experimental-strip-types research/v3-finetune/gen-gate-synthetic.ts --out data/v3-finetune/gate-synthetic.jsonl --count 5000

import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { buildSystemPrompt } from "../../src/gate.ts";
import type { GroupProfile } from "../../src/types.ts";

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
			default: "data/v3-finetune/gate-synthetic-v3.jsonl",
		},
		count: { type: "string", default: "2500" },
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

import {
	callOpenRouter,
	getStats,
	rateLimitDelay,
} from "./openrouter-client.ts";

// v3 weights target recall bottleneck: 40% speak-correction, 20% speak-unanswered,
// 15% speak-memory, 15% silent-social (maintenance), 10% adversarial
const CATEGORIES = [
	{
		name: "silent-social",
		expect: "silent",
		weight: 8,
		desc: "casual chat between friends: weekend plans, food opinions, dating, gym, gaming, music, movies, work complaints, pets, weather, celebrations, venting. 3-5 messages. lowercase, slang, emoji ok.",
	},
	{
		name: "silent-corrected",
		expect: "silent",
		weight: 3,
		desc: 'someone states a wrong fact but ANOTHER person already corrected them. use words like "actually", "no its", "thats not right". 4-6 messages.',
	},
	{
		name: "silent-rhetorical",
		expect: "silent",
		weight: 2,
		desc: 'rhetorical questions, hypotheticals, "would you rather", existential musings. nobody expects a factual answer. 3-4 messages.',
	},
	{
		name: "silent-logistics",
		expect: "silent",
		weight: 2,
		desc: "planning thats already resolved: ride sorted, bill split, time agreed. everyone confirmed. 3-5 messages.",
	},
	{
		name: "speak-correction",
		expect: "speak",
		weight: 25,
		desc: 'someone states a WRONG fact (wrong date, name, number, science, geography, history) and nobody corrects them. the WRONG fact must be clearly, verifiably wrong. 3-4 messages. INCLUDE the correct answer in the "correct_response" field.',
	},
	{
		name: "speak-unanswered",
		expect: "speak",
		weight: 15,
		desc: 'someone asks a factual question nobody answers. others say "idk" or give wrong answers or change subject. 3-5 messages. INCLUDE the correct answer.',
	},
	{
		name: "speak-direct",
		expect: "speak",
		weight: 10,
		desc: 'someone addresses "phila" by name with a question or request. use "phila" clearly as addressing the bot. 2-3 messages.',
	},
	{
		name: "adversarial-silent",
		expect: "silent",
		weight: 10,
		desc: 'tricky edge cases: sarcastic wrong facts with lol/lmao, "philo"/"philadelphia"/"philanthropy" (NOT "phila"), opinions that sound factual, questions directed at a specific person not phila.',
	},
	{
		name: "speak-memory-logistics",
		expect: "speak",
		weight: 10,
		desc: 'someone asks about plans discussed EARLIER in the conversation. first part has the plan ("dinner at thai place 7pm"), later someone asks about it ("where are we eating?"). 5-7 messages. INCLUDE the answer from the earlier plan.',
	},
	{
		name: "speak-memory-commitment",
		expect: "speak",
		weight: 8,
		desc: 'someone asks WHO committed to do WHAT from earlier in conversation. first part has commitment ("ill bring drinks"), later someone asks ("whos bringing drinks?"). 5-7 messages.',
	},
	{
		name: "speak-memory-personal",
		expect: "speak",
		weight: 7,
		desc: "someone asks about a personal fact mentioned earlier. first: someone says preference/allergy/restriction. later: someone asks about it. 5-7 messages.",
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

const TOPICS = [
	"sports scores",
	"cooking recipes",
	"travel destinations",
	"science facts",
	"movie trivia",
	"gaming strategies",
	"fitness goals",
	"music history",
	"work drama",
	"school exams",
	"pet stories",
	"weather",
	"tech gadgets",
	"fashion trends",
	"car problems",
	"relationship advice",
	"health tips",
	"historical events",
	"geography quiz",
	"pop culture",
	"restaurant picks",
	"concert plans",
	"book recommendations",
	"home repairs",
	"career moves",
];

// callOpenRouter imported from shared client

async function generateOne(
	category: (typeof CATEGORIES)[number],
	persona: string,
	topic: string,
): Promise<string | null> {
	const prompt = `Generate a realistic group chat conversation for the category "${category.name}".
The expected bot decision is: ${category.expect.toUpperCase()}

Category: ${category.desc}

Persona context: ${persona}
Topic hint: ${topic}

Use person1, person2, person3 (etc) as speaker names. Write 3-7 messages.
Make it feel like a REAL group chat - lowercase, abbreviations, slang, varied sentence length.

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
		// Fix trailing commas before } or ]
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
						reason: category.name,
						response: parsed.correct_response || "relevant response",
					})
				: JSON.stringify({ action: "silent" });

		// Validate assistant JSON
		JSON.parse(assistant);

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
		// Launch CONCURRENCY parallel requests
		const batch = Array.from(
			{ length: Math.min(CONCURRENCY, TARGET - written) },
			() => {
				const cat = pool[Math.floor(Math.random() * pool.length)]!;
				const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)]!;
				const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)]!;
				return generateOne(cat, persona, topic);
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
