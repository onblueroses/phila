// Generate memory recall (Pass 2) training data using Step 3.5 Flash via OpenRouter.
// Teaches the model to answer questions from injected extracted facts.
// Format: system=MEMORY_CHECK_SYSTEM, user=conversation+facts, assistant=speak/silent
//
// Usage: node --experimental-strip-types research/v3-finetune/gen-memory-recall.ts --out data/v3-finetune/memory-recall.jsonl --count 3000

import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";

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
		out: { type: "string", default: "data/v3-finetune/memory-recall.jsonl" },
		count: { type: "string", default: "3000" },
		concurrency: { type: "string", default: "15" },
	},
});

const TARGET = parseInt(args.count!, 10);
const CONCURRENCY = parseInt(args.concurrency!, 10);

import {
	callOpenRouter,
	getStats,
	rateLimitDelay,
} from "./openrouter-client.ts";

const MEMORY_CHECK_SYSTEM = `you are phila, a member of a group chat.

someone just asked about something discussed earlier. you have facts from the conversation.

EXAMPLES:
facts: meeting_location = thai place on main at 7pm
question: "where are we going tonight?"
correct response: {"action":"speak","reason":"memory recall","response":"the thai place on main, 7pm"}

facts: whos_driving = person1
question: "who said theyd drive?"
correct response: {"action":"speak","reason":"memory recall","response":"person1 said theyd drive"}

facts: allergy = person1 is allergic to shellfish
question: "can everyone eat shrimp?"
correct response: {"action":"speak","reason":"memory recall","response":"person1 mentioned theyre allergic to shellfish"}

facts: commitment = person1 will bring chips, commitment = person2 will handle drinks
question: "who said theyd get drinks?"
correct response: {"action":"speak","reason":"memory recall","response":"person2 said theyd handle drinks"}

USE THE FACTS TO ANSWER. if the facts contain the answer, speak up.
only stay silent if the facts genuinely don't help answer what was asked.

respond with ONLY json:
{"action":"silent"}
or
{"action":"speak","reason":"memory recall","response":"your message"}

style: lowercase, 1-2 sentences, casual like a friend.`;

const RECALL_SCENARIOS = [
	{
		expect: "speak",
		weight: 35,
		desc: "someone asks about plans/logistics. the facts contain the answer (time, place, event). generate: conversation where someone asks, + facts that answer it, + correct speak response.",
	},
	{
		expect: "speak",
		weight: 25,
		desc: 'someone asks who committed to do something. the facts track commitments. generate: conversation asking "whos doing X?", + commitment facts, + correct speak response naming the person.',
	},
	{
		expect: "speak",
		weight: 15,
		desc: "someone asks about a personal fact (allergy, preference, birthday). facts have it. generate: conversation + relevant personal facts + correct speak response.",
	},
	{
		expect: "silent",
		weight: 15,
		desc: "someone asks something the facts CANNOT answer. facts are about a different topic. generate: conversation + unrelated facts. the model should stay silent.",
	},
	{
		expect: "silent",
		weight: 10,
		desc: "pure social conversation, no question being asked. facts exist from prior context but nobody is asking about them. stay silent.",
	},
];

const DOMAINS = [
	"dinner plans",
	"ride sharing",
	"birthday party",
	"movie night",
	"gym session",
	"grocery run",
	"study group",
	"weekend hike",
	"concert tickets",
	"apartment viewing",
	"potluck food",
	"flight details",
	"work meeting",
	"game night",
	"camping trip",
	"wedding prep",
	"dog walking",
	"coffee order",
	"project deadline",
	"holiday plans",
];

// callOpenRouter imported from shared client

function buildMemoryPrompt(
	conversation: string,
	facts: Array<{ type: string; key: string; value: string }>,
): string {
	const factLines = facts
		.map((f) => `- ${f.type}: ${f.key} = ${f.value}`)
		.join("\n");
	return `conversation:\n${conversation}\n\nfacts from earlier in this chat:\n${factLines}`;
}

