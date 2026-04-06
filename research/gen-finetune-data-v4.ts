// Generates v4 fine-tuning training data for phila gate model.
//
// New categories (tools field behaviors):
//   recall-trigger   - SILENT + tools:["recall"] when someone references prior chat
//   recall-negative  - SPEAK or SILENT without tools (general knowledge / current context)
//   verify-new       - SPEAK + wrong fact + tools:["verify"]
//   facts-speak      - SPEAK using injected facts from system prompt
//   facts-silent     - SILENT when facts are present but not relevant
//   direct-address-question - SPEAK (rule 1 always wins when phila is named)
//   already-corrected       - SILENT (correction already happened in chat)
//   all              - generate all categories at default counts
//
// Usage:
//   node --experimental-strip-types research/gen-finetune-data-v4.ts \
//     --category <name>|all --count N --out <path> [--validate]
//
// Always run with CLAUDECODE='' to suppress claude-code env detection.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildSystemPrompt } from "../src/gate.ts";
import type { ExtractedFact } from "../src/types.ts";

interface TrainingRecord {
	messages: [
		{ role: "system"; content: string },
		{ role: "user"; content: string },
		{ role: "assistant"; content: string },
	];
}

interface GeneratedV4Example {
	conversation: string;
	action: "silent" | "speak";
	reason?: string;
	response?: string;
	tools?: string[];
}

const NEUTRAL_PROFILE = { chatId: "train", speakBias: 0, updatedAt: 0 };
const SYSTEM_PROMPT = buildSystemPrompt(NEUTRAL_PROFILE);

// Sample facts pools for facts-inject categories. Each batch picks one set
// so the training data has varied fact types and topics.
const SAMPLE_FACTS_POOL: ExtractedFact[][] = [
	[
		{
			chatId: "train",
			type: "logistics",
			key: "meeting_time",
			value: "7pm at the italian place on main",
			messageId: 1,
			timestamp: 0,
		},
	],
	[
		{
			chatId: "train",
			type: "commitment",
			key: "whos_driving",
			value: "person2 said theyd drive",
			messageId: 1,
			timestamp: 0,
		},
		{
			chatId: "train",
			type: "logistics",
			key: "pickup_time",
			value: "leaving at 6:30",
			messageId: 2,
			timestamp: 0,
		},
	],
	[
		{
			chatId: "train",
			type: "personal",
			key: "allergy",
			value: "person1 is allergic to shellfish",
			messageId: 1,
			timestamp: 0,
		},
	],
	[
		{
			chatId: "train",
			type: "preference",
			key: "dietary",
			value: "person3 is vegetarian",
			messageId: 1,
			timestamp: 0,
		},
		{
			chatId: "train",
			type: "logistics",
			key: "restaurant",
			value: "going to the thai place not the pizza spot",
			messageId: 2,
			timestamp: 0,
		},
	],
	[
		{
			chatId: "train",
			type: "commitment",
			key: "who_brings_drinks",
			value: "person2 said theyd handle drinks",
			messageId: 1,
			timestamp: 0,
		},
		{
			chatId: "train",
			type: "commitment",
			key: "who_brings_food",
			value: "person1 handling snacks",
			messageId: 2,
			timestamp: 0,
		},
	],
	[
		{
			chatId: "train",
			type: "logistics",
			key: "game_night_date",
			value: "saturday the 15th at 8pm",
			messageId: 1,
			timestamp: 0,
		},
		{
			chatId: "train",
			type: "personal",
			key: "cant_make_it",
			value: "person4 said they have work that night",
			messageId: 2,
			timestamp: 0,
		},
	],
	[
		{
			chatId: "train",
			type: "logistics",
			key: "airbnb",
			value: "4 bedroom place in the mountains, person1 booked it",
			messageId: 1,
			timestamp: 0,
		},
		{
			chatId: "train",
			type: "commitment",
			key: "cost_split",
			value: "everyone pays 80 bucks",
			messageId: 2,
			timestamp: 0,
		},
	],
	[
		{
			chatId: "train",
			type: "personal",
			key: "birthday",
			value: "person2's birthday is march 15th",
			messageId: 1,
			timestamp: 0,
		},
	],
];

