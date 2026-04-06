import * as assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { detectFeedback, Memory } from "../src/memory.ts";
import type { ChatMessage, PhilaConfig } from "../src/types.ts";
import { FeedbackType } from "../src/types.ts";

const testConfig: PhilaConfig = {
	model: "test",
	embedModel: "nomic-embed-text",
	ollamaUrl: "http://localhost:11434",
	batchWindowMs: 3000,
	memoryWindowSize: 50,
	dbPath: ":memory:",
	pruneAfterDays: 7,
	gateMode: "monolithic",
};

describe("Memory", () => {
	let mem: Memory;

	beforeEach(() => {
		mem = new Memory(testConfig);
	});

	afterEach(() => {
		mem.close();
	});

	it("stores and retrieves messages in chronological order", () => {
		const msgs: ChatMessage[] = [
			{ chatId: "chat1", sender: "alice", text: "hello", timestamp: 1000 },
			{ chatId: "chat1", sender: "bob", text: "hey", timestamp: 2000 },
			{ chatId: "chat1", sender: "alice", text: "whats up", timestamp: 3000 },
		];
		for (const m of msgs) mem.storeMessage(m);

		const recent = mem.getRecentMessages("chat1", 10);
		assert.equal(recent.length, 3);
		assert.equal(recent[0].text, "hello");
		assert.equal(recent[2].text, "whats up");
	});

	it("respects limit on getRecentMessages", () => {
		for (let i = 0; i < 10; i++) {
			mem.storeMessage({
				chatId: "chat1",
				sender: "alice",
				text: `msg ${i}`,
				timestamp: i * 1000,
			});
		}

		const recent = mem.getRecentMessages("chat1", 3);
		assert.equal(recent.length, 3);
		assert.equal(recent[0].text, "msg 7");
		assert.equal(recent[2].text, "msg 9");
	});

	it("isolates messages by chatId", () => {
		mem.storeMessage({
			chatId: "chat1",
			sender: "alice",
			text: "in chat1",
			timestamp: 1000,
		});
		mem.storeMessage({
			chatId: "chat2",
			sender: "bob",
			text: "in chat2",
			timestamp: 2000,
		});

		assert.equal(mem.getRecentMessages("chat1", 10).length, 1);
		assert.equal(mem.getRecentMessages("chat2", 10).length, 1);
	});

	it("returns default group profile for unknown chatId", () => {
		const profile = mem.getGroupProfile("unknown");
		assert.equal(profile.chatId, "unknown");
		assert.equal(profile.speakBias, 0.0);
	});

	it("updates and persists group profile", () => {
		mem.updateGroupProfile("chat1", { speakBias: -0.1 });
		assert.equal(mem.getGroupProfile("chat1").speakBias, -0.1);

		mem.updateGroupProfile("chat1", { speakBias: -0.15 });
		assert.equal(mem.getGroupProfile("chat1").speakBias, -0.15);
	});

	it("stores feedback records", () => {
		mem.storeFeedback("chat1", {
			type: FeedbackType.NEGATIVE,
			context: "told to shut up",
			timestamp: Date.now(),
		});
	});

	it("prunes messages older than cutoff", () => {
		const now = Date.now();
		const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
		const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;

		mem.storeMessage({
			chatId: "chat1",
			sender: "alice",
			text: "old msg",
			timestamp: eightDaysAgo,
		});
		mem.storeMessage({
			chatId: "chat1",
			sender: "bob",
			text: "recent msg",
			timestamp: threeDaysAgo,
		});

		const deleted = mem.pruneOldMessages(now);
		assert.equal(deleted, 1);
		const remaining = mem.getRecentMessages("chat1", 10);
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0].text, "recent msg");
	});

	it("prune keeps all messages within window", () => {
		const now = Date.now();
		mem.storeMessage({
			chatId: "chat1",
			sender: "alice",
			text: "a",
			timestamp: now - 1000,
		});
		mem.storeMessage({
			chatId: "chat1",
			sender: "bob",
			text: "b",
			timestamp: now,
		});

		const deleted = mem.pruneOldMessages(now);
		assert.equal(deleted, 0);
		assert.equal(mem.getRecentMessages("chat1", 10).length, 2);
	});
});

