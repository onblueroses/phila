// Hierarchical gate v2: binary filter + monolithic fallback.
//
// Stage 0 (rule-based, 0ms): direct address detection, context gate
// Stage 1 (LLM, numPredict=8): binary "social or not?" filter - fast exit for 95%
// Stage 2 (LLM, full monolithic prompt): for non-social, use the proven gate prompt
//
// Previous approach (4-way classification + stripped Stage 2 prompts) failed:
// numPredict=4 recall 0.263, numPredict=8 recall 0.192. The stripped Stage 2
// prompts lacked the examples and persona that make the monolithic gate work at 94.1%.
//
// This approach keeps the monolithic gate's proven accuracy for the 5% that matters
// and only decomposes the fast-exit path for the 95% social case.

import { buildConversation, buildSystemPrompt, parseDecision } from "./gate.ts";
import { chat, chatFast } from "./ollama.ts";
import type {
	ChatMessage,
	Classification,
	ConversationContext,
	GateDecision,
	GroupProfile,
	HierarchicalDecision,
	PhilaConfig,
} from "./types.ts";
import { GateAction } from "./types.ts";

const SILENT: GateDecision = { action: GateAction.SILENT };

// Stage 0: direct address detection on the NEW batch only.
const DIRECT_ADDRESS_PATTERNS = [
	/^phila\s*[,?!]/i,
	/^phila\s+(do|can|what|how|will|would|should|did|does|whats|hows)\b/i,
	/\bhey\s+phila\b/i,
	/\byo\s+phila\b/i,
	/\bask\s+phila\b/i,
	/\bphila\s+(do|can|what|how|will|would|should|did|does|whats|hows)\b/i,
];

export function detectDirectAddress(messages: ChatMessage[]): boolean {
	for (const m of messages) {
		if (DIRECT_ADDRESS_PATTERNS.some((p) => p.test(m.text))) return true;
	}
	return false;
}

function contextGate(
	profile: GroupProfile,
	ctx?: ConversationContext,
): "suppress" | "continue" {
	if (profile.speakBias <= -0.15) return "suppress";
	if (
		ctx?.latestMessageHour != null &&
		(ctx.latestMessageHour >= 23 || ctx.latestMessageHour < 7)
	) {
		return "suppress";
	}
	if (ctx?.messagesPerMinute != null && ctx.messagesPerMinute > 5) {
		if (profile.speakBias <= -0.05) return "suppress";
	}
	return "continue";
}

// Stage 1: binary filter. "Is this just social chatter, or might phila need to act?"
// Simple binary question is easier for a 3B model than 4-way classification.
const FILTER_SYSTEM = `you decide if a group chat conversation needs attention or is just social chatter.

respond with ONLY one word:
- "social" if it's just chat, opinions, emotions, jokes, sarcasm, banter, planning between people, or reactions
- "attention" if someone stated a fact that might be wrong, asked a factual question nobody answered, or is asking about something said earlier in the conversation

most conversations are social. if unsure, say "social".`;

export function parseFilter(raw: string): "social" | "attention" {
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z]/g, "");
	if (cleaned.includes("attention")) return "attention";
	return "social";
}

// For backward compat with tests
export function parseStage1(raw: string): Classification {
	const filter = parseFilter(raw);
	if (filter === "attention") return "claim"; // Stage 2 will handle the details
	return "social";
}

export async function evaluateHierarchical(
	messages: ChatMessage[],
	profile: GroupProfile,
	config: PhilaConfig,
	ctx?: ConversationContext,
	recentHistory?: ChatMessage[],
): Promise<HierarchicalDecision> {
	const allMessages = recentHistory ?? messages;
	const conversation = buildConversation(allMessages);
	const stages: string[] = [];

	// Stage 0: direct address (current batch only)
	const isDirect = detectDirectAddress(messages);
	stages.push(`s0:${isDirect ? "direct" : "no-direct"}`);

	if (isDirect) {
		// Direct address uses the full monolithic prompt (it handles direct address well)
		const raw = await chat(
			buildSystemPrompt(profile, ctx),
			conversation,
			config,
		);
		stages.push("s0-direct:monolithic");
		const decision = parseDecision(raw);
		return { ...decision, stages, classification: "social" };
	}

	// Context gate
	const gateResult = contextGate(profile, ctx);
	if (gateResult === "suppress") {
		stages.push("ctx-gate:suppress");
		return { ...SILENT, stages, classification: "social" };
	}

	// Stage 1: binary filter (fast path - numPredict=8)
	const filterRaw = await chatFast(FILTER_SYSTEM, conversation, config);
	const filter = parseFilter(filterRaw);
	stages.push(`s1:${filter}`);

	if (filter === "social")
		return { ...SILENT, stages, classification: "social" };

	// Stage 2: full monolithic prompt (proven 94.1% accuracy)
	// The monolithic gate already handles claims, questions, corrections, and responses.
	// We just use it as-is for the ~5% of messages that pass the social filter.
	const raw = await chat(buildSystemPrompt(profile, ctx), conversation, config);
	stages.push("s2:monolithic");
	const decision = parseDecision(raw);
	return {
		...decision,
		stages,
		classification: decision.action === GateAction.SPEAK ? "claim" : "social",
	};
}