function factsSystemPrompt(facts: ExtractedFact[]): string {
	return buildSystemPrompt(NEUTRAL_PROFILE, undefined, facts);
}

function makeRecord(
	systemPrompt: string,
	conversation: string,
	assistantJson: string,
): TrainingRecord {
	return {
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: conversation },
			{ role: "assistant", content: assistantJson },
		],
	};
}

function callClaude(prompt: string): string {
	try {
		return execFileSync("claude", ["--print", prompt], {
			encoding: "utf8",
			maxBuffer: 20 * 1024 * 1024,
			env: { ...process.env, CLAUDECODE: "" },
		});
	} catch (e) {
		console.warn("claude --print failed:", e instanceof Error ? e.message : e);
		return "";
	}
}

function stripFences(raw: string): string {
	const lines = raw.split("\n");
	const start = /^```(?:json)?\s*$/.test(lines[0]?.trim() ?? "") ? 1 : 0;
	const end = /^```\s*$/.test(lines[lines.length - 1]?.trim() ?? "")
		? lines.length - 1
		: lines.length;
	return lines.slice(start, end).join("\n").trim();
}

function extractJsonArray(raw: string): string | null {
	const cleaned = stripFences(raw);
	const start = cleaned.indexOf("[");
	const end = cleaned.lastIndexOf("]");
	if (start === -1 || end <= start) return null;
	return cleaned.slice(start, end + 1);
}