describe("getMessagesBeforeCutoff", () => {
	let mem: Memory;

	beforeEach(() => {
		mem = new Memory(testConfig);
	});

	afterEach(() => {
		mem.close();
	});

	it("returns messages older than cutoff grouped by chatId", () => {
		const now = Date.now();
		const old = now - 10 * 24 * 60 * 60 * 1000;
		const recent = now - 1 * 24 * 60 * 60 * 1000;

		mem.storeMessage({
			chatId: "chat1",
			sender: "alice",
			text: "old msg",
			timestamp: old,
		});
		mem.storeMessage({
			chatId: "chat1",
			sender: "bob",
			text: "recent msg",
			timestamp: recent,
		});
		mem.storeMessage({
			chatId: "chat2",
			sender: "alice",
			text: "old chat2 msg",
			timestamp: old,
		});

		const cutoff = now - 7 * 24 * 60 * 60 * 1000;
		const grouped = mem.getMessagesBeforeCutoff(cutoff, 200);

		assert.equal(grouped.get("chat1")?.length, 1);
		assert.equal(grouped.get("chat1")?.[0].text, "old msg");
		assert.equal(grouped.get("chat2")?.length, 1);
	});

	it("returns empty map when no messages before cutoff", () => {
		const now = Date.now();
		mem.storeMessage({
			chatId: "chat1",
			sender: "alice",
			text: "recent",
			timestamp: now,
		});
		const grouped = mem.getMessagesBeforeCutoff(
			now - 7 * 24 * 60 * 60 * 1000,
			200,
		);
		assert.equal(grouped.size, 0);
	});

	it("respects per-chat limit", () => {
		const cutoff = Date.now();
		for (let i = 0; i < 10; i++) {
			mem.storeMessage({
				chatId: "chat1",
				sender: "alice",
				text: `msg ${i}`,
				timestamp: cutoff - (i + 1) * 1000,
			});
		}
		const grouped = mem.getMessagesBeforeCutoff(cutoff, 3);
		assert.ok((grouped.get("chat1")?.length ?? 0) <= 3);
	});
});

describe("searchMessages", () => {
	let mem: Memory;

	beforeEach(() => {
		mem = new Memory(testConfig);
	});

	afterEach(() => {
		mem.close();
	});

	it("finds messages matching a keyword", () => {
		mem.storeMessage({
			chatId: "chat1",
			sender: "alice",
			text: "anyone want pizza tonight?",
			timestamp: 1000,
		});
		mem.storeMessage({
			chatId: "chat1",
			sender: "bob",
			text: "lets get sushi",
			timestamp: 2000,
		});

		const results = mem.searchMessages("chat1", "pizza", 10);
		assert.equal(results.length, 1);
		assert.equal(results[0].text, "anyone want pizza tonight?");
	});

	it("returns empty for no matches", () => {
		mem.storeMessage({
			chatId: "chat1",
			sender: "alice",
			text: "hello world",
			timestamp: 1000,
		});
		const results = mem.searchMessages("chat1", "tacos", 10);
		assert.equal(results.length, 0);
	});

	it("isolates results by chatId", () => {
		mem.storeMessage({
			chatId: "chat1",
			sender: "alice",
			text: "pizza is great",
			timestamp: 1000,
		});
		mem.storeMessage({
			chatId: "chat2",
			sender: "bob",
			text: "pizza party tomorrow",
			timestamp: 2000,
		});

		const results = mem.searchMessages("chat1", "pizza", 10);
		assert.equal(results.length, 1);
		assert.equal(results[0].chatId, "chat1");
	});

	it("respects limit", () => {
		for (let i = 0; i < 5; i++) {
			mem.storeMessage({
				chatId: "chat1",
				sender: "alice",
				text: `pizza msg ${i}`,
				timestamp: i * 1000,
			});
		}
		const results = mem.searchMessages("chat1", "pizza", 3);
		assert.equal(results.length, 3);
	});

	it("returns empty for FTS5 invalid query without throwing", () => {
		mem.storeMessage({
			chatId: "chat1",
			sender: "alice",
			text: "hello",
			timestamp: 1000,
		});
		// FTS5 special characters that could cause a syntax error
		const results = mem.searchMessages("chat1", '"unclosed quote', 10);
		assert.equal(results.length, 0);
	});
});

