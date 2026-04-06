import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cosineSimilarity, findRelevantFacts } from "../src/similarity.ts";
import type { ExtractedFact } from "../src/types.ts";

describe("cosineSimilarity", () => {
	it("identical vectors return 1", () => {
		const v = new Float32Array([1, 2, 3]);
		assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 1e-6);
	});

	it("orthogonal vectors return 0", () => {
		const a = new Float32Array([1, 0, 0]);
		const b = new Float32Array([0, 1, 0]);
		assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-6);
	});

	it("opposite vectors return -1", () => {
		const a = new Float32Array([1, 0, 0]);
		const b = new Float32Array([-1, 0, 0]);
		assert.ok(Math.abs(cosineSimilarity(a, b) + 1.0) < 1e-6);
	});

	it("zero vector returns 0", () => {
		const a = new Float32Array([0, 0, 0]);
		const b = new Float32Array([1, 2, 3]);
		assert.equal(cosineSimilarity(a, b), 0);
	});

	it("similar vectors score high", () => {
		const a = new Float32Array([1, 2, 3]);
		const b = new Float32Array([1.1, 2.1, 3.1]);
		assert.ok(cosineSimilarity(a, b) > 0.99);
	});
});

function makeFact(
	key: string,
	value: string,
	embedding: Float32Array,
): ExtractedFact & { embedding: Float32Array } {
	return {
		chatId: "test",
		type: "logistics",
		key,
		value,
		messageId: 0,
		timestamp: Date.now(),
		embedding,
	};
}

describe("findRelevantFacts", () => {
	it("returns facts above threshold sorted by score", () => {
		const query = new Float32Array([1, 0, 0]);
		const facts = [
			makeFact("close", "close match", new Float32Array([0.9, 0.1, 0])),
			makeFact("far", "far away", new Float32Array([0, 1, 0])),
			makeFact("mid", "mid match", new Float32Array([0.6, 0.4, 0])),
		];
		const result = findRelevantFacts(query, facts, 0.5);
		assert.equal(result.length, 2);
		assert.equal(result[0].key, "close");
		assert.equal(result[1].key, "mid");
	});

	it("returns empty when nothing exceeds threshold", () => {
		const query = new Float32Array([1, 0, 0]);
		const facts = [makeFact("orth", "orthogonal", new Float32Array([0, 1, 0]))];
		const result = findRelevantFacts(query, facts, 0.5);
		assert.equal(result.length, 0);
	});

	it("respects topK limit", () => {
		const query = new Float32Array([1, 0, 0]);
		const facts = [
			makeFact("a", "a", new Float32Array([0.9, 0.1, 0])),
			makeFact("b", "b", new Float32Array([0.8, 0.2, 0])),
			makeFact("c", "c", new Float32Array([0.7, 0.3, 0])),
		];
		const result = findRelevantFacts(query, facts, 0.1, 2);
		assert.equal(result.length, 2);
	});

	it("strips embedding from returned facts", () => {
		const query = new Float32Array([1, 0, 0]);
		const facts = [makeFact("a", "a", new Float32Array([0.9, 0.1, 0]))];
		const result = findRelevantFacts(query, facts, 0.1);
		assert.equal(result.length, 1);
		assert.equal("embedding" in result[0], false);
	});
});
