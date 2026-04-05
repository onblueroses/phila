// Spot-check quality of gate training JSONL files.
// Samples random examples, reports action distribution, flags style/format issues.
//
// Usage: node --experimental-strip-types research/v3-finetune/audit-synthetic.ts [file] [--sample 60]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args, positionals } = parseArgs({
	options: {
		sample: { type: "string", default: "60" },
		verbose: { type: "boolean", default: false },
	},
	allowPositionals: true,
});

const file = positionals[0] ?? "data/v3-finetune/gate-synthetic.jsonl";
const sampleSize = parseInt(args.sample!, 10);

interface Message {
	role: string;
	content: string;
}
interface Example {
	messages: Message[];
}

const lines = readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
const total = lines.length;

// Parse all examples
const examples: { line: number; ex: Example; decision: any }[] = [];
const formatErrors: string[] = [];

for (let i = 0; i < lines.length; i++) {
	try {
		const ex: Example = JSON.parse(lines[i]!);
		if (ex.messages.length !== 3) {
			formatErrors.push(
				`Line ${i + 1}: expected 3 messages, got ${ex.messages.length}`,
			);
			continue;
		}
		if (
			ex.messages[0]?.role !== "system" ||
			ex.messages[1]?.role !== "user" ||
			ex.messages[2]?.role !== "assistant"
		) {
			formatErrors.push(
				`Line ${i + 1}: wrong role order: ${ex.messages.map((m) => m.role).join(",")}`,
			);
			continue;
		}
		const decision = JSON.parse(ex.messages[2]?.content);
		examples.push({ line: i + 1, ex, decision });
	} catch (e: any) {
		formatErrors.push(`Line ${i + 1}: parse error: ${e.message}`);
	}
}

// Distribution
const actions: Record<string, number> = {};
for (const { decision } of examples) {
	const a = decision.action ?? "unknown";
	actions[a] = (actions[a] ?? 0) + 1;
}

// Random sample for quality checks
const shuffled = [...examples].sort(() => Math.random() - 0.5);
const sample = shuffled.slice(0, Math.min(sampleSize, shuffled.length));

const issues: string[] = [];

for (const { line, ex, decision } of sample) {
	const user = ex.messages[1]?.content;
	const _assistant = ex.messages[2]?.content;

	// Style checks on speak responses
	if (decision.action === "speak") {
		const resp: string = decision.response ?? "";
		if (!decision.reason) issues.push(`Line ${line}: speak without reason`);
		if (!resp) issues.push(`Line ${line}: speak without response`);
		if (resp && resp[0] === resp[0]?.toUpperCase() && /^[A-Z]/.test(resp)) {
			issues.push(
				`Line ${line}: response starts uppercase: "${resp.slice(0, 50)}"`,
			);
		}
		if (
			resp.includes("Great question") ||
			resp.includes("Happy to help") ||
			resp.includes("I'd be happy")
		) {
			issues.push(`Line ${line}: AI-speak in response: "${resp.slice(0, 80)}"`);
		}
		if (resp.split(".").length > 4) {
			issues.push(
				`Line ${line}: response too long (>3 sentences): "${resp.slice(0, 80)}..."`,
			);
		}
	}

	// Check user message has chat format
	if (!user.includes(":")) {
		issues.push(
			`Line ${line}: user message missing chat format (no "person: msg" pattern)`,
		);
	}

	// Check for training data contamination markers
	if (user.includes("phila should") || user.includes("correct answer is")) {
		issues.push(`Line ${line}: possible meta-instruction leak in conversation`);
	}
}

// Report
console.log(`\n=== Audit Report: ${file} ===`);
console.log(`Total examples: ${total}`);
console.log(`Valid parsed: ${examples.length}`);
console.log(`Format errors: ${formatErrors.length}`);
console.log(`\nAction distribution:`);
for (const [action, count] of Object.entries(actions).sort(
	(a, b) => b[1] - a[1],
)) {
	console.log(
		`  ${action}: ${count} (${((count / examples.length) * 100).toFixed(1)}%)`,
	);
}

console.log(`\nSampled ${sample.length} for quality checks:`);
console.log(`  Issues found: ${issues.length}`);
const issueRate = ((issues.length / sample.length) * 100).toFixed(1);
console.log(`  Issue rate: ${issueRate}%`);

if (formatErrors.length > 0) {
	console.log(`\nFormat errors (first 10):`);
	for (const e of formatErrors.slice(0, 10)) console.log(`  ${e}`);
}

if (issues.length > 0) {
	console.log(`\nQuality issues (first 20):`);
	for (const issue of issues.slice(0, 20)) console.log(`  ${issue}`);
}

if (args.verbose) {
	console.log(`\nSample speak examples:`);
	const speaks = sample
		.filter((s) => s.decision.action === "speak")
		.slice(0, 5);
	for (const { line, decision } of speaks) {
		console.log(
			`  Line ${line}: reason="${decision.reason}", response="${(decision.response ?? "").slice(0, 100)}"`,
		);
	}
}

console.log(
	`\n${parseFloat(issueRate) < 5 ? "PASS" : "REVIEW NEEDED"}: ${issueRate}% issue rate (threshold: <5%)`,
);