function parseExamples(raw: string): GeneratedV4Example[] {
	const arr = extractJsonArray(raw);
	if (!arr) {
		console.warn("No JSON array found in claude output");
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(arr);
	} catch (e) {
		console.warn("JSON parse failed:", e instanceof Error ? e.message : e);
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const valid: GeneratedV4Example[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const s = item as Record<string, unknown>;
		if (typeof s.conversation !== "string") continue;
		if (s.action !== "silent" && s.action !== "speak") continue;
		if (
			s.action === "speak" &&
			(typeof s.reason !== "string" || typeof s.response !== "string")
		) {
			console.warn("Discarding speak example — missing reason or response");
			continue;
		}
		valid.push({
			conversation: s.conversation,
			action: s.action,
			reason: typeof s.reason === "string" ? s.reason : undefined,
			response: typeof s.response === "string" ? s.response : undefined,
			tools: Array.isArray(s.tools)
				? s.tools.filter((t) => typeof t === "string")
				: undefined,
		});
	}
	return valid;
}

// --- Category: recall-trigger ---
// Someone explicitly references prior conversation. Output: SILENT + tools:["recall"]

function buildRecallTriggerPrompt(count: number): string {
	return `You are generating fine-tuning data for "phila", a silent group chat bot.

System prompt context (phila's rules):
---
${SYSTEM_PROMPT}
---

Generate ${count} examples where someone in the group chat explicitly references something discussed EARLIER in the conversation — but the referenced thing is NOT visible in the current exchange. Phila should request its memory tools before deciding.

Rules:
- Someone says something like "wait what did person2 say earlier about...", "didn't we decide on X?", "what was that thing you mentioned?", "who said they'd do Y again?", "remind me what we landed on for..."
- The referenced information is NOT in the visible conversation (it was in a previous, now-scrolled-away part)
- The current visible conversation should be 2-5 messages, on a DIFFERENT topic
- Phila outputs {"action":"silent","tools":["recall"]} — it needs to search memory before deciding
- Do NOT generate examples where the answer is visible in the conversation
- Vary the types of things being referenced: plans, commitments, logistics, personal details, decisions

Return ONLY a JSON array. No prose, no markdown. Each element:
- "conversation": multi-line string with person1/person2/etc labels, \\n separated
- "action": "silent"
- "tools": ["recall"]

Example:
{"conversation":"person1: hey so we still on for tonight\\nperson2: yeah for sure\\nperson1: wait what time did we say again, i forgot","action":"silent","tools":["recall"]}

Another example:
{"conversation":"person2: lol this traffic is insane\\nperson1: same\\nperson3: hey who said theyd pick up person4, was that person1 or person2","action":"silent","tools":["recall"]}`;
}

// --- Category: recall-negative ---
// Questions that do NOT need recall. Output: SPEAK or SILENT, no tools.

function buildRecallNegativePrompt(count: number): string {
	return `You are generating fine-tuning data for "phila", a silent group chat bot.

System prompt context (phila's rules):
---
${SYSTEM_PROMPT}
---

Generate ${count} examples where phila should respond WITHOUT requesting memory recall. Mix of silent and speak.

Rules:
- Include questions about GENERAL KNOWLEDGE (capitals, dates, facts) → phila may SPEAK if directly asked or if question is unanswered by others, but NO recall needed
- Include questions where the ANSWER IS IN THE CURRENT CONVERSATION (person1 just said something, person3 asks about it) → no recall needed
- Include SOCIAL CHATTER where no recall is relevant → SILENT
- Include "phila what is X" direct-address questions about facts → SPEAK (rule 1)
- Do NOT generate anything that references "earlier" or "before" or implies scrolled-away context
- No "tools" field in any response

Return ONLY a JSON array. No prose, no markdown. Each element:
- "conversation": multi-line string, person1/person2/etc, \\n separated
- "action": "silent" or "speak"
- "reason": required if speak (e.g. "direct address", "unanswered question")
- "response": required if speak — lowercase, 1-2 sentences, casual

Example (speak, direct address):
{"conversation":"person1: hey guys\\nperson2: sup\\nperson1: phila what country is the nile in","action":"speak","reason":"direct address","response":"it runs through several countries but mostly egypt"}

Example (silent, general chatter):
{"conversation":"person1: anyone watching the game tonight\\nperson2: yeah coming over at 8\\nperson3: bring chips","action":"silent"}`;
}

// --- Category: verify-new ---
// Wrong fact, nobody corrected. Output: SPEAK + wrong fact + tools:["verify"]

function buildVerifyNewPrompt(count: number): string {
	return `You are generating fine-tuning data for "phila", a silent group chat bot.

System prompt context (phila's rules):
---
${SYSTEM_PROMPT}
---

Generate ${count} examples where someone states a WRONG FACT and nobody corrects them. Phila should correct it AND request fact verification.

Rules:
- Wrong fact must be stated genuinely (not sarcasm, not a joke)
- Others either agree, stay silent, or change topic — nobody corrects it
- Phila speaks to correct AND adds tools:["verify"] to verify before sending
- Wrong facts: wrong dates, wrong countries, wrong names, wrong numbers, wrong attributions
- Keep responses short, casual, lowercase
- The conversation should be 2-5 messages

Return ONLY a JSON array. No prose, no markdown. Each element:
- "conversation": multi-line string, person1/person2/etc, \\n separated
- "action": "speak"
- "reason": "wrong fact"
- "response": the correction — lowercase, 1-2 sentences, casual
- "tools": ["verify"]

Example:
{"conversation":"person1: the amazon river is in africa right\\nperson2: yeah i think so","action":"speak","reason":"wrong fact","response":"the amazon is in south america, mostly in brazil","tools":["verify"]}

Another example:
{"conversation":"person1: so shakespeare was born in 1616 right\\nperson2: sounds right to me","action":"speak","reason":"wrong fact","response":"shakespeare was born in 1564, he died in 1616","tools":["verify"]}`;
}

// --- Category: facts-speak ---
// System prompt has injected facts. Someone asks about the facts. SPEAK using them.

function buildFactsSpeakPrompt(count: number, facts: ExtractedFact[]): string {
	const factsDescription = facts.map((f) => `${f.key}: ${f.value}`).join(", ");
	const systemWithFacts = factsSystemPrompt(facts);

	return `You are generating fine-tuning data for "phila", a silent group chat bot.

The system prompt for this batch INCLUDES injected facts (things phila remembers from earlier):
---
${systemWithFacts}
---

Generate ${count} examples where someone in the chat asks about something covered by the injected facts AND phila should speak because it has the relevant information.

The facts available are: ${factsDescription}

Rules:
- Trigger: someone asks a question OR a factual query that the injected facts answer directly
- The question should be phrased naturally (not "what is the value of X" — more like "wait what time are we meeting?" or "who's bringing drinks again?")
- Phila speaks using the fact. Keep it casual, short.
- Trigger can be direct address ("phila do you remember what time...") or unanswered question ("does anyone know what time...")
- Do NOT add tools to these responses — facts are already injected, no recall needed

Return ONLY a JSON array. No prose, no markdown. Each element:
- "conversation": multi-line string, person1/person2/etc, \\n separated
- "action": "speak"
- "reason": "direct address" or "unanswered question" (whichever applies)
- "response": lowercase, casual, 1-2 sentences using the fact

Example (if facts include "meeting_time: 7pm at the italian place"):
{"conversation":"person1: hey what time are we meeting tonight\\nperson2: no idea","action":"speak","reason":"unanswered question","response":"7pm at the italian place"}`;
}

// --- Category: facts-silent ---
// System prompt has injected facts. Conversation doesn't trigger speaking. SILENT.

function buildFactsSilentPrompt(count: number, facts: ExtractedFact[]): string {
	const factsDescription = facts.map((f) => `${f.key}: ${f.value}`).join(", ");
	const systemWithFacts = factsSystemPrompt(facts);

	return `You are generating fine-tuning data for "phila", a silent group chat bot.

The system prompt for this batch INCLUDES injected facts (things phila remembers):
---
${systemWithFacts}
---

Generate ${count} examples where facts ARE injected but the conversation does NOT trigger phila to speak. Phila stays silent.

The facts available are: ${factsDescription}

Rules:
- Conversation is social chatter, opinions, emotions, logistics unrelated to the facts, etc.
- Nobody asks about the facts, nobody asks phila directly, no factual errors
- Phila stays SILENT (action: "silent")
- No tools field

Return ONLY a JSON array. No prose, no markdown. Each element:
- "conversation": multi-line string, person1/person2/etc, \\n separated
- "action": "silent"

Example (if facts include meeting time, but chat is about movies):
{"conversation":"person1: anyone seen the new dune\\nperson2: not yet\\nperson3: heard its good but long"}`;
}

// --- Category: direct-address-question ---
// "phila what is X?" - rule 1 always overrides, SPEAK even if it's a factual question.

function buildDirectAddressQuestionPrompt(count: number): string {
	return `You are generating fine-tuning data for "phila", a silent group chat bot.

System prompt context (phila's rules):
---
${SYSTEM_PROMPT}
---

Generate ${count} examples where phila is DIRECTLY ADDRESSED by name AND asked a factual question. Phila must SPEAK (rule 1 always overrides — being named is sufficient).

Rules:
- Someone says "phila" + asks a factual question in the same or next message
- Phila ALWAYS speaks when directly addressed (rule 1), even if it's also a factual question
- Do NOT stay silent, do NOT say it needs recall — rule 1 is absolute
- Keep responses lowercase, short, casual
- Vary questions: history, science, geography, general knowledge, "do you know...", "hey phila can you tell me..."
- Mix forms: "phila what is X", "hey phila do you know X", "phila X happened in what year", "phila can you explain X"

Return ONLY a JSON array. No prose, no markdown. Each element:
- "conversation": multi-line string, person1/person2/etc, \\n separated
- "action": "speak"
- "reason": "direct address"
- "response": lowercase, 1-2 sentences, the actual answer

Example:
{"conversation":"person1: random question\\nperson1: phila what year did the berlin wall fall","action":"speak","reason":"direct address","response":"1989"}

Another:
{"conversation":"person1: hey phila do you know what the largest ocean is","action":"speak","reason":"direct address","response":"the pacific, by a lot"}`;
}

// --- Category: already-corrected ---
// Someone stated wrong fact, someone else ALREADY corrected it. Phila stays SILENT.

function buildAlreadyCorrectedPrompt(count: number): string {
	return `You are generating fine-tuning data for "phila", a silent group chat bot.

System prompt context (phila's rules):
---
${SYSTEM_PROMPT}
---

Generate ${count} examples where someone states a WRONG FACT but another person in the chat already corrects it. Phila must stay SILENT — the error is handled.

Rules:
- person1 states a wrong fact
- person2 (or another person) corrects it using words like "actually", "no that's wrong", "nope", "that's not right", "it's actually", "correction:", "no it's", "pretty sure it's"
- Phila stays SILENT (action: "silent") — never piles on after a correction
- The conversation may continue after the correction (more messages)
- Vary correction styles: blunt corrections, gentle corrections, corrections with additional context

Return ONLY a JSON array. No prose, no markdown. Each element:
- "conversation": multi-line string, person1/person2/etc, \\n separated
- "action": "silent"

Example:
{"conversation":"person1: rome is the capital of italy right\\nperson2: yeah totally\\nperson3: actually yeah rome is correct\\nperson1: oh sweet thanks"}

Another:
{"conversation":"person1: einstein won the nobel prize for relativity\\nperson2: nope, it was actually for the photoelectric effect\\nperson1: oh really? huh"}

Another:
{"conversation":"person1: mount everest is in nepal and china right\\nperson2: its actually on the border of nepal and tibet (which is china yes)\\nperson1: ahh ok makes sense"}`;
}

// --- Record builder ---

function exampleToRecord(
	ex: GeneratedV4Example,
	systemPrompt: string,
): TrainingRecord | null {
	let assistantContent: string;
	if (ex.action === "silent") {
		if (ex.tools?.length) {
			assistantContent = JSON.stringify({ action: "silent", tools: ex.tools });
		} else {
			assistantContent = '{"action":"silent"}';
		}
	} else {
		if (!ex.reason || !ex.response) return null;
		const obj: Record<string, unknown> = {
			action: "speak",
			reason: ex.reason,
			response: ex.response,
		};
		if (ex.tools?.length) obj.tools = ex.tools;
		assistantContent = JSON.stringify(obj);
	}
	return makeRecord(systemPrompt, ex.conversation, assistantContent);
}

// --- Generation runner ---

function generateCategory(
	category: string,
	count: number,
	batchSize = 80,
): TrainingRecord[] {
	const records: TrainingRecord[] = [];
	let remaining = count;
	let batchIndex = 0;

	while (remaining > 0) {
		const batchCount = Math.min(batchSize, remaining);
		console.log(
			`  [${category}] batch ${batchIndex + 1}: requesting ${batchCount} examples...`,
		);

		let prompt: string;
		let systemPrompt = SYSTEM_PROMPT;

		if (category === "recall-trigger") {
			prompt = buildRecallTriggerPrompt(batchCount);
		} else if (category === "recall-negative") {
			prompt = buildRecallNegativePrompt(batchCount);
		} else if (category === "verify-new") {
			prompt = buildVerifyNewPrompt(batchCount);
		} else if (category === "facts-speak") {
			const facts = SAMPLE_FACTS_POOL[batchIndex % SAMPLE_FACTS_POOL.length];
			systemPrompt = factsSystemPrompt(facts);
			prompt = buildFactsSpeakPrompt(batchCount, facts);
		} else if (category === "facts-silent") {
			const facts = SAMPLE_FACTS_POOL[batchIndex % SAMPLE_FACTS_POOL.length];
			systemPrompt = factsSystemPrompt(facts);
			prompt = buildFactsSilentPrompt(batchCount, facts);
		} else if (category === "direct-address-question") {
			prompt = buildDirectAddressQuestionPrompt(batchCount);
		} else if (category === "already-corrected") {
			prompt = buildAlreadyCorrectedPrompt(batchCount);
		} else {
			console.error(`Unknown category: ${category}`);
			process.exit(1);
		}

		const raw = callClaude(prompt);
		const examples = parseExamples(raw);
		console.log(
			`  [${category}] got ${examples.length} (${batchCount - examples.length} discarded)`,
		);

		for (const ex of examples) {
			const record = exampleToRecord(ex, systemPrompt);
			if (record) records.push(record);
		}

		remaining -= batchCount;
		batchIndex++;
	}

	return records;
}

// --- Validation ---

function validateFile(path: string): {
	valid: number;
	invalid: number;
	total: number;
} {
	const lines = readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim());

	let valid = 0;
	let invalid = 0;

	for (let i = 0; i < lines.length; i++) {
		try {
			const record = JSON.parse(lines[i]) as { messages?: unknown[] };
			if (!Array.isArray(record.messages) || record.messages.length !== 3)
				throw new Error("messages must be array of 3");
			const [sys, user, asst] = record.messages as Array<{
				role?: string;
				content?: string;
			}>;
			if (sys.role !== "system")
				throw new Error(`bad role at [0]: ${sys.role}`);
			if (user.role !== "user")
				throw new Error(`bad role at [1]: ${user.role}`);
			if (asst.role !== "assistant")
				throw new Error(`bad role at [2]: ${asst.role}`);
			if (typeof sys.content !== "string" || sys.content.length === 0)
				throw new Error("system content empty");
			if (typeof user.content !== "string" || user.content.length === 0)
				throw new Error("user content empty");
			const parsed = JSON.parse(asst.content ?? "null") as {
				action?: string;
				tools?: unknown;
			};
			if (parsed.action !== "silent" && parsed.action !== "speak")
				throw new Error(`invalid action: ${parsed.action}`);
			// tools field must be array of strings if present
			if (parsed.tools !== undefined) {
				if (!Array.isArray(parsed.tools))
					throw new Error("tools must be array");
				for (const t of parsed.tools) {
					if (typeof t !== "string")
						throw new Error("tools must be array of strings");
				}
			}
			valid++;
		} catch (e) {
			invalid++;
			console.warn(
				`[INVALID] line ${i + 1}: ${e instanceof Error ? e.message : e}`,
			);
		}
	}

	return { valid, invalid, total: lines.length };
}

