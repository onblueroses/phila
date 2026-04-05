// Generate an independent test suite using Ollama on VPS.
// Produces scenarios that are NOT derived from the existing test set.
// The LLM gets category definitions but NO examples from scenarios.ts.
//
// Usage: node --experimental-strip-types research/gen-independent-scenarios.ts --out scenarios.json --count 200

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		out: { type: "string", default: "independent-scenarios.json" },
		count: { type: "string", default: "200" },
		model: { type: "string", default: "llama3.2" },
	},
});

const OLLAMA_URL = process.env.PHILA_OLLAMA_URL ?? "http://localhost:11434";
const TARGET_COUNT = parseInt(args.count!, 10);

interface GeneratedScenario {
	name: string;
	conversation: string;
	expect: "silent" | "speak";
	category: string;
	difficulty: string;
	topic?: string;
}

// Category definitions WITHOUT examples from the existing test set
const CATEGORIES = [
	{
		category: "silent-social",
		expect: "silent" as const,
		description:
			"casual group chat: small talk, emotions, opinions, celebrations, jokes, banter, gossip, venting, compliments, dating talk, workout chat, food debates, weekend recaps, goodnight messages",
		count: 40,
		difficulties: ["easy", "medium", "hard"],
	},
	{
		category: "silent-corrected",
		expect: "silent" as const,
		description:
			'someone states a wrong fact BUT another person already corrected them. the correction uses words like "actually", "no its", "thats not right", "pretty sure thats wrong"',
		count: 15,
		difficulties: ["medium", "hard"],
	},
	{
		category: "silent-rhetorical",
		expect: "silent" as const,
		description:
			'rhetorical questions, hypotheticals, self-answered questions, existential musings, "would you rather" games',
		count: 10,
		difficulties: ["easy", "medium"],
	},
	{
		category: "silent-logistics",
		expect: "silent" as const,
		description:
			"planning and coordination that is already handled: rides sorted, bills split, times agreed, tasks assigned and acknowledged",
		count: 10,
		difficulties: ["easy", "medium"],
	},
	{
		category: "speak-correction",
		expect: "speak" as const,
		description:
			"someone states a WRONG fact (wrong date, wrong name, wrong number, wrong science, wrong geography, wrong history) and NOBODY corrects them. the agent should correct the error.",
		count: 25,
		difficulties: ["easy", "medium", "hard"],
	},
	{
		category: "speak-unanswered",
		expect: "speak" as const,
		description:
			'someone asks a factual question and nobody answers correctly. others say "idk", give wrong answers, or change the subject. the agent should answer.',
		count: 20,
		difficulties: ["easy", "medium", "hard"],
	},
	{
		category: "speak-direct",
		expect: "speak" as const,
		description:
			'someone addresses "phila" by name - greeting, question, request. phila should respond.',
		count: 15,
		difficulties: ["easy", "medium"],
	},
	{
		category: "speak-memory-logistics",
		expect: "speak" as const,
		description:
			'someone asks about plans/logistics discussed EARLIER in the conversation. e.g. "where are we meeting?", "what time again?", "which restaurant?" - the answer was stated by someone earlier in the chat.',
		count: 20,
		difficulties: ["medium", "hard"],
	},
	{
		category: "speak-memory-commitment",
		expect: "speak" as const,
		description:
			'someone asks about WHO committed to doing WHAT, discussed earlier. e.g. "who said theyd bring drinks?", "whos driving?", "did anyone say theyd pick up the cake?"',
		count: 15,
		difficulties: ["medium", "hard"],
	},
	{
		category: "speak-memory-personal",
		expect: "speak" as const,
		description:
			"someone asks about a personal fact stated earlier in conversation. e.g. allergies, dietary restrictions, preferences, birthdays that were mentioned.",
		count: 10,
		difficulties: ["hard"],
	},
	{
		category: "adversarial",
		expect: "silent" as const,
		description:
			'edge cases that look like they should trigger a response but should NOT: sarcastic wrong facts, jokes with false claims, "philo"/"philadelphia"/"philanthropy" (not "phila"), questions about opinions not facts, hypothetical wrong facts, wrong facts that someone already corrected',
		count: 20,
		difficulties: ["adversarial"],
	},
];

