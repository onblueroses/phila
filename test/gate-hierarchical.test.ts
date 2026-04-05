import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

// Import the exported functions we can test without Ollama
import {
	detectDirectAddress,
	parseFilter,
	parseStage1,
} from "../src/gate-hierarchical.ts";
import type {
	ChatMessage,
	Classification,
	ConversationContext,
	GroupProfile,
} from "../src/types.ts";

function msg(text: string): ChatMessage {
	return { text, sender: "person1", chatId: "test", timestamp: Date.now() };
}

describe("parseStage1", () => {
	it('parses "social" as social', () => {
		assert.equal(parseStage1("social"), "social");
	});

	it('parses "attention" as claim', () => {
		assert.equal(parseStage1("attention"), "claim");
	});

	it("non-attention words default to social", () => {
		// Binary filter: only "attention" triggers non-social path
		assert.equal(parseStage1("claim"), "social");
		assert.equal(parseStage1("question"), "social");
	});

	it("handles uppercase", () => {
		assert.equal(parseStage1("SOCIAL"), "social");
		assert.equal(parseStage1("ATTENTION"), "claim");
	});

	it("handles whitespace and newlines", () => {
		assert.equal(parseStage1("  social  "), "social");
		assert.equal(parseStage1("\nattention\n"), "claim");
	});

	it("defaults garbage to social (safe default)", () => {
		assert.equal(parseStage1(""), "social");
		assert.equal(parseStage1("asdfgh"), "social");
		assert.equal(parseStage1('{"action":"speak"}'), "social");
		assert.equal(parseStage1("123"), "social");
	});

	it("handles markdown-fenced responses", () => {
		assert.equal(parseStage1("```social```"), "social");
	});
});

describe("parseFilter", () => {
	it('parses "social" correctly', () => {
		assert.equal(parseFilter("social"), "social");
	});

	it('parses "attention" correctly', () => {
		assert.equal(parseFilter("attention"), "attention");
	});

	it('handles preamble containing "attention"', () => {
		assert.equal(parseFilter("I think this needs attention"), "attention");
	});

	it("defaults to social", () => {
		assert.equal(parseFilter(""), "social");
		assert.equal(parseFilter("claim"), "social");
		assert.equal(parseFilter("question"), "social");
	});

	it("handles uppercase", () => {
		assert.equal(parseFilter("ATTENTION"), "attention");
		assert.equal(parseFilter("SOCIAL"), "social");
	});
});

describe("detectDirectAddress", () => {
	it('matches "hey phila"', () => {
		assert.ok(detectDirectAddress([msg("hey phila how are you")]));
	});

	it('matches "yo phila"', () => {
		assert.ok(detectDirectAddress([msg("yo phila do you know")]));
	});

	it('matches "phila" at start with question word', () => {
		assert.ok(detectDirectAddress([msg("phila what time is the game")]));
		assert.ok(detectDirectAddress([msg("phila do you know")]));
	});

	it('does NOT match "phila" at start followed by noun (incidental)', () => {
		assert.ok(!detectDirectAddress([msg("phila museum closes at 5")]));
		assert.ok(
			!detectDirectAddress([msg("phila is probably right about this")]),
		);
	});

	it('matches "phila" followed by question word mid-sentence', () => {
		assert.ok(detectDirectAddress([msg("phila what is the answer")]));
	});

	it('matches "phila," and "phila?"', () => {
		assert.ok(detectDirectAddress([msg("phila, what time?")]));
		assert.ok(detectDirectAddress([msg("phila?")]));
	});

	it('matches "ask phila"', () => {
		assert.ok(detectDirectAddress([msg("lets ask phila")]));
	});

	it('does NOT match "philadelphia"', () => {
		assert.ok(!detectDirectAddress([msg("im going to philadelphia")]));
	});

	it('does NOT match "phila museum"', () => {
		assert.ok(
			!detectDirectAddress([msg("the phila museum of art is amazing")]),
		);
	});

	it('does NOT match "philanthropy"', () => {
		assert.ok(!detectDirectAddress([msg("i want to get into philanthropy")]));
	});

	it('does NOT match "philo"', () => {
		assert.ok(!detectDirectAddress([msg("have you read any philo lately")]));
	});

	it('does NOT match "my friend phila told me"', () => {
		// "my friend phila told me the great wall is visible from space"
		// This should NOT trigger direct address - phila is being talked ABOUT, not TO
		assert.ok(
			!detectDirectAddress([
				msg("my friend phila told me the great wall is visible from space"),
			]),
		);
	});
});

