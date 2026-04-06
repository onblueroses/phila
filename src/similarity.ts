import type { ExtractedFact } from "./types.ts";

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

export function findRelevantFacts(
	queryEmbedding: Float32Array,
	facts: Array<ExtractedFact & { embedding: Float32Array }>,
	threshold = 0.5,
	topK = 5,
): ExtractedFact[] {
	const scored = facts
		.map((f) => ({
			fact: f,
			score: cosineSimilarity(queryEmbedding, f.embedding),
		}))
		.filter((s) => s.score >= threshold)
		.sort((a, b) => b.score - a.score)
		.slice(0, topK);

	return scored.map((s) => ({
		chatId: s.fact.chatId,
		type: s.fact.type,
		key: s.fact.key,
		value: s.fact.value,
		messageId: s.fact.messageId,
		timestamp: s.fact.timestamp,
	}));
}