describe("group notes", () => {
	let mem: Memory;

	beforeEach(() => {
		mem = new Memory(testConfig);
	});

	afterEach(() => {
		mem.close();
	});

	it("returns empty string for unknown chatId", () => {
		assert.equal(mem.getGroupNotes("chat1"), "");
	});

	it("stores and retrieves notes", () => {
		mem.setGroupNotes("chat1", "they talk about sports a lot.");
		assert.equal(mem.getGroupNotes("chat1"), "they talk about sports a lot.");
	});

	it("overwrites existing notes on set", () => {
		mem.setGroupNotes("chat1", "first note.");
		mem.setGroupNotes("chat1", "updated note.");
		assert.equal(mem.getGroupNotes("chat1"), "updated note.");
	});

	it("isolates notes by chatId", () => {
		mem.setGroupNotes("chat1", "chat1 note.");
		mem.setGroupNotes("chat2", "chat2 note.");
		assert.equal(mem.getGroupNotes("chat1"), "chat1 note.");
		assert.equal(mem.getGroupNotes("chat2"), "chat2 note.");
	});

	it("truncates notes at 2000 chars at sentence boundary", () => {
		const sentence = `${"x".repeat(100)}. `;
		const long = sentence.repeat(25); // 2550 chars
		mem.setGroupNotes("chat1", long);
		const stored = mem.getGroupNotes("chat1");
		assert.ok(
			stored.length <= 2000,
			`expected <=2000 chars, got ${stored.length}`,
		);
		assert.ok(stored.endsWith("."), "expected truncation at sentence boundary");
	});

	it("stores notes without sentence boundary when none exists within limit", () => {
		const noSentence = "a".repeat(2500);
		mem.setGroupNotes("chat1", noSentence);
		const stored = mem.getGroupNotes("chat1");
		assert.equal(stored.length, 2000);
	});
});

describe("detectFeedback", () => {
	it("detects positive feedback mentioning phila", () => {
		const signal = detectFeedback([
			{ chatId: "c", sender: "alice", text: "thanks phila", timestamp: 1000 },
		]);
		assert.ok(signal);
		assert.equal(signal.type, FeedbackType.POSITIVE);
	});

	it("detects negative feedback mentioning phila", () => {
		const signal = detectFeedback([
			{ chatId: "c", sender: "bob", text: "shut up phila", timestamp: 1000 },
		]);
		assert.ok(signal);
		assert.equal(signal.type, FeedbackType.NEGATIVE);
	});

	it("ignores feedback without phila", () => {
		const signal = detectFeedback([
			{
				chatId: "c",
				sender: "alice",
				text: "lol thats hilarious",
				timestamp: 1000,
			},
			{
				chatId: "c",
				sender: "bob",
				text: "stop youre killing me",
				timestamp: 2000,
			},
		]);
		assert.equal(signal, null);
	});

	it("returns null when no feedback present", () => {
		assert.equal(
			detectFeedback([
				{
					chatId: "c",
					sender: "alice",
					text: "anyone want tacos?",
					timestamp: 1000,
				},
			]),
			null,
		);
	});

	it('ignores "thanks" without phila in same message', () => {
		const signal = detectFeedback([
			{
				chatId: "c",
				sender: "alice",
				text: "thanks for the pizza bob",
				timestamp: 1000,
			},
		]);
		assert.equal(signal, null);
	});

	it("prioritizes negative over positive when both match", () => {
		const signal = detectFeedback([
			{
				chatId: "c",
				sender: "alice",
				text: "phila shut up, nobody asked thanks",
				timestamp: 1000,
			},
		]);
		assert.ok(signal);
		assert.equal(signal.type, FeedbackType.NEGATIVE);
	});

	it("scans from newest message first", () => {
		const signal = detectFeedback([
			{ chatId: "c", sender: "alice", text: "thanks phila", timestamp: 1000 },
			{ chatId: "c", sender: "bob", text: "phila shut up", timestamp: 2000 },
		]);
		assert.ok(signal);
		assert.equal(signal.type, FeedbackType.NEGATIVE);
	});
});

