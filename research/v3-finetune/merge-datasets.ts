// Merge all v3 fine-tuning data sources into train.jsonl + holdout.jsonl.
// Gate-only: no memory-extract or memory-recall. Friends filtered to silent-only.
// Applies: format validation, contamination check, deduplication, stratified 80/20 split.
//
// Usage: node --experimental-strip-types research/v3-finetune/merge-datasets.ts
//
// Expects data files in data/v3-finetune/:
//   gate-friends-silent.jsonl  (Friends silent-only, casual)
//   gate-synthetic.jsonl       (Flash-generated, casual)
//   gate-synthetic-v3.jsonl    (v3 speak-weighted generation)
//   gate-opus-independent.jsonl (distribution-gap examples)
//   adversarial-opus.jsonl     (Opus edge cases)

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		dir: { type: "string", default: "data/v3-finetune" },
		"train-ratio": { type: "string", default: "0.8" },
	},
});

const DIR = args.dir!;
const TRAIN_RATIO = parseFloat(args["train-ratio"]!);

interface Message {
	role: string;
	content: string;
}
interface Example {
	messages: Message[];
}

const SOURCES = [
	// gate-synthetic.jsonl (v1) dropped: old weights, dilutes speak ratio below 55% target
	{
		file: "gate-friends-silent.jsonl",
		category: "gate-friends",
		maxExamples: 600,
	},
	{ file: "gate-synthetic-v3.jsonl", category: "gate-synthetic-v3" },
	{ file: "gate-opus-independent.jsonl", category: "gate-opus-independent" },
	{ file: "adversarial-opus.jsonl", category: "adversarial" },
] as const;

function loadAndValidate(
	filepath: string,
	category: string,
): { examples: Example[]; invalid: number } {
	if (!existsSync(filepath)) {
		console.log(`  SKIP: ${filepath} (not found)`);
		return { examples: [], invalid: 0 };
	}

	const lines = readFileSync(filepath, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean);
	const examples: Example[] = [];
	let invalid = 0;

	for (const line of lines) {
		try {
			const ex = JSON.parse(line) as Example;
			// Validate: must have messages array with system, user, assistant
			if (!ex.messages || ex.messages.length < 3) {
				invalid++;
				continue;
			}
			if (ex.messages[0].role !== "system") {
				invalid++;
				continue;
			}
			if (ex.messages[1].role !== "user") {
				invalid++;
				continue;
			}
			if (ex.messages[2].role !== "assistant") {
				invalid++;
				continue;
			}
			// Validate assistant is valid JSON
			try {
				JSON.parse(ex.messages[2].content);
			} catch {
				invalid++;
				continue;
			}
			examples.push(ex);
		} catch {
			invalid++;
		}
	}

	console.log(
		`  ${category}: ${examples.length} valid, ${invalid} invalid (${filepath})`,
	);
	return { examples, invalid };
}

// Simple hash for dedup (conversation text)
function exampleHash(ex: Example): string {
	return ex.messages[1].content
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.slice(0, 200);
}

