// Compiles the v5 fine-tuning dataset.
//
// Strategy: v4's proven 4,711 records + ~70 new already-corrected examples.
// Only the already-corrected category changes. Everything else is v4 verbatim.
//
// Steps:
//   1. Load data/v4-finetune/train-v4.jsonl (4,711 records) as base
//   2. Load new v5 already-corrected from data/v5-finetune/already-corrected-v5.jsonl
//   3. Check for holdout contamination
//   4. Concatenate, shuffle (seed 42), write research/finetune-data/phila-ft-v5-train.jsonl
//
// Usage:
//   node --experimental-strip-types research/compile-train-v5.ts [--dry-run]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { holdoutScenarios } from "../test/scenarios.ts";

interface MessageRecord {
	role: string;
	content: string;
}

interface TrainingRecord {
	messages: [MessageRecord, MessageRecord, MessageRecord];
}

const V5_DIR = "research/finetune-data";
const OUTPUT_PATH = `${V5_DIR}/phila-ft-v5-train.jsonl`;

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

console.log("=== compile-train-v5.ts ===");
if (isDryRun) console.log("DRY RUN — no output written\n");

// Step 1: Load v4 base (all 4,711 records, already compiled and proven)
console.log("Loading data/v4-finetune/train-v4.jsonl (v4 base)...");
const v4Records = loadJsonl("data/v4-finetune/train-v4.jsonl");
console.log(`  Loaded ${v4Records.length} v4 base records`);

// Step 2: Load new v5 already-corrected examples
console.log("\nLoading v5 already-corrected additions...");
const v5New = loadJsonl("data/v5-finetune/already-corrected-v5.jsonl");
console.log(`  Loaded ${v5New.length} new already-corrected records`);

// Validate: all new records should be action:silent
let invalidAction = 0;
for (const record of v5New) {
	try {
		const parsed = JSON.parse(record.messages[2].content) as {
			action?: string;
		};
		if (parsed.action !== "silent") {
			invalidAction++;
			console.warn(
				`  [WARN] non-silent action in v5 addition: ${parsed.action}`,
			);
		}
	} catch {
		invalidAction++;
		console.warn("  [WARN] unparseable assistant content in v5 addition");
	}
}
if (invalidAction > 0) {
	console.error(
		`  ERROR: ${invalidAction} records have wrong action (expected silent)`,
	);
	process.exit(1);
}

// Step 3: Holdout contamination check
console.log("\nChecking for holdout contamination...");
const holdoutSet = buildHoldoutSet();
let excluded = 0;
const allRecords: TrainingRecord[] = [];

for (const record of [...v4Records, ...v5New]) {
	const userContent = record.messages[1]?.content ?? "";
	const normalized = normalizeConversation(userContent);
	if (holdoutSet.has(normalized)) {
		excluded++;
		console.warn("  [EXCLUDED] holdout collision detected");
	} else {
		allRecords.push(record);
	}
}

console.log(`  Holdout collisions detected and excluded: ${excluded}`);

// Step 4: Shuffle and write
console.log(`\nShuffling ${allRecords.length} records (seed: 42)...`);
const shuffled = shuffle(allRecords, 42);

const stats = {
	v4_base: v4Records.length,
	v5_already_corrected_new: v5New.length,
	total: shuffled.length,
	holdout_excluded: excluded,
};

console.log("\n=== Summary ===");
for (const [k, v] of Object.entries(stats)) {
	console.log(`  ${k}: ${v}`);
}

if (!isDryRun) {
	const jsonl = `${shuffled.map((r) => JSON.stringify(r)).join("\n")}\n`;
	mkdirSync(V5_DIR, { recursive: true });
	writeFileSync(OUTPUT_PATH, jsonl);
	console.log(`\nWritten ${shuffled.length} records to ${OUTPUT_PATH}`);
} else {
	console.log(`\n[DRY RUN] Would write ${OUTPUT_PATH} with above stats.`);
}