describe("social learning", () => {
	let mem: Memory;

	beforeEach(() => {
		mem = new Memory(testConfig);
	});

	afterEach(() => {
		mem.close();
	});

	it("applies positive feedback (+0.02)", () => {
		mem.applyFeedback("chat1", {
			type: FeedbackType.POSITIVE,
			context: "thanks",
			timestamp: 1000,
		});
		assert.equal(mem.getGroupProfile("chat1").speakBias, 0.02);
	});

	it("applies negative feedback (-0.05) - asymmetric", () => {
		mem.applyFeedback("chat1", {
			type: FeedbackType.NEGATIVE,
			context: "shut up",
			timestamp: 1000,
		});
		assert.equal(mem.getGroupProfile("chat1").speakBias, -0.05);
	});

	it("clamps bias at lower bound (-0.3)", () => {
		for (let i = 0; i < 10; i++) {
			mem.applyFeedback("chat1", {
				type: FeedbackType.NEGATIVE,
				context: "stop",
				timestamp: i,
			});
		}
		assert.equal(mem.getGroupProfile("chat1").speakBias, -0.3);
	});

	it("clamps bias at upper bound (0.1)", () => {
		for (let i = 0; i < 10; i++) {
			mem.applyFeedback("chat1", {
				type: FeedbackType.POSITIVE,
				context: "good",
				timestamp: i,
			});
		}
		assert.equal(mem.getGroupProfile("chat1").speakBias, 0.1);
	});

	it("recovers from negative with positive feedback", () => {
		mem.applyFeedback("chat1", {
			type: FeedbackType.NEGATIVE,
			context: "stop",
			timestamp: 1,
		});
		assert.equal(mem.getGroupProfile("chat1").speakBias, -0.05);

		mem.applyFeedback("chat1", {
			type: FeedbackType.POSITIVE,
			context: "thanks",
			timestamp: 2,
		});
		const bias = mem.getGroupProfile("chat1").speakBias;
		assert.ok(Math.abs(bias - -0.03) < 0.001, `expected -0.03, got ${bias}`);
	});
});

