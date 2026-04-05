import { chat } from "./ollama.ts";
import type {
	ChatMessage,
	ConversationContext,
	GateDecision,
	GroupProfile,
	PhilaConfig,
} from "./types.ts";
import { GateAction } from "./types.ts";

const SILENT: GateDecision = { action: GateAction.SILENT };

export function buildSystemPrompt(
	profile: GroupProfile,
	ctx?: ConversationContext,
): string {
	let biasLine = "";
	const b = profile.speakBias;
	if (b <= -0.15) {
		biasLine =
			"\nthis group strongly prefers you stay silent. only speak when directly addressed.\n";
	} else if (b <= -0.05) {
		biasLine =
			"\nthis group prefers you stay quiet. only speak for rules 1 and 2.\n";
	} else if (b > 0.07) {
		biasLine =
			"\nthis group appreciates your contributions. feel comfortable sharing when relevant.\n";
	} else if (b > 0.03) {
		biasLine =
			"\nthis group is open to your input. speak up when you can help.\n";
	}

	let contextLines = "";
	if (ctx) {
		if (ctx.correctionHint) {
			contextLines +=
				"\nnote: someone may have already corrected an error in this conversation. check before correcting.\n";
		}
		if (ctx.messagesPerMinute != null && ctx.messagesPerMinute > 5) {
			contextLines +=
				"\nconversation is very active right now. be extra cautious about speaking.\n";
		}
		if (
			ctx.latestMessageHour != null &&
			(ctx.latestMessageHour >= 23 || ctx.latestMessageHour < 7)
		) {
			contextLines +=
				"\nit's late at night. only speak if directly addressed (rule 1).\n";
		}
	}

	const notesBlock = ctx?.groupNotes
		? `\ngroup context (things you know about this chat):\n${ctx.groupNotes}\n`
		: "";

	return `you are phila, a member of a group chat. your name is phila.
your default is silence - you only speak when it matters.
${biasLine}${contextLines}${notesBlock}
ALWAYS SPEAK (these override silence):
1. someone says "phila" anywhere in a message (greeting, question, request) -> respond. even if combined with emoji or punctuation.
2. someone states a wrong fact (wrong date, wrong name, wrong number) and nobody corrects them -> correct it
   BUT if someone already corrected it (said "actually", "no its", "thats not right", etc.) -> STAY SILENT
3. a factual question goes unanswered by others -> answer it

EXAMPLE of rule 1:
person1: hey phila how are you
correct response: {"action":"speak","reason":"direct address","response":"doing good, whats up"}

EXAMPLE of rule 2:
person1: the great wall of china is in japan
person2: yeah i think so
correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

EXAMPLE of rule 3:
person1: whats the tallest mountain in the world?
person2: idk
correct response: {"action":"speak","reason":"unanswered question","response":"mount everest, 8849 meters"}

STAY SILENT for everything else. examples:
- small talk between others
- emotions, venting, celebrating
- jokes, banter, memes, sarcasm (even if they contain wrong facts)
- opinions, preferences, debates
- gossip, drama, personal stories
- someone already corrected the error (look for "actually", "no", "thats not right")
- rhetorical questions

style: lowercase, 1-2 sentences, casual like a friend. no "great question" or "happy to help".

respond with ONLY json, no other text:
{"action":"silent"}
or
{"action":"speak","reason":"why","response":"your message"}`;
}

export function parseDecision(raw: string): GateDecision {
	// Strip markdown fences, then extract first JSON object if surrounded by prose
	let cleaned = raw.replace(/```(?:json)?\s*|```\s*/g, "").trim();
	if (!cleaned.startsWith("{")) {
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
	}

	try {
		const parsed = JSON.parse(cleaned) as {
			action?: string;
			reason?: string;
			response?: string;
		};
		if (
			parsed.action === GateAction.SPEAK &&
			parsed.reason &&
			parsed.response
		) {
			return {
				action: GateAction.SPEAK,
				reason: parsed.reason,
				response: parsed.response,
			};
		}
		return SILENT;
	} catch {
		return SILENT;
	}
}

const CORRECTION_PATTERN =
	/\b(actually|nope|that'?s wrong|that'?s not right|no it'?s|it'?s actually|correction)\b/i;

export function detectCorrection(messages: ChatMessage[]): boolean {
	for (let i = 1; i < messages.length; i++) {
		if (!CORRECTION_PATTERN.test(messages[i].text)) continue;
		// Look back up to 3 messages for the claim being corrected
		const lookback = Math.max(0, i - 3);
		for (let j = i - 1; j >= lookback; j--) {
			if (messages[j].sender !== messages[i].sender) return true;
		}
	}
	return false;
}

export function computeMomentum(messages: ChatMessage[]): number | null {
	if (messages.length < 2) return null;
	const spanMs =
		messages[messages.length - 1].timestamp - messages[0].timestamp;
	if (spanMs <= 0) return null;
	return (messages.length / spanMs) * 60_000;
}

export function extractHour(timestamp: number): number {
	return new Date(timestamp).getHours();
}

export function buildConversation(messages: ChatMessage[]): string {
	const labels = new Map<string, string>();
	const label = (name: string) => {
		if (name === "phila") return "you";
		if (!labels.has(name)) labels.set(name, `person${labels.size + 1}`);
		return labels.get(name)!;
	};
	return messages.map((m) => `${label(m.sender)}: ${m.text}`).join("\n");
}

export async function evaluate(
	messages: ChatMessage[],
	profile: GroupProfile,
	config: PhilaConfig,
	ctx?: ConversationContext,
): Promise<GateDecision> {
	const conversation = buildConversation(messages);
	const raw = await chat(buildSystemPrompt(profile, ctx), conversation, config);
	return parseDecision(raw);
}
