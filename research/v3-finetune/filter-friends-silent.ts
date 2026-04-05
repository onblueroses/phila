// Filter gate-friends.jsonl to silent-only examples.
// Speak labels in this corpus mean "someone talked next", not "phila should speak".
// Silent labels are universally correct - keep those only.
//
// Usage: node --experimental-strip-types research/v3-finetune/filter-friends-silent.ts

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		input: { type: "string", default: "data/v3-finetune/gate-friends.jsonl" },
		output: {
			type: "string",
			default: "data/v3-finetune/gate-friends-silent.jsonl",
		},
	},
});

interface Message {
	role: string;
	content: string;
}
interface Example {
	messages: Message[];
}

const lines = readFileSync(args.input!, "utf-8")
	.trim()
	.split("\n")
	.filter(Boolean);
const kept: string[] = [];
let dropped = 0;

for (const line of lines) {
	const ex: Example = JSON.parse(line);
	const assistant = ex.messages[ex.messages.length - 1];
	if (assistant?.role !== "assistant") {
		dropped++;
		continue;
	}

	const decision = JSON.parse(assistant.content);
	if (decision.action === "silent") {
		kept.push(line);
	} else {
		dropped++;
	}
}

writeFileSync(args.output!, `${kept.join("\n")}\n`);
console.log(
	`Filtered: ${kept.length} silent kept, ${dropped} speak/invalid dropped (from ${lines.length} total)`,
);
console.log(`Output: ${args.output}`);