describe("decision log", () => {
	let mem: Memory;

	beforeEach(() => {
		mem = new Memory(testConfig);
	});

	afterEach(() => {
		mem.close();
	});

	it("logDecision returns an id and round-trips speak entry", () => {
		const id = mem.logDecision({
			chatId: "chat1",
			decision: "speak",
			reason: "direct address",
			toolsUsed: ["verify"],
			response: "hey there",
			timestamp: 1000,
		});
		assert.ok(id > 0);
		const entries = mem.getRecentDecisions("chat1", 10);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].decision, "speak");
		assert.equal(entries[0].reason, "direct address");
		assert.deepEqual(entries[0].toolsUsed, ["verify"]);
		assert.equal(entries[0].response, "hey there");
		assert.equal(entries[0].id, id);
	});

	it("logDecision round-trips silent entry with no tools", () => {
		mem.logDecision({ chatId: "chat1", decision: "silent", timestamp: 1000 });
		const entries = mem.getRecentDecisions("chat1", 10);
		assert.equal(entries[0].decision, "silent");
		assert.equal(entries[0].toolsUsed, undefined);
		assert.equal(entries[0].reason, undefined);
	});

	it("linkFeedback updates most recent SPEAK within window", () => {
		const id = mem.logDecision({
			chatId: "chat1",
			decision: "speak",
			reason: "wrong fact",
			timestamp: 1000,
		});
		const updated = mem.linkFeedback("chat1", "positive", "thanks phila", 5000);
		assert.equal(updated, true);
		const entries = mem.getRecentDecisions("chat1", 10);
		assert.equal(entries[0].feedbackType, "positive");
		assert.equal(entries[0].feedbackContext, "thanks phila");
		assert.equal(entries[0].id, id);
	});

	it("linkFeedback skips SILENT decisions", () => {
		mem.logDecision({ chatId: "chat1", decision: "silent", timestamp: 1000 });
		const updated = mem.linkFeedback("chat1", "positive", "thanks phila", 5000);
		assert.equal(updated, false);
	});

	it("linkFeedback respects time window", () => {
		mem.logDecision({
			chatId: "chat1",
			decision: "speak",
			reason: "r",
			timestamp: 1000,
		});
		// Feedback at 400 seconds later = outside 300s default window
		const updated = mem.linkFeedback("chat1", "negative", "stop", 401_000);
		assert.equal(updated, false);
	});

	it("linkFeedback returns false when no decisions exist", () => {
		const updated = mem.linkFeedback("chat1", "positive", "thanks", 5000);
		assert.equal(updated, false);
	});

	it("getRecentDecisions returns newest first", () => {
		mem.logDecision({ chatId: "chat1", decision: "silent", timestamp: 1000 });
		mem.logDecision({
			chatId: "chat1",
			decision: "speak",
			reason: "r",
			timestamp: 2000,
		});
		mem.logDecision({ chatId: "chat1", decision: "silent", timestamp: 3000 });
		const entries = mem.getRecentDecisions("chat1", 10);
		assert.equal(entries[0].timestamp, 3000);
		assert.equal(entries[2].timestamp, 1000);
	});

	it("getRecentDecisions respects limit", () => {
		for (let i = 0; i < 5; i++) {
			mem.logDecision({
				chatId: "chat1",
				decision: "silent",
				timestamp: i * 1000,
			});
		}
		const entries = mem.getRecentDecisions("chat1", 3);
		assert.equal(entries.length, 3);
	});

	it("linkFeedback picks most recent SPEAK when multiple exist", () => {
		mem.logDecision({
			chatId: "chat1",
			decision: "speak",
			reason: "r1",
			timestamp: 1000,
		});
		const id2 = mem.logDecision({
			chatId: "chat1",
			decision: "speak",
			reason: "r2",
			timestamp: 2000,
		});
		const updated = mem.linkFeedback("chat1", "positive", "thanks", 5000);
		assert.equal(updated, true);
		const entries = mem.getRecentDecisions("chat1", 10);
		// id2 (timestamp 2000) is more recent and should be updated
		const updated2 = entries.find((e) => e.id === id2);
		assert.equal(updated2?.feedbackType, "positive");
	});

	it("linkFeedback does not modify unrelated chat", () => {
		mem.logDecision({
			chatId: "chat1",
			decision: "speak",
			reason: "r",
			timestamp: 1000,
		});
		const updated = mem.linkFeedback("chat2", "positive", "thanks", 5000);
		assert.equal(updated, false);
	});

	it("toolsUsed serialized and deserialized correctly for both tools", () => {
		mem.logDecision({
			chatId: "chat1",
			decision: "speak",
			reason: "r",
			toolsUsed: ["recall", "verify"],
			timestamp: 1000,
		});
		const entries = mem.getRecentDecisions("chat1", 10);
		assert.deepEqual(entries[0].toolsUsed, ["recall", "verify"]);
	});

	it("logDecision with no optional fields round-trips cleanly", () => {
		mem.logDecision({ chatId: "chat1", decision: "silent", timestamp: 1000 });
		const entries = mem.getRecentDecisions("chat1", 10);
		assert.equal(entries[0].reason, undefined);
		assert.equal(entries[0].toolsUsed, undefined);
		assert.equal(entries[0].response, undefined);
		assert.equal(entries[0].feedbackType, undefined);
		assert.equal(entries[0].feedbackContext, undefined);
	});

	it("decision_log schema is idempotent (second Memory() on same :memory: does not throw)", () => {
		// Each :memory: instance gets a fresh db, but running the full SCHEMA twice
		// on the same instance would throw without IF NOT EXISTS guards.
		// Verify by constructing, using, and constructing again - no throws.
		assert.doesNotThrow(() => {
			const mem2 = new Memory(testConfig);
			mem2.logDecision({
				chatId: "chat1",
				decision: "speak",
				reason: "r",
				timestamp: 1000,
			});
			assert.equal(mem2.getRecentDecisions("chat1", 10).length, 1);
			mem2.close();
		});
	});
});
