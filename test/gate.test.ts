import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildConversation,
	buildSystemPrompt,
	computeMomentum,
	detectCorrection,
	extractHour,
	parseDecision,
} from "../src/gate.ts";
import type {
	ChatMessage,
	ConversationContext,
	ExtractedFact,
	GroupProfile,
} from "../src/types.ts";
import { GateAction } from "../src/types.ts";

const baseProfile: GroupProfile = {
	chatId: "test-chat",
	speakBias: 0.0,
	updatedAt: Date.now(),
};

describe("gate", () => {
	describe("parseDecision", () => {
		it("parses SILENT response", () => {
			const result = parseDecision('{"action":"silent"}');
			assert.equal(result.action, GateAction.SILENT);
		});

		it("parses SPEAK response with reason and response", () => {
			const json =
				'{"action":"speak","reason":"factual error","response":"actually that was in 1969"}';
			const result = parseDecision(json);
			assert.equal(result.action, GateAction.SPEAK);
			if (result.action === GateAction.SPEAK) {
				assert.equal(result.reason, "factual error");
				assert.equal(result.response, "actually that was in 1969");
			}
		});

		it("strips markdown code fences", () => {
			const wrapped = '```json\n{"action":"silent"}\n```';
			const result = parseDecision(wrapped);
			assert.equal(result.action, GateAction.SILENT);
		});

		it("defaults to SILENT on malformed JSON", () => {
			const result = parseDecision("this is not json at all");
			assert.equal(result.action, GateAction.SILENT);
		});

		it("defaults to SILENT on empty string", () => {
			const result = parseDecision("");
			assert.equal(result.action, GateAction.SILENT);
		});

		it("defaults to SILENT when SPEAK is missing required fields", () => {
			const result = parseDecision('{"action":"speak"}');
			assert.equal(result.action, GateAction.SILENT);
		});

		it("extracts JSON from surrounding prose", () => {
			const raw = 'Here is my response:\n{"action":"silent"}\nI chose silence.';
			const result = parseDecision(raw);
			assert.equal(result.action, GateAction.SILENT);
		});

		it("extracts SPEAK JSON from prose wrapper", () => {
			const raw =
				'Based on the conversation: {"action":"speak","reason":"wrong fact","response":"paris is in france"}';
			const result = parseDecision(raw);
			assert.equal(result.action, GateAction.SPEAK);
			if (result.action === GateAction.SPEAK) {
				assert.equal(result.response, "paris is in france");
			}
		});

		it("handles response containing special characters", () => {
			const raw =
				'{"action":"speak","reason":"correction","response":"it\'s actually 100°C :)"}';
			const result = parseDecision(raw);
			assert.equal(result.action, GateAction.SPEAK);
			if (result.action === GateAction.SPEAK) {
				assert.equal(result.response, "it's actually 100°C :)");
			}
		});

		it("parses tools on SPEAK decision", () => {
			const raw =
				'{"action":"speak","reason":"wrong fact","response":"actually no","tools":["verify"]}';
			const result = parseDecision(raw);
			assert.equal(result.action, GateAction.SPEAK);
			if (result.action === GateAction.SPEAK) {
				assert.deepEqual(result.tools, ["verify"]);
			}
		});

		it("parses tools on SILENT decision", () => {
			const raw = '{"action":"silent","tools":["recall"]}';
			const result = parseDecision(raw);
			assert.equal(result.action, GateAction.SILENT);
			assert.deepEqual(result.tools, ["recall"]);
		});

		it("drops unknown tools", () => {
			const raw =
				'{"action":"speak","reason":"r","response":"x","tools":["verify","inject_evil","recall"]}';
			const result = parseDecision(raw);
			if (result.action === GateAction.SPEAK) {
				assert.deepEqual(result.tools, ["verify", "recall"]);
			}
		});

		it("missing tools field -> no tools property", () => {
			const raw =
				'{"action":"speak","reason":"direct address","response":"hey"}';
			const result = parseDecision(raw);
			assert.equal(result.action, GateAction.SPEAK);
			if (result.action === GateAction.SPEAK) {
				assert.equal(result.tools, undefined);
			}
		});

		it("empty tools array -> no tools property", () => {
			const raw = '{"action":"speak","reason":"r","response":"x","tools":[]}';
			const result = parseDecision(raw);
			if (result.action === GateAction.SPEAK) {
				assert.equal(result.tools, undefined);
			}
		});

		it("all-unknown tools -> no tools property", () => {
			const raw = '{"action":"silent","tools":["exec","eval"]}';
			const result = parseDecision(raw);
			assert.equal(result.action, GateAction.SILENT);
			assert.equal(result.tools, undefined);
		});

		it("malformed JSON with tools -> SILENT with no tools", () => {
			const raw = '{"action":"speak","tools":["verify"';
			const result = parseDecision(raw);
			assert.equal(result.action, GateAction.SILENT);
			assert.equal(result.tools, undefined);
		});

		it("non-array tools field -> no tools property", () => {
			const raw =
				'{"action":"speak","reason":"r","response":"x","tools":"verify"}';
			const result = parseDecision(raw);
			if (result.action === GateAction.SPEAK) {
				assert.equal(result.tools, undefined);
			}
		});

		// Adversarial inputs
		it("duplicate tools deduplicated", () => {
			const raw =
				'{"action":"speak","reason":"r","response":"x","tools":["verify","verify","verify"]}';
			const result = parseDecision(raw);
			if (result.action === GateAction.SPEAK) {
				assert.deepEqual(result.tools, ["verify"]);
			}
		});

		it("prototype pollution attempt filtered", () => {
			const raw =
				'{"action":"speak","reason":"r","response":"x","tools":["__proto__","constructor","verify"]}';
			const result = parseDecision(raw);
			if (result.action === GateAction.SPEAK) {
				assert.deepEqual(result.tools, ["verify"]);
			}
		});

		it("mixed types in tools array -> only valid strings kept", () => {
			const raw =
				'{"action":"speak","reason":"r","response":"x","tools":[null,1,true,"verify",{}]}';
			const result = parseDecision(raw);
			if (result.action === GateAction.SPEAK) {
				assert.deepEqual(result.tools, ["verify"]);
			}
		});

		it("both recall and verify in tools array preserved", () => {
			const raw =
				'{"action":"speak","reason":"r","response":"x","tools":["recall","verify"]}';
			const result = parseDecision(raw);
			if (result.action === GateAction.SPEAK) {
				assert.deepEqual(result.tools, ["recall", "verify"]);
			}
		});

		it("very long tools array with one valid entry", () => {
			const manyBad = Array.from({ length: 100 }, (_, i) => `tool${i}`);
			const raw = JSON.stringify({
				action: "speak",
				reason: "r",
				response: "x",
				tools: [...manyBad, "recall"],
			});
			const result = parseDecision(raw);
			if (result.action === GateAction.SPEAK) {
				assert.deepEqual(result.tools, ["recall"]);
			}
		});

		it("tools field as object -> no tools property", () => {
			const raw = '{"action":"silent","tools":{"verify":true}}';
			const result = parseDecision(raw);
			assert.equal(result.action, GateAction.SILENT);
			assert.equal(result.tools, undefined);
		});

		it("tools field as number -> no tools property", () => {
			const raw = '{"action":"silent","tools":42}';
			const result = parseDecision(raw);
			assert.equal(result.tools, undefined);
		});
	});

	describe("buildSystemPrompt", () => {
		it("neutral bias has no modifier", () => {
			const prompt = buildSystemPrompt(baseProfile);
			assert.ok(!prompt.includes("strongly prefers"));
			assert.ok(!prompt.includes("prefers you stay quiet"));
			assert.ok(!prompt.includes("open to your input"));
			assert.ok(!prompt.includes("appreciates your contributions"));
		});

		it("strongly negative bias (-0.2) restricts to direct address", () => {
			const prompt = buildSystemPrompt({ ...baseProfile, speakBias: -0.2 });
			assert.ok(prompt.includes("strongly prefers you stay silent"));
		});

		it("moderately negative bias (-0.08) restricts to rules 1 and 2", () => {
			const prompt = buildSystemPrompt({ ...baseProfile, speakBias: -0.08 });
			assert.ok(prompt.includes("prefers you stay quiet"));
		});

		it("moderately positive bias (0.05) encourages input", () => {
			const prompt = buildSystemPrompt({ ...baseProfile, speakBias: 0.05 });
			assert.ok(prompt.includes("open to your input"));
		});

		it("strongly positive bias (0.09) appreciates contributions", () => {
			const prompt = buildSystemPrompt({ ...baseProfile, speakBias: 0.09 });
			assert.ok(prompt.includes("appreciates your contributions"));
		});

		it("correction hint adds warning", () => {
			const ctx: ConversationContext = {
				correctionHint: true,
				messagesPerMinute: null,
				latestMessageHour: null,
				groupNotes: null,
			};
			const prompt = buildSystemPrompt(baseProfile, ctx);
			assert.ok(prompt.includes("already corrected an error"));
		});

		it("high momentum adds caution", () => {
			const ctx: ConversationContext = {
				correctionHint: false,
				messagesPerMinute: 8,
				latestMessageHour: null,
				groupNotes: null,
			};
			const prompt = buildSystemPrompt(baseProfile, ctx);
			assert.ok(prompt.includes("very active right now"));
		});

		it("normal momentum adds nothing", () => {
			const ctx: ConversationContext = {
				correctionHint: false,
				messagesPerMinute: 3,
				latestMessageHour: null,
				groupNotes: null,
			};
			const prompt = buildSystemPrompt(baseProfile, ctx);
			assert.ok(!prompt.includes("very active"));
		});

		it("late night restricts to direct address", () => {
			const ctx: ConversationContext = {
				correctionHint: false,
				messagesPerMinute: null,
				latestMessageHour: 2,
				groupNotes: null,
			};
			const prompt = buildSystemPrompt(baseProfile, ctx);
			assert.ok(prompt.includes("it's late at night"));
		});

		it("daytime adds nothing", () => {
			const ctx: ConversationContext = {
				correctionHint: false,
				messagesPerMinute: null,
				latestMessageHour: 14,
				groupNotes: null,
			};
			const prompt = buildSystemPrompt(baseProfile, ctx);
			assert.ok(!prompt.includes("late at night"));
		});

		it("no context produces same prompt as profile-only", () => {
			const withCtx = buildSystemPrompt(baseProfile, undefined);
			const without = buildSystemPrompt(baseProfile);
			assert.equal(withCtx, without);
		});

		it("null groupNotes produces byte-identical prompt to no-ctx", () => {
			const withNullNotes = buildSystemPrompt(baseProfile, {
				correctionHint: false,
				messagesPerMinute: null,
				latestMessageHour: null,
				groupNotes: null,
			});
			const withoutCtx = buildSystemPrompt(baseProfile);
			assert.equal(withNullNotes, withoutCtx);
		});

		it("empty groupNotes produces byte-identical prompt to no-ctx", () => {
			const withEmptyNotes = buildSystemPrompt(baseProfile, {
				correctionHint: false,
				messagesPerMinute: null,
				latestMessageHour: null,
				groupNotes: "",
			});
			const withoutCtx = buildSystemPrompt(baseProfile);
			assert.equal(withEmptyNotes, withoutCtx);
		});

		it("non-empty groupNotes injects context block", () => {
			const ctx: ConversationContext = {
				correctionHint: false,
				messagesPerMinute: null,
				latestMessageHour: null,
				groupNotes: "they often discuss hiking.",
			};
			const prompt = buildSystemPrompt(baseProfile, ctx);
			assert.ok(
				prompt.includes("group context (things you know about this chat):"),
			);
			assert.ok(prompt.includes("they often discuss hiking."));
		});

		it("groupNotes appears before ALWAYS SPEAK rules", () => {
			const ctx: ConversationContext = {
				correctionHint: false,
				messagesPerMinute: null,
				latestMessageHour: null,
				groupNotes: "frequent sports talk.",
			};
			const prompt = buildSystemPrompt(baseProfile, ctx);
			const notesPos = prompt.indexOf("group context");
			const rulesPos = prompt.indexOf("ALWAYS SPEAK");
			assert.ok(
				notesPos < rulesPos,
				"notes block should appear before ALWAYS SPEAK rules",
			);
		});

		it("groupNotes combined with bias and correction hint all coexist", () => {
			const ctx: ConversationContext = {
				correctionHint: true,
				messagesPerMinute: null,
				latestMessageHour: null,
				groupNotes: "tech-savvy group.",
			};
			const prompt = buildSystemPrompt(
				{ ...baseProfile, speakBias: -0.1 },
				ctx,
			);
			assert.ok(prompt.includes("prefers you stay quiet"));
			assert.ok(prompt.includes("already corrected an error"));
			assert.ok(prompt.includes("tech-savvy group."));
		});

		it("includes core instructions", () => {
			const prompt = buildSystemPrompt(baseProfile);
			assert.ok(prompt.includes("ALWAYS SPEAK"));
			assert.ok(prompt.includes("STAY SILENT"));
			assert.ok(prompt.includes("json"));
		});

		it("includes tools vocabulary with recall and verify examples", () => {
			const prompt = buildSystemPrompt(baseProfile);
			assert.ok(prompt.includes('"tools":["recall"]'));
			assert.ok(prompt.includes('"tools":["verify"]'));
		});

		it("no facts param -> identical output to profile-only call", () => {
			const withUndefined = buildSystemPrompt(
				baseProfile,
				undefined,
				undefined,
			);
			const without = buildSystemPrompt(baseProfile);
			assert.equal(withUndefined, without);
		});

		it("empty facts array -> identical output to no-facts call", () => {
			const withEmpty = buildSystemPrompt(baseProfile, undefined, []);
			const without = buildSystemPrompt(baseProfile);
			assert.equal(withEmpty, without);
		});

		it("single fact appears in prompt", () => {
			const facts: ExtractedFact[] = [
				{
					chatId: "c1",
					type: "logistics",
					key: "meeting_time",
					value: "7pm friday",
					messageId: 1,
					timestamp: 1000,
				},
			];
			const prompt = buildSystemPrompt(baseProfile, undefined, facts);
			assert.ok(prompt.includes("you remember from this chat:"));
			assert.ok(prompt.includes("- meeting_time: 7pm friday"));
		});

		it("multiple facts all appear in prompt", () => {
			const facts: ExtractedFact[] = [
				{
					chatId: "c1",
					type: "logistics",
					key: "location",
					value: "the thai place",
					messageId: 1,
					timestamp: 1000,
				},
				{
					chatId: "c1",
					type: "commitment",
					key: "driver",
					value: "person1",
					messageId: 2,
					timestamp: 2000,
				},
			];
			const prompt = buildSystemPrompt(baseProfile, undefined, facts);
			assert.ok(prompt.includes("- location: the thai place"));
			assert.ok(prompt.includes("- driver: person1"));
			assert.ok(
				prompt.includes(
					"if you remember relevant facts from this chat, use them in your response.",
				),
			);
		});

		it("facts block appears before ALWAYS SPEAK", () => {
			const facts: ExtractedFact[] = [
				{
					chatId: "c1",
					type: "preference",
					key: "diet",
					value: "vegetarian",
					messageId: 1,
					timestamp: 1000,
				},
			];
			const prompt = buildSystemPrompt(baseProfile, undefined, facts);
			const factsPos = prompt.indexOf("you remember from this chat:");
			const rulesPos = prompt.indexOf("ALWAYS SPEAK");
			assert.ok(
				factsPos < rulesPos,
				"facts block should appear before ALWAYS SPEAK",
			);
		});

		it("facts combined with groupNotes both appear", () => {
			const ctx: ConversationContext = {
				correctionHint: false,
				messagesPerMinute: null,
				latestMessageHour: null,
				groupNotes: "they often discuss sports.",
			};
			const facts: ExtractedFact[] = [
				{
					chatId: "c1",
					type: "logistics",
					key: "venue",
					value: "the stadium",
					messageId: 1,
					timestamp: 1000,
				},
			];
			const prompt = buildSystemPrompt(baseProfile, ctx, facts);
			assert.ok(prompt.includes("they often discuss sports."));
			assert.ok(prompt.includes("- venue: the stadium"));
		});
	});

	describe("detectCorrection", () => {
		const msg = (sender: string, text: string, ts: number): ChatMessage => ({
			chatId: "c1",
			sender,
			text,
			timestamp: ts,
		});

		it('detects "actually" correction from different sender', () => {
			const msgs = [
				msg("alex", "the eiffel tower is in london", 1000),
				msg("jordan", "actually its in paris", 2000),
			];
			assert.equal(detectCorrection(msgs), true);
		});

		it('detects "thats wrong" correction', () => {
			const msgs = [
				msg("alex", "water boils at 50 degrees", 1000),
				msg("jordan", "thats wrong, its 100", 2000),
			];
			assert.equal(detectCorrection(msgs), true);
		});

		it('detects "nope" correction', () => {
			const msgs = [
				msg("alex", "the capital of france is london", 1000),
				msg("jordan", "nope, its paris", 2000),
			];
			assert.equal(detectCorrection(msgs), true);
		});

		it("returns false for normal conversation", () => {
			const msgs = [
				msg("alex", "anyone watching the game", 1000),
				msg("jordan", "yeah coming over at 7", 2000),
			];
			assert.equal(detectCorrection(msgs), false);
		});

		it("returns false for self-correction (same sender)", () => {
			const msgs = [
				msg("alex", "the tower is in london", 1000),
				msg("alex", "actually wait no its in paris", 2000),
			];
			assert.equal(detectCorrection(msgs), false);
		});

		it("returns false for single message", () => {
			assert.equal(
				detectCorrection([msg("alex", "actually thats interesting", 1000)]),
				false,
			);
		});

		it("detects correction with 1-message gap", () => {
			const msgs = [
				msg("alex", "the eiffel tower is in london", 1000),
				msg("sam", "lol yeah", 2000),
				msg("jordan", "actually its in paris", 3000),
			];
			assert.equal(detectCorrection(msgs), true);
		});

		it("detects correction with 2-message gap", () => {
			const msgs = [
				msg("alex", "the sun is a planet", 1000),
				msg("sam", "cool", 2000),
				msg("pat", "haha", 3000),
				msg("jordan", "nope its a star", 4000),
			];
			assert.equal(detectCorrection(msgs), true);
		});

		it("returns false when only same-sender within lookback", () => {
			const msgs = [
				msg("jordan", "the tower is in london", 1000),
				msg("jordan", "actually wait no", 2000),
			];
			assert.equal(detectCorrection(msgs), false);
		});
	});

	describe("computeMomentum", () => {
		const msg = (ts: number): ChatMessage => ({
			chatId: "c1",
			sender: "alex",
			text: "hi",
			timestamp: ts,
		});

		it("returns messages per minute", () => {
			// 10 messages, 6s apart -> span = 54s -> 10/54000 * 60000 ≈ 11.1 msg/min
			const msgs = Array.from({ length: 10 }, (_, i) => msg(i * 6000));
			const mpm = computeMomentum(msgs)!;
			assert.ok(mpm > 10 && mpm < 12);
		});

		it("returns null for fewer than 2 messages", () => {
			assert.equal(computeMomentum([msg(1000)]), null);
			assert.equal(computeMomentum([]), null);
		});

		it("returns null when all timestamps are equal", () => {
			assert.equal(computeMomentum([msg(1000), msg(1000)]), null);
		});

		it("high velocity chat returns > 5", () => {
			// 20 messages in 60 seconds
			const msgs = Array.from({ length: 20 }, (_, i) => msg(i * 3000));
			assert.ok(computeMomentum(msgs)! > 5);
		});
	});

	describe("extractHour", () => {
		it("returns hour from timestamp", () => {
			const noon = new Date(2026, 2, 27, 12, 0, 0).getTime();
			assert.equal(extractHour(noon), 12);
		});

		it("returns 0 for midnight", () => {
			const midnight = new Date(2026, 2, 27, 0, 0, 0).getTime();
			assert.equal(extractHour(midnight), 0);
		});

		it("returns 23 for 11pm", () => {
			const late = new Date(2026, 2, 27, 23, 30, 0).getTime();
			assert.equal(extractHour(late), 23);
		});
	});

	describe("buildConversation", () => {
		it('labels phila messages as "you"', () => {
			const msgs: ChatMessage[] = [
				{ chatId: "c1", sender: "Alex", text: "whats up", timestamp: 1000 },
				{ chatId: "c1", sender: "phila", text: "not much", timestamp: 2000 },
				{ chatId: "c1", sender: "Alex", text: "cool", timestamp: 3000 },
			];
			const conv = buildConversation(msgs);
			assert.ok(conv.includes("you: not much"));
			assert.ok(conv.includes("person1: whats up"));
			assert.ok(!conv.includes("Alex"));
			assert.ok(!conv.includes("phila"));
		});

		it("does not count phila as a person label", () => {
			const msgs: ChatMessage[] = [
				{ chatId: "c1", sender: "Alex", text: "hey", timestamp: 1000 },
				{ chatId: "c1", sender: "phila", text: "hi", timestamp: 2000 },
				{ chatId: "c1", sender: "Jordan", text: "yo", timestamp: 3000 },
			];
			const conv = buildConversation(msgs);
			assert.ok(conv.includes("person1: hey"));
			assert.ok(conv.includes("you: hi"));
			assert.ok(conv.includes("person2: yo"));
		});
	});
});
