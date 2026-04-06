// @deprecated — v3 campaign (2026-04-06) proved dual adds nothing over mono.
// Mono ft-v3: 93.3% independent, 93.6% builtin.
// Dual ft-v3: 93.1% independent, 93.6% builtin (-0.2pp on independent).
// The v3 gate is strong enough that Pass 2 never catches anything Pass 1 missed,
// and the extra inference pass adds ~400ms latency + occasional false speaks.
//
// Kept for backward compatibility with benchmark.ts --gate dual.
// Do not use in production. Use monolithic gate (gate.ts evaluate()) instead.
//
// Original architecture:
// Pass 1: Monolithic gate -> SPEAK? done. SILENT? -> Pass 2
// Pass 2: Memory-recall check (semantic similarity + fact store)

import { buildConversation, evaluate, parseDecision } from "./gate.ts";
import type { Memory } from "./memory.ts";
import { chat, embed } from "./ollama.ts";
import { findRelevantFacts } from "./similarity.ts";
import type {
	ChatMessage,
	ConversationContext,
	ExtractedFact,
	GateDecision,
	GroupProfile,
	HierarchicalDecision,
	PhilaConfig,
} from "./types.ts";
import { GateAction } from "./types.ts";

const SILENT: GateDecision = { action: GateAction.SILENT };

// @deprecated - kept for A/B benchmark comparison against semantic similarity
// Regex gate: only allow Pass 2 when the last few messages look like a recall question.
export const MEMORY_QUERY_PATTERNS = [
	/\bwhere\b.{0,30}(going|meeting|is it|the \w+)/i, // "where are we going tonight"
	/\bwhat time\b/i, // "what time did we say"
	/\bwho is\b.{0,20}(bringing|getting|picking|driving)/i, // "who is bringing drinks"
	/\bwho said\b/i, // "who said they'd drive"
	/\bwhos\b.{0,20}(bringing|getting|picking|driving|coming)/i, // "whos driving"
	/\bremind me\b/i, // "remind me where"
	/\bwhat was\b/i, // "what was the address"
	/\bwhen did\b/i, // "when did we say"
	/\bwhen is\b/i, // "when is the party"
	/\bwhat day\b/i, // "what day was the party"
	/\bwhich\b.{0,15}(place|restaurant|one|flight)/i, // "which restaurant"
	/\bwhat did\b.*\bsay\b/i, // "what did person2 say"
	/\bdidnt\b.*\bsay\b/i, // "didnt you say you were allergic"
	/\bisnt\b.*\b(allergic|vegetarian|vegan)\b/i, // "isnt someone allergic"
	/\bcan\b.*\b(eat|have)\b/i, // "can everyone eat pepperoni"
	/\bhas anyone\b.*\bconfirm/i, // "has anyone confirmed"
	/\bagain\b/i, // "what time again"
	/\bwho\b.{0,10}\b(has|got|bought)\b/i, // "who has the tickets"
];

// @deprecated - kept for A/B benchmark comparison against semantic similarity
export function looksLikeMemoryQuery(messages: ChatMessage[]): boolean {
	// Check last 3 messages for recall patterns
	const tail = messages.slice(-3);
	return tail.some((m) => MEMORY_QUERY_PATTERNS.some((p) => p.test(m.text)));
}

// Pass 2 prompt: answer from extracted facts. Only reached after regex gate + fact store match.
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

function buildMemoryPrompt(
	conversation: string,
	facts: ExtractedFact[],
): string {
	const factLines = facts
		.map((f) => `- ${f.type}: ${f.key} = ${f.value}`)
		.join("\n");
	return `conversation:\n${conversation}\n\nfacts from earlier in this chat:\n${factLines}`;
}

export async function evaluateDual(
	messages: ChatMessage[],
	recent: ChatMessage[],
	profile: GroupProfile,
	config: PhilaConfig,
	ctx?: ConversationContext,
	memory?: Memory,
): Promise<HierarchicalDecision> {
	const stages: string[] = [];

	// Pass 1: monolithic gate (unchanged)
	const pass1 = await evaluate(recent, profile, config, ctx);
	stages.push(`p1:${pass1.action}`);

	if (pass1.action === GateAction.SPEAK) {
		return { ...pass1, stages, classification: "claim" };
	}

	// Pass 2: memory-recall (only when Pass 1 said SILENT + regex match + facts exist)
	if (!memory) {
		stages.push("p2:skip-no-memory");
		return { ...SILENT, stages, classification: "social" };
	}

	// Semantic similarity gate: embed batch messages, find relevant facts by cosine similarity.
	// Embed all messages in the batch (not just the last) to catch recall queries
	// buried in a burst like ["what time again?", "lol"].
	const chatId = messages[0]?.chatId ?? "";
	const batchTexts = messages.map((m) => m.text);
	let bestFacts: ExtractedFact[] = [];

	const factsWithEmbeddings = memory.getFactsWithEmbeddings(chatId, 20);

	if (factsWithEmbeddings.length > 0) {
		// Try semantic similarity against each message in the batch
		for (const text of batchTexts) {
			try {
				const queryEmbedding = await embed(text, config);
				const found = findRelevantFacts(queryEmbedding, factsWithEmbeddings);
				if (found.length > bestFacts.length) bestFacts = found;
			} catch {
				// Embedding failed for this message, try next
			}
		}
	}

	// Fallback: if no embedded facts exist (pre-migration or embed failures),
	// check for non-embedded facts with the deprecated regex gate
	if (factsWithEmbeddings.length === 0) {
		if (looksLikeMemoryQuery(messages)) {
			const fallbackFacts = memory.getRecentFacts(chatId, 20);
			if (fallbackFacts.length > 0) {
				bestFacts = fallbackFacts;
				stages.push("p2:regex-fallback");
			}
		}
	}

	if (bestFacts.length === 0) {
		stages.push("p2:skip-no-relevant-facts");
		return { ...SILENT, stages, classification: "social" };
	}

	stages.push(`p2:semantic-match+${bestFacts.length}-facts`);
	const conversation = buildConversation(recent);
	const userMsg = buildMemoryPrompt(conversation, bestFacts);
	const raw = await chat(MEMORY_CHECK_SYSTEM, userMsg, config);
	stages.push("p2:memory-check");
	const decision = parseDecision(raw);

	if (decision.action === GateAction.SPEAK) {
		stages.push("p2:speak");
		return { ...decision, stages, classification: "memory-query" };
	}

	stages.push("p2:silent");
	return { ...SILENT, stages, classification: "social" };
}
