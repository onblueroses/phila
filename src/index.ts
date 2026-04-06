import type { Message } from "@photon-ai/imessage-kit";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import closeWithGrace from "close-with-grace";
import { config } from "./config.ts";
import {
	computeMomentum,
	detectCorrection,
	evaluate,
	extractHour,
} from "./gate.ts";
import { evaluateDual } from "./gate-dual.ts";
import { evaluateHierarchical } from "./gate-hierarchical.ts";
import { detectFeedback, Memory } from "./memory.ts";
import { extractFacts } from "./memory-extract.ts";
import { embed } from "./ollama.ts";
import { findRelevantFacts } from "./similarity.ts";
import type {
	ChatMessage,
	ConversationContext,
	ExtractedFact,
} from "./types.ts";
import { GateAction } from "./types.ts";
import { verifyClaim } from "./verify.ts";
import { constrain } from "./voice.ts";

function toInternal(msg: Message): ChatMessage | null {
	if (!msg.text) return null;
	return {
		text: msg.text,
		sender: msg.sender,
		chatId: msg.chatId,
		timestamp: msg.date.getTime(),
	};
}

function createBatcher(
	windowMs: number,
	onBatch: (chatId: string, messages: ChatMessage[]) => void | Promise<void>,
): (msg: ChatMessage) => void {
	const pending = new Map<
		string,
		{
			messages: ChatMessage[];
			timer: ReturnType<typeof setTimeout> | undefined;
		}
	>();

	return (msg) => {
		let entry = pending.get(msg.chatId);
		if (entry) {
			clearTimeout(entry.timer);
			entry.messages.push(msg);
		} else {
			entry = { messages: [msg], timer: undefined };
			pending.set(msg.chatId, entry);
		}

		entry.timer = setTimeout(() => {
			pending.delete(msg.chatId);
			onBatch(msg.chatId, entry.messages);
		}, windowMs);
	};
}

const memory = new Memory(config);
const sdk = new IMessageSDK({
	watcher: { pollInterval: 2000, excludeOwnMessages: true },
});
const log = (msg: string) =>
	console.log(`[phila ${new Date().toISOString().slice(11, 19)}] ${msg}`);

const feed = createBatcher(
	config.batchWindowMs,
	async (chatId, newMessages) => {
		try {
			const recent = memory.getRecentMessages(chatId, config.memoryWindowSize);
			const profile = memory.getGroupProfile(chatId);

			const feedback = detectFeedback(newMessages);
			if (feedback) {
				memory.applyFeedback(chatId, feedback);
				log(`feedback: ${feedback.type} in ${chatId.slice(0, 8)}`);
			}

			const lastTs = newMessages[newMessages.length - 1].timestamp;
			const ctx: ConversationContext = {
				correctionHint: detectCorrection(recent),
				messagesPerMinute: computeMomentum(recent),
				latestMessageHour: extractHour(lastTs),
				groupNotes: memory.getGroupNotes(chatId) || null,
			};

			const decision =
				config.gateMode === "dual"
					? await evaluateDual(
							newMessages,
							recent,
							profile,
							config,
							ctx,
							memory,
						)
					: config.gateMode === "hierarchical"
						? await evaluateHierarchical(
								newMessages,
								profile,
								config,
								ctx,
								recent,
							)
						: await evaluate(recent, profile, config, ctx);

			const stageTrace =
				"stages" in decision
					? ` [${(decision as { stages: string[] }).stages.join(" -> ")}]`
					: "";

			// Background extraction: fire-and-forget, never blocks gate response
			extractFacts(newMessages, config)
				.then(async (facts) => {
					for (const fact of facts) {
						const stored: ExtractedFact = {
							chatId,
							type: fact.type,
							key: fact.key,
							value: fact.value,
							messageId: 0,
							timestamp: Date.now(),
						};
						try {
							const embedding = await embed(
								`${fact.key}: ${fact.value}`,
								config,
							);
							memory.storeFactWithEmbedding(stored, embedding);
						} catch {
							memory.storeFact(stored);
						}
					}
					if (facts.length)
						log(`extracted ${facts.length} facts from ${chatId.slice(0, 8)}`);
				})
				.catch((err) =>
					log(
						`extraction error: ${err instanceof Error ? err.message : String(err)}`,
					),
				);

			// Recall path: SILENT + tools:["recall"] -> embed and re-evaluate with facts
			let finalDecision = decision;
			if (
				decision.action === GateAction.SILENT &&
				decision.tools?.includes("recall")
			) {
				const factsWithEmbed = memory.getFactsWithEmbeddings(chatId, 20);
				if (factsWithEmbed.length > 0) {
					let bestFacts: ExtractedFact[] = [];
					for (const text of newMessages.map((m) => m.text)) {
						try {
							const queryEmbed = await embed(text, config);
							const found = findRelevantFacts(queryEmbed, factsWithEmbed);
							if (found.length > bestFacts.length) bestFacts = found;
						} catch {
							// Embedding failed for this message, try next
						}
					}
					if (bestFacts.length > 0) {
						log(
							`recall: ${bestFacts.length} facts injected in ${chatId.slice(0, 8)}`,
						);
						finalDecision = await evaluate(
							recent,
							profile,
							config,
							ctx,
							bestFacts,
						);
					}
				}
			}

			if (finalDecision.action === GateAction.SPEAK) {
				let finalResponse = finalDecision.response;

				// Verify fact corrections via explicit tool request
				if (finalDecision.tools?.includes("verify")) {
					try {
						const verified = await verifyClaim(finalDecision.response);
						finalResponse = verified.response;
						if (verified.verified) {
							log(`verified (${verified.source}) in ${chatId.slice(0, 8)}`);
						}
					} catch {
						// Verification failed, use LLM response as-is
					}
				}

				const response = constrain(finalResponse);
				log(
					`speak (${finalDecision.reason}) in ${chatId.slice(0, 8)}${stageTrace}: ${response}`,
				);
				await sdk.send(chatId, response);
				memory.storeMessage({
					chatId,
					sender: "phila",
					text: response,
					timestamp: Date.now(),
				});
				memory.logDecision({
					chatId,
					decision: "speak",
					reason: finalDecision.reason,
					toolsUsed: finalDecision.tools,
					response,
					timestamp: Date.now(),
				});
				if (feedback) {
					memory.linkFeedback(
						chatId,
						feedback.type,
						feedback.context,
						feedback.timestamp,
					);
				}
			} else {
				log(
					`silent in ${chatId.slice(0, 8)} (${newMessages.length} msgs)${stageTrace}`,
				);
				if (feedback) {
					memory.linkFeedback(
						chatId,
						feedback.type,
						feedback.context,
						feedback.timestamp,
					);
				}
			}
		} catch (err) {
			log(`error: ${err instanceof Error ? err.message : String(err)}`);
		}
	},
);

log(`starting... (gate: ${config.gateMode})`);

await sdk.startWatching({
	onGroupMessage: (msg) => {
		const internal = toInternal(msg);
		if (!internal) return;
		memory.storeMessage(internal);
		feed(internal);
	},
	onError: (err) => log(`watcher error: ${err.message}`),
});

log("watching group chats");

closeWithGrace({ delay: 3000 }, async () => {
	log("shutting down...");
	sdk.stopWatching();
	memory.close();
	log("goodbye");
});