// --- Entry point ---

const CATEGORIES = [
	"recall-trigger",
	"recall-negative",
	"verify-new",
	"facts-speak",
	"facts-silent",
	"direct-address-question",
	"already-corrected",
];

const DEFAULT_COUNTS: Record<string, number> = {
	"recall-trigger": 200,
	"recall-negative": 100,
	"verify-new": 200,
	"facts-speak": 100,
	"facts-silent": 50,
	"direct-address-question": 100,
	"already-corrected": 150,
};

const { values } = parseArgs({
	options: {
		count: { type: "string" },
		category: { type: "string", default: "all" },
		out: { type: "string" },
		validate: { type: "boolean", default: false },
		outdir: { type: "string" },
	},
	strict: true,
});

// Validate-only mode
if (values.validate && !values.count && !values.out?.includes("{{")) {
	if (values.out && existsSync(values.out)) {
		const { valid, invalid, total } = validateFile(values.out);
		console.log(`Validation: ${valid}/${total} valid, ${invalid} invalid`);
		process.exit(invalid > 0 ? 1 : 0);
	}
}

if (!values.out && !values.outdir) {
	console.error(
		`Usage: node --experimental-strip-types research/gen-finetune-data-v4.ts
  --category ${CATEGORIES.join("|")}|all
  --count N              (per category, overrides defaults)
  --out <path>           (single file, for single --category)
  --outdir <dir>         (directory, for --category all)
  [--validate]

Default counts per category:
${Object.entries(DEFAULT_COUNTS)
	.map(([k, v]) => `  ${k}: ${v}`)
	.join("\n")}`,
	);
	process.exit(1);
}