// Normalize conversation text for contamination matching
function normalizeConvo(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function contentHash(text: string): string {
	return createHash("sha256").update(normalizeConvo(text)).digest("hex");
}

function loadBenchmarkHashes(): Set<string> {
	const hashes = new Set<string>();

	// Load builtin scenarios from test/scenarios.ts
	// Extract conversation strings via regex, then unescape JS string literals
	// so \n becomes real newlines (matching how they appear in training JSONL)
	const scenariosPath = "test/scenarios.ts";
	if (existsSync(scenariosPath)) {
		const src = readFileSync(scenariosPath, "utf-8");
		const convos = [...src.matchAll(/conversation:\s*['"`]([\s\S]*?)['"`]/g)];
		for (const m of convos) {
			const unescaped = m[1]
				?.replace(/\\n/g, "\n")
				.replace(/\\t/g, "\t")
				.replace(/\\'/g, "'")
				.replace(/\\"/g, '"');
			hashes.add(contentHash(unescaped));
		}
		console.log(`  Loaded ${convos.length} builtin scenario hashes`);
	}

	// Load independent scenarios
	const indPath = "research/independent-scenarios.json";
	if (existsSync(indPath)) {
		const scenarios = JSON.parse(readFileSync(indPath, "utf-8")) as {
			conversation: string;
		}[];
		for (const s of scenarios) {
			hashes.add(contentHash(s.conversation));
		}
		console.log(`  Loaded ${scenarios.length} independent scenario hashes`);
	}

	return hashes;
}

function main() {
	console.log("=== Merging v3 fine-tuning datasets ===\n");

	// Load all sources
	const allExamples: { example: Example; category: string }[] = [];
	let totalInvalid = 0;

	for (const source of SOURCES) {
		const filepath = `${DIR}/${source.file}`;
		let { examples, invalid } = loadAndValidate(filepath, source.category);
		if (
			"maxExamples" in source &&
			source.maxExamples &&
			examples.length > source.maxExamples
		) {
			// Random sample to cap size
			for (let i = examples.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				const tmp = examples[i]!;
				examples[i] = examples[j]!;
				examples[j] = tmp;
			}
			console.log(
				`  -> capped ${source.category} from ${examples.length} to ${source.maxExamples}`,
			);
			examples = examples.slice(0, source.maxExamples);
		}
		for (const ex of examples) {
			allExamples.push({ example: ex, category: source.category });
		}
		totalInvalid += invalid;
	}

	console.log(
		`\nTotal loaded: ${allExamples.length} valid, ${totalInvalid} invalid`,
	);

	// Exact-match dedup on conversation text
	const seen = new Set<string>();
	const deduped: typeof allExamples = [];
	let dupes = 0;

	for (const item of allExamples) {
		const hash = exampleHash(item.example);
		if (seen.has(hash)) {
			dupes++;
			continue;
		}
		seen.add(hash);
		deduped.push(item);
	}

	console.log(
		`Dedup: removed ${dupes} exact duplicates (${deduped.length} remaining)`,
	);

	// Contamination check against benchmark scenarios
	console.log(`\nContamination check:`);
	const benchmarkHashes = loadBenchmarkHashes();
	let contaminated = 0;
	const clean: typeof deduped = [];

	for (const item of deduped) {
		const userText = item.example.messages[1]?.content;
		if (benchmarkHashes.has(contentHash(userText))) {
			contaminated++;
			console.log(`  REJECTED: ${userText.slice(0, 80)}...`);
		} else {
			clean.push(item);
		}
	}

	console.log(
		`Contamination: ${contaminated} matches removed (${clean.length} remaining)`,
	);
	if (contaminated > 0) {
		console.log(
			`  WARNING: ${contaminated} training examples matched benchmark scenarios!`,
		);
	}

	// Shuffle
	for (let i = clean.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const tmp = clean[i]!;
		clean[i] = clean[j]!;
		clean[j] = tmp;
	}

	// Stratified split by category
	const byCategory = new Map<string, typeof allExamples>();
	for (const item of clean) {
		const cat = byCategory.get(item.category) ?? [];
		cat.push(item);
		byCategory.set(item.category, cat);
	}

	const train: Example[] = [];
	const holdout: Example[] = [];

	for (const [cat, items] of byCategory) {
		const splitIdx = Math.floor(items.length * TRAIN_RATIO);
		for (let i = 0; i < items.length; i++) {
			if (i < splitIdx) train.push(items[i]?.example);
			else holdout.push(items[i]?.example);
		}
		console.log(
			`  ${cat}: ${splitIdx} train, ${items.length - splitIdx} holdout`,
		);
	}

	// Shuffle train and holdout
	for (let i = train.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const tmp = train[i]!;
		train[i] = train[j]!;
		train[j] = tmp;
	}
	for (let i = holdout.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const tmp = holdout[i]!;
		holdout[i] = holdout[j]!;
		holdout[j] = tmp;
	}

	// Write
	const trainPath = `${DIR}/train-v3.jsonl`;
	const holdoutPath = `${DIR}/holdout-v3.jsonl`;

	writeFileSync(
		trainPath,
		`${train.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);
	writeFileSync(
		holdoutPath,
		`${holdout.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);

	console.log(`\n=== Output ===`);
	console.log(`Train: ${train.length} examples -> ${trainPath}`);
	console.log(`Holdout: ${holdout.length} examples -> ${holdoutPath}`);
	console.log(`Total: ${train.length + holdout.length}`);
}

main();
