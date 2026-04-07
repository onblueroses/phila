// Compiles the v4 fine-tuning dataset.
//
// Steps:
//   1. Load data/v3-finetune/train-v3.jsonl (3,799 records)
//   2. Replace every system prompt with current buildSystemPrompt() output
//   3. For speak records with reason "wrong fact" or "speak-correction":
//      add tools:["verify"] to the assistant response JSON
//   4. Load unchanged v4 category files from data/v4-finetune/ plus
//      updated v4.1 category files from research/finetune-data/
//   5. Check for holdout contamination (normalize + compare)
//   6. Concatenate, shuffle (seed 42), write
//      research/finetune-data/phila-ft-v4.1-train.jsonl
//
// Usage:
//   node --experimental-strip-types research/compile-train-v4.ts [--dry-run]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildSystemPrompt } from "../src/gate.ts";
import { holdoutScenarios } from "../test/scenarios.ts";

interface MessageRecord {
	role: string;
	content: string;
}

interface TrainingRecord {
	messages: [MessageRecord, MessageRecord, MessageRecord];
}

// Neutral profile — same as gen-finetune-data-v4.ts
const NEUTRAL_PROFILE = { chatId: "train", speakBias: 0, updatedAt: 0 };
const NEW_SYSTEM_PROMPT = buildSystemPrompt(NEUTRAL_PROFILE);
const LEGACY_V4_DIR = "data/v4-finetune";
const V41_DIR = "research/finetune-data";
const OUTPUT_PATH = `${V41_DIR}/phila-ft-v4.1-train.jsonl`;
const CATEGORY_INPUTS = [
	{
		categoryName: "recall-trigger",
		path: `${V41_DIR}/v4.1-recall-trigger.jsonl`,
	},
	{
		categoryName: "recall-negative",
		path: `${V41_DIR}/v4.1-recall-negative.jsonl`,
	},
	{
		categoryName: "verify-new",
		path: `${LEGACY_V4_DIR}/verify-new.jsonl`,
	},
	{
		categoryName: "facts-speak",
		path: `${LEGACY_V4_DIR}/facts-speak.jsonl`,
	},
	{
		categoryName: "facts-silent",
		path: `${LEGACY_V4_DIR}/facts-silent.jsonl`,
	},
	{
		categoryName: "direct-address-question",
		path: `${LEGACY_V4_DIR}/direct-address-question.jsonl`,
	},
	{
		categoryName: "already-corrected",
		path: `${V41_DIR}/v4.1-already-corrected.jsonl`,
	},
];

// Correction reason strings that should get tools:["verify"] added
const CORRECTION_REASONS = new Set(["wrong fact", "speak-correction"]);

function loadJsonl(path: string): TrainingRecord[] {
	if (!existsSync(path)) {
		console.warn(`  Skipping missing file: ${path}`);
		return [];
	}
	const lines = readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim());
	const records: TrainingRecord[] = [];
	for (let i = 0; i < lines.length; i++) {
		try {
			records.push(JSON.parse(lines[i]) as TrainingRecord);
		} catch {
			console.warn(`  [WARN] parse error at ${path}:${i + 1}, skipping`);
		}
	}
	return records;
}

function updateV3Record(record: TrainingRecord): TrainingRecord {
	const [, userMsg, asstMsg] = record.messages;

	// Replace system prompt with current version
	const newSystem: MessageRecord = {
		role: "system",
		content: NEW_SYSTEM_PROMPT,
	};

	// Parse assistant JSON — add tools:["verify"] if it's a correction
	let newAsstContent = asstMsg.content;
	try {
		const parsed = JSON.parse(asstMsg.content) as {
			action?: string;
			reason?: string;
			response?: string;
			tools?: string[];
		};
		if (
			parsed.action === "speak" &&
			parsed.reason &&
			CORRECTION_REASONS.has(parsed.reason) &&
			!parsed.tools?.includes("verify")
		) {
			parsed.tools = ["verify"];
			newAsstContent = JSON.stringify(parsed);
		}
	} catch {
		// Malformed assistant content — leave as-is
	}

	return {
		messages: [
			newSystem,
			userMsg,
			{ role: "assistant", content: newAsstContent },
		],
	};
}