const categories =
	values.category === "all" ? CATEGORIES : [values.category ?? "all"];

if (values.category !== "all" && !CATEGORIES.includes(values.category ?? "")) {
	console.error(
		`Unknown category: ${values.category}. Choose from: ${CATEGORIES.join(", ")}`,
	);
	process.exit(1);
}

for (const cat of categories) {
	const count = values.count ? parseInt(values.count, 10) : DEFAULT_COUNTS[cat];
	if (Number.isNaN(count) || count < 1) {
		console.error(`--count must be a positive integer (got: ${values.count})`);
		process.exit(1);
	}

	let outPath: string;
	if (values.out && categories.length === 1) {
		outPath = values.out;
	} else if (values.outdir) {
		outPath = `${values.outdir}/${cat}.jsonl`;
	} else {
		console.error("Use --out for single category or --outdir for all");
		process.exit(1);
	}

	const dir = outPath.split("/").slice(0, -1).join("/");
	if (dir) mkdirSync(dir, { recursive: true });

	console.log(`\nGenerating ${count} examples for category: ${cat}`);
	const records = generateCategory(cat, count);
	console.log(`  Total records: ${records.length}`);

	const jsonl = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
	writeFileSync(outPath, jsonl);
	console.log(`  Written to ${outPath}`);

	if (values.validate) {
		const { valid, invalid, total } = validateFile(outPath);
		console.log(`  Validation: ${valid}/${total} valid, ${invalid} invalid`);
		if (invalid > 0) {
			console.error(`  FAIL: ${invalid} invalid records`);
			process.exit(1);
		}
	}
}

console.log("\nDone.");