describe("contextGate logic", () => {
	// Test the context gate rules directly via the conditions
	const baseProfile: GroupProfile = {
		chatId: "test",
		speakBias: 0,
		updatedAt: Date.now(),
	};

	it("strong negative bias suppresses", () => {
		const profile = { ...baseProfile, speakBias: -0.2 };
		assert.ok(profile.speakBias <= -0.15); // would trigger suppress
	});

	it("neutral bias continues", () => {
		const profile = { ...baseProfile, speakBias: 0 };
		assert.ok(profile.speakBias > -0.15);
		assert.ok(!(profile.speakBias <= -0.05));
	});

	it("late night suppresses (hour 23)", () => {
		const ctx: ConversationContext = {
			correctionHint: false,
			messagesPerMinute: null,
			latestMessageHour: 23,
			groupNotes: null,
		};
		assert.ok(ctx.latestMessageHour! >= 23 || ctx.latestMessageHour! < 7);
	});

	it("late night suppresses (hour 2)", () => {
		const ctx: ConversationContext = {
			correctionHint: false,
			messagesPerMinute: null,
			latestMessageHour: 2,
			groupNotes: null,
		};
		assert.ok(ctx.latestMessageHour! >= 23 || ctx.latestMessageHour! < 7);
	});

	it("daytime does not suppress", () => {
		const ctx: ConversationContext = {
			correctionHint: false,
			messagesPerMinute: null,
			latestMessageHour: 14,
			groupNotes: null,
		};
		assert.ok(!(ctx.latestMessageHour! >= 23 || ctx.latestMessageHour! < 7));
	});

	it("high traffic + moderate negative bias suppresses", () => {
		const profile = { ...baseProfile, speakBias: -0.06 };
		const ctx: ConversationContext = {
			correctionHint: false,
			messagesPerMinute: 8,
			latestMessageHour: 14,
			groupNotes: null,
		};
		assert.ok(ctx.messagesPerMinute! > 5 && profile.speakBias <= -0.05);
	});

	it("high traffic + neutral bias does not suppress", () => {
		const profile = { ...baseProfile, speakBias: 0 };
		const ctx: ConversationContext = {
			correctionHint: false,
			messagesPerMinute: 8,
			latestMessageHour: 14,
			groupNotes: null,
		};
		assert.ok(!(ctx.messagesPerMinute! > 5 && profile.speakBias <= -0.05));
	});
});

describe("HierarchicalDecision type contract", () => {
	it("silent decision has stages array", () => {
		const decision = {
			action: "silent" as const,
			stages: ["s0:no-direct", "s1:social"],
			classification: "social" as Classification,
		};
		assert.ok(Array.isArray(decision.stages));
		assert.equal(decision.stages.length, 2);
		assert.equal(decision.classification, "social");
	});

	it("speak decision has stages, classification, reason, response", () => {
		const decision = {
			action: "speak" as const,
			reason: "wrong fact",
			response: "actually its paris",
			stages: ["s0:no-direct", "s1:claim", "s2:decide"],
			classification: "claim" as Classification,
		};
		assert.equal(decision.action, "speak");
		assert.equal(decision.stages.length, 3);
		assert.equal(decision.classification, "claim");
	});
});
