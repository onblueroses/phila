// Normalize style of speak responses in gate training JSONL files.
// Fixes: uppercase starts, AI-speak phrases, overly long responses.
// Operates in-place on the file.
//
// Usage: node --experimental-strip-types research/v3-finetune/style-cleanup.ts <file.jsonl>

import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("Usage: style-cleanup.ts <file.jsonl>");
	process.exit(1);
}

interface Message {
	role: string;
	content: string;
}
interface Example {
	messages: Message[];
}

const AI_SPEAK = [
	/\bgreat question\b/i,
	/\bhappy to help\b/i,
	/\bi'd be happy\b/i,
	/\bI can definitely\b/i,
	/\bAbsolutely[!,]/i,
	/\bOf course[!,]/i,
	/\bI think you'll find\b/i,
	/\blet me help\b/i,
	/\bI can help with\b/i,
];

const lines = readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
let fixed = 0;
let aiSpeakFixed = 0;
let truncated = 0;
const output: string[] = [];

for (const line of lines) {
	const ex: Example = JSON.parse(line);
	const assistant = ex.messages[ex.messages.length - 1]!;
	const decision = JSON.parse(assistant.content);

	if (decision.action === "speak" && decision.response) {
		let resp: string = decision.response;
		let changed = false;

		// Lowercase first character
		if (/^[A-Z]/.test(resp)) {
			resp = resp[0]?.toLowerCase() + resp.slice(1);
			changed = true;
		}

		// Strip AI-speak prefixes
		for (const pattern of AI_SPEAK) {
			if (pattern.test(resp)) {
				resp = resp.replace(pattern, "").replace(/^[\s,!.]+/, "");
				if (resp.length > 0) {
					resp = resp[0]?.toLowerCase() + resp.slice(1);
				}
				aiSpeakFixed++;
				changed = true;
			}
		}

		// Truncate to ~2 sentences max
		const sentences = resp.split(/(?<=[.!?])\s+/);
		if (sentences.length > 3) {
			resp = sentences.slice(0, 2).join(" ");
			truncated++;
			changed = true;
		}

		// Strip trailing period if single sentence (casual style)
		if (!resp.includes(".") || resp.split(".").filter(Boolean).length <= 1) {
			resp = resp.replace(/\.\s*$/, "");
		}

		if (changed) {
			decision.response = resp;
			assistant.content = JSON.stringify(decision);
			fixed++;
		}
	}

	output.push(JSON.stringify(ex));
}

writeFileSync(file, `${output.join("\n")}\n`);

console.log(`\n=== Style Cleanup: ${file} ===`);
console.log(`Total examples: ${lines.length}`);
console.log(`Fixed: ${fixed} (${((fixed / lines.length) * 100).toFixed(1)}%)`);
console.log(`  Lowercase: ${fixed}`);
console.log(`  AI-speak removed: ${aiSpeakFixed}`);
console.log(`  Truncated: ${truncated}`);
console.log(
	`${fixed / lines.length < 0.05 ? "CLEAN" : "CLEANED"}: ${((fixed / lines.length) * 100).toFixed(1)}% modified`,
);