// Seeded shuffle (mulberry32)
function mulberry32(seed: number): () => number {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle<T>(arr: T[], seed = 42): T[] {
	const result = [...arr];
	const rand = mulberry32(seed);
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

// Holdout contamination check
function buildHoldoutSet(): Set<string> {
	const holdouts = holdoutScenarios();
	return new Set(holdouts.map((s) => s.conversation.trim().toLowerCase()));
}

function normalizeConversation(userContent: string): string {
	return userContent.trim().toLowerCase();
}

// ---

const { values } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
	},
	strict: true,
});

const isDryRun = values["dry-run"] ?? false;

console.log("=== compile-train-v4.ts ===");
if (isDryRun) console.log("DRY RUN — no output written\n");

// Step 1: Load and update v3 base
console.log("Loading data/v3-finetune/train-v3.jsonl...");
const v3Records = loadJsonl("data/v3-finetune/train-v3.jsonl");
console.log(`  Loaded ${v3Records.length} v3 records`);

const updatedV3 = v3Records.map(updateV3Record);

// Count how many corrections got tools:["verify"] added
let verifyAdded = 0;
for (const r of updatedV3) {
	try {
		const parsed = JSON.parse(r.messages[2].content) as { tools?: string[] };
		if (parsed.tools?.includes("verify")) verifyAdded++;
	} catch {
		/* skip */
	}
}
console.log(`  Updated system prompts: ${updatedV3.length}`);
console.log(`  Added tools:["verify"] to ${verifyAdded} correction records`);

// Spot-check: verify system prompt contains tools vocabulary
const samplePrompt = updatedV3[0]?.messages[0]?.content ?? "";
const hasToolsVocab = samplePrompt.includes("tools");
console.log(
	`  System prompt includes tools section: ${hasToolsVocab ? "YES" : "NO ← PROBLEM"}`,
);

// Step 2: Load new v4/v4.1 category files
console.log(
	"\nLoading v4/v4.1 category files from data/v4-finetune/ and research/finetune-data/...",
);

const newRecords: TrainingRecord[] = [];
const categoryCounts: Record<string, number> = {};

for (const { categoryName, path } of CATEGORY_INPUTS) {
	const records = loadJsonl(path);
	categoryCounts[categoryName] = records.length;
	newRecords.push(...records);
	console.log(`  ${categoryName}: ${records.length} records (${path})`);
}

console.log(`  Total new records: ${newRecords.length}`);

// Step 3: Holdout contamination check
console.log("\nChecking for holdout contamination...");
const holdoutSet = buildHoldoutSet();
let excluded = 0;
const allRecords: TrainingRecord[] = [];

for (const record of [...updatedV3, ...newRecords]) {
	const userContent = record.messages[1]?.content ?? "";
	const normalized = normalizeConversation(userContent);
	if (holdoutSet.has(normalized)) {
		excluded++;
		console.warn(`  [EXCLUDED] holdout collision detected`);
	} else {
		allRecords.push(record);
	}
}

console.log(`  Holdout collisions detected and excluded: ${excluded}`);

// Step 4: Shuffle and write
console.log(`\nShuffling ${allRecords.length} records (seed: 42)...`);
const shuffled = shuffle(allRecords, 42);

// Category summary
const stats = {
	v3_base: updatedV3.length,
	v3_corrections_with_verify: verifyAdded,
	...categoryCounts,
	total: shuffled.length,
	holdout_excluded: excluded,
};

console.log("\n=== Summary ===");
for (const [k, v] of Object.entries(stats)) {
	console.log(`  ${k}: ${v}`);
}

if (!isDryRun) {
	const jsonl = `${shuffled.map((r) => JSON.stringify(r)).join("\n")}\n`;
	mkdirSync(V41_DIR, { recursive: true });
	writeFileSync(OUTPUT_PATH, jsonl);
	console.log(`\nWritten ${shuffled.length} records to ${OUTPUT_PATH}`);
} else {
	console.log(`\n[DRY RUN] Would write ${OUTPUT_PATH} with above stats.`);
}