const GEN_SYSTEM = `you generate realistic group chat conversations for testing a chat bot.
the bot "phila" sits in group chats and decides whether to speak or stay silent.

generate a conversation between 2-4 people (use person1, person2, person3, person4).
the conversation should feel natural - use lowercase, abbreviations, slang, emoji occasionally.
each message is on its own line formatted as "person1: message text"

IMPORTANT: generate conversations that are DIFFERENT from typical AI-generated examples.
use diverse topics, cultural references, real-world scenarios. avoid the same 5 topics over and over.
make it feel like a REAL group chat between friends/coworkers.

respond with ONLY a JSON object:
{"name":"short scenario name","conversation":"person1: ...\nperson2: ...","topic":"optional topic for speak scenarios"}

no other text.`;

async function generate(
	category: (typeof CATEGORIES)[number],
	difficulty: string,
): Promise<GeneratedScenario | null> {
	const prompt = `generate a "${category.category}" scenario (difficulty: ${difficulty}).

the expected action is: ${category.expect.toUpperCase()}

category description: ${category.description}

${category.expect === "speak" ? "the conversation MUST contain a clear reason for the bot to speak based on the category description." : "the bot should stay SILENT for this conversation."}
${category.category.startsWith("speak-memory") ? "IMPORTANT: the relevant fact/plan/commitment MUST appear earlier in the conversation, then someone asks about it later." : ""}`;

	try {
		const res = await fetch(`${OLLAMA_URL}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: AbortSignal.timeout(30_000),
			body: JSON.stringify({
				model: args.model,
				messages: [
					{ role: "system", content: GEN_SYSTEM },
					{ role: "user", content: prompt },
				],
				stream: false,
				options: { temperature: 0.9, num_predict: 256, top_p: 0.95 },
			}),
		});

		if (!res.ok) return null;

		interface OllamaResponse {
			message: { content: string };
		}
		const data = (await res.json()) as OllamaResponse;
		let raw = data.message.content
			.replace(/```(?:json)?\s*|```\s*/g, "")
			.trim();

		if (!raw.startsWith("{")) {
			const start = raw.indexOf("{");
			const end = raw.lastIndexOf("}");
			if (start !== -1 && end > start) raw = raw.slice(start, end + 1);
		}

		const parsed = JSON.parse(raw) as {
			name?: string;
			conversation?: string;
			topic?: string;
		};
		if (!parsed.name || !parsed.conversation) return null;

		return {
			name: parsed.name,
			conversation: parsed.conversation,
			expect: category.expect,
			category: category.category,
			difficulty,
			topic: parsed.topic,
		};
	} catch {
		return null;
	}
}

async function main() {
	const scenarios: GeneratedScenario[] = [];
	let attempts = 0;
	const maxAttempts = TARGET_COUNT * 3;

	console.log(
		`generating ${TARGET_COUNT} independent scenarios using ${args.model}`,
	);

	for (const cat of CATEGORIES) {
		const perDifficulty = Math.ceil(cat.count / cat.difficulties.length);
		for (const diff of cat.difficulties) {
			let generated = 0;
			while (generated < perDifficulty && attempts < maxAttempts) {
				attempts++;
				const scenario = await generate(cat, diff);
				if (scenario) {
					scenarios.push(scenario);
					generated++;
					process.stdout.write(
						`  [${scenarios.length}/${TARGET_COUNT}] ${cat.category}/${diff}: ${scenario.name}\n`,
					);
				} else {
					process.stdout.write(
						`  [attempt ${attempts}] ${cat.category}/${diff}: generation failed, retrying\n`,
					);
				}
			}
		}
	}

	console.log(
		`\ngenerated ${scenarios.length} scenarios (${attempts} attempts)`,
	);

	const stats: Record<string, number> = {};
	for (const s of scenarios) stats[s.category] = (stats[s.category] ?? 0) + 1;
	console.log("by category:", JSON.stringify(stats, null, 2));

	writeFileSync(args.out!, JSON.stringify(scenarios, null, 2));
	console.log(`written to ${args.out}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