async function generateOne(
	scenario: (typeof RECALL_SCENARIOS)[number],
	domain: string,
): Promise<string | null> {
	const prompt =
		scenario.expect === "speak"
			? `Generate ONE memory recall training example about "${domain}" where phila SHOULD speak.

${scenario.desc}

Rules:
- conversation: 3-5 messages between person1/person2/person3, lowercase casual
- facts: 1-3 objects with type (one of: logistics, commitment, preference, personal), key, value
- response: lowercase casual 1-2 sentence answer using the facts

Respond with EXACTLY ONE JSON object (not an array):
{"conversation":"person1: where are we eating\\nperson2: idk someone said something","facts":[{"type":"logistics","key":"dinner_location","value":"thai place on main at 7pm"}],"response":"the thai place on main, 7pm"}`
			: `Generate ONE memory recall training example about "${domain}" where phila should STAY SILENT.

${scenario.desc}

Rules:
- conversation: 3-5 messages between person1/person2/person3, lowercase casual
- facts: 1-3 objects with type (one of: logistics, commitment, preference, personal), key, value
- The facts must NOT answer what's being discussed

Respond with EXACTLY ONE JSON object (not an array):
{"conversation":"person1: that movie was wild\\nperson2: ikr the twist","facts":[{"type":"logistics","key":"old_plan","value":"gym at 6am tomorrow"}]}`;

	const raw = await callOpenRouter(
		OPENROUTER_API_KEY!,
		[
			{
				role: "system",
				content:
					"Generate memory recall training examples for a group chat agent. Respond with only valid JSON. No markdown, no code blocks.",
			},
			{ role: "user", content: prompt },
		],
		{ maxTokens: 500 },
	);
	if (!raw) return null;

	try {
		let cleaned = raw.replace(/```(?:json)?\s*|```\s*/g, "").trim();
		cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

		// Handle array responses (Gemma sometimes returns [{...}, ...])
		let parsed: {
			conversation?: string;
			facts?: Array<{ type: string; key: string; value: string }>;
			response?: string;
		};
		const jsonStart = cleaned.indexOf("{");
		const jsonEnd = cleaned.lastIndexOf("}");
		if (jsonStart === -1 || jsonEnd <= jsonStart) return null;

		if (cleaned.trimStart().startsWith("[")) {
			const arr = JSON.parse(cleaned) as Array<typeof parsed>;
			if (!arr[0]) return null;
			parsed = arr[0];
		} else {
			parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
		}

		if (!parsed.conversation || !parsed.facts?.length) return null;
		// Normalize fact types to valid values
		const validTypes = new Set([
			"logistics",
			"commitment",
			"preference",
			"personal",
		]);
		for (const f of parsed.facts) {
			if (!f.key || !f.value) return null;
			if (!validTypes.has(f.type)) f.type = "logistics";
		}

		const userContent = buildMemoryPrompt(parsed.conversation, parsed.facts);
		const assistantContent =
			scenario.expect === "speak"
				? JSON.stringify({
						action: "speak",
						reason: "memory recall",
						response: parsed.response ?? "relevant answer",
					})
				: JSON.stringify({ action: "silent" });

		// Validate
		JSON.parse(assistantContent);

		const example = {
			messages: [
				{ role: "system", content: MEMORY_CHECK_SYSTEM },
				{ role: "user", content: userContent },
				{ role: "assistant", content: assistantContent },
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
		written = readFileSync(args.out!, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean).length;
		console.log(`Resuming from ${written}`);
	} else {
		writeFileSync(args.out!, "");
	}

	const pool: (typeof RECALL_SCENARIOS)[number][] = [];
	for (const s of RECALL_SCENARIOS) {
		for (let i = 0; i < s.weight; i++) pool.push(s);
	}

	let attempts = 0;
	const startTime = Date.now();

	while (written < TARGET && attempts < TARGET * 3) {
		const batch = Array.from(
			{ length: Math.min(CONCURRENCY, TARGET - written) },
			() => {
				const scenario = pool[Math.floor(Math.random() * pool.length)]!;
				const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)]!;
				return generateOne(scenario, domain);
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
		const eta = Math.round((TARGET - written) / rate);
		process.stdout.write(
			`\r[${written}/${TARGET}] ${Math.round((written / attempts) * 100)}% ok | ${rate.toFixed(1)}/s | ETA ${eta}s | ${getStats()}    `,
		);

		await rateLimitDelay(CONCURRENCY);
	}

	console.log(`\n\nDone: ${written} examples, ${attempts} attempts`);
	console.log(`Output: ${args.out}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
