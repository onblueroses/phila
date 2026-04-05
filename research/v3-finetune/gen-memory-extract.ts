// Generate memory extraction training data using Step 3.5 Flash via OpenRouter.
// Teaches the model to extract structured facts from group chat conversations.
// Format: system=EXTRACT_SYSTEM, user=conversation, assistant=JSON array
//
// Usage: node --experimental-strip-types research/v3-finetune/gen-memory-extract.ts --out data/v3-finetune/memory-extract.jsonl --count 3000

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
		out: { type: "string", default: "data/v3-finetune/memory-extract.jsonl" },
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

const EXTRACT_SYSTEM = `extract factual information from this group chat snippet.
return a JSON array of objects. each object has:
- "type": one of "logistics", "commitment", "preference", "personal"
- "key": short label (e.g. "meeting_location", "allergy", "dinner_time", "whos_driving")
- "value": the fact itself (e.g. "thai place on main at 7pm", "person1 is allergic to shellfish")

only extract concrete facts. ignore opinions, jokes, emotions, greetings, banter.
if no facts, return [].
respond with ONLY the JSON array, no other text.`;

// Weighted type distribution: 30% logistics, 25% commitment, 15% preference, 15% personal, 15% none
const TYPE_POOL = [
	...Array(6).fill("logistics"),
	...Array(5).fill("commitment"),
	...Array(3).fill("preference"),
	...Array(3).fill("personal"),
	...Array(3).fill("none"),
] as string[];

const DOMAINS = [
	"road trip planning",
	"office lunch order",
	"birthday party",
	"apartment hunting",
	"gym class schedule",
	"book club meeting",
	"camping trip",
	"concert tickets",
	"potluck dinner",
	"study group",
	"wedding planning",
	"holiday gathering",
	"sports tournament",
	"hackathon project",
	"moving day logistics",
	"pet sitting",
	"grocery shopping",
	"flight booking",
	"doctor appointment",
	"job interview prep",
	"garden project",
	"karaoke night",
	"beach day",
	"board game night",
	"restaurant reservation",
	"carpool schedule",
	"volunteer event",
	"photography trip",
];

// callOpenRouter imported from shared client

async function generateOne(
	factType: string,
	domain: string,
): Promise<string | null> {
	const prompt =
		factType === "none"
			? `Generate a casual group chat conversation (3-5 messages, person1/person2/person3) about "${domain}" that contains NO extractable facts - just social chat, opinions, jokes, reactions, emotions. No times, no places, no commitments, no personal facts.

Respond with ONLY: {"conversation":"person1: ...\\nperson2: ..."}`
			: `Generate a realistic group chat conversation (3-6 messages, person1/person2/person3) about "${domain}".
The conversation must contain extractable facts of type: ${factType}.
Use casual language - lowercase, abbreviations, slang.

Respond with ONLY a JSON object:
{"conversation":"person1: ...\\nperson2: ...\\nperson3: ...","facts":[{"type":"${factType}","key":"short_key","value":"the concrete fact"}]}`;

	const raw = await callOpenRouter(
		OPENROUTER_API_KEY!,
		[
			{
				role: "system",
				content:
					"Generate group chat conversations with extractable facts. Respond with only valid JSON. No markdown, no code blocks.",
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
			facts?: Array<{ type: string; key: string; value: string }>;
		};
		if (!parsed.conversation || parsed.conversation.length < 20) return null;

		let facts: Array<{ type: string; key: string; value: string }>;
		if (factType === "none") {
			facts = [];
		} else {
			facts = parsed.facts ?? [];
			if (facts.length === 0) return null;
			// Validate fact structure
			for (const f of facts) {
				if (!f.type || !f.key || !f.value) return null;
			}
		}

		const example = {
			messages: [
				{ role: "system", content: EXTRACT_SYSTEM },
				{ role: "user", content: parsed.conversation },
				{ role: "assistant", content: JSON.stringify(facts) },
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

	let attempts = 0;
	const startTime = Date.now();

	while (written < TARGET && attempts < TARGET * 3) {
		const batch = Array.from(
			{ length: Math.min(CONCURRENCY, TARGET - written) },
			() => {
				const factType =
					TYPE_POOL[Math.floor(Math.random() * TYPE_POOL.length)]!;
				const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)]!;
				return generateOne(factType, domain);
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
