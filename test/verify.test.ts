import * as assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { extractSearchQuery, verifyClaim } from "../src/verify.ts";

describe("extractSearchQuery", () => {
	it("strips hedging words", () => {
		assert.equal(
			extractSearchQuery("actually the great wall is in china"),
			"the great wall is in china",
		);
	});

	it("strips multiple hedging words", () => {
		assert.equal(
			extractSearchQuery("no, that's not right, it's in china"),
			"it's in china",
		);
	});

	it("strips trailing punctuation", () => {
		assert.equal(
			extractSearchQuery("mount everest is 8849 meters."),
			"mount everest is 8849 meters",
		);
	});

	it("passes through clean responses", () => {
		assert.equal(
			extractSearchQuery("the great wall is in china"),
			"the great wall is in china",
		);
	});
});

describe("verifyClaim", () => {
	const originalFetch = globalThis.fetch;

	after(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns verified=false when query is too short", async () => {
		const result = await verifyClaim("no");
		assert.equal(result.verified, false);
	});

	it("returns verified=true with DuckDuckGo result", async () => {
		globalThis.fetch = (async (url: string | URL | Request) => {
			const u = typeof url === "string" ? url : url.toString();
			if (u.includes("duckduckgo")) {
				return new Response(
					JSON.stringify({
						AbstractText:
							"The Great Wall of China is a series of fortifications in China.",
					}),
					{ status: 200 },
				);
			}
			return new Response("", { status: 404 });
		}) as typeof fetch;

		const result = await verifyClaim("the great wall is in china, not japan");
		assert.equal(result.verified, true);
		assert.equal(result.source, "duckduckgo");
	});

	it("uses source text to build corrected response", async () => {
		globalThis.fetch = (async (url: string | URL | Request) => {
			const u = typeof url === "string" ? url : url.toString();
			if (u.includes("duckduckgo")) {
				return new Response(
					JSON.stringify({
						AbstractText:
							"The Great Wall of China is a series of fortifications built along the northern borders of China.",
					}),
					{ status: 200 },
				);
			}
			return new Response("", { status: 404 });
		}) as typeof fetch;

		const result = await verifyClaim("the great wall is in china");
		assert.equal(result.verified, true);
		// Response should be derived from source, not the original
		assert.ok(result.response.includes("great wall of china"));
	});

	it("falls back to Wikipedia when DuckDuckGo returns nothing", async () => {
		globalThis.fetch = (async (url: string | URL | Request) => {
			const u = typeof url === "string" ? url : url.toString();
			if (u.includes("duckduckgo")) {
				return new Response(JSON.stringify({}), { status: 200 });
			}
			if (u.includes("wikipedia")) {
				return new Response(
					JSON.stringify({
						extract: "Mount Everest is the highest mountain above sea level.",
						title: "Mount Everest",
					}),
					{ status: 200 },
				);
			}
			return new Response("", { status: 404 });
		}) as typeof fetch;

		const result = await verifyClaim("mount everest is 8849 meters");
		assert.equal(result.verified, true);
		assert.equal(result.source, "wikipedia");
	});

	it("returns verified=false when both APIs fail", async () => {
		globalThis.fetch = (async () => {
			return new Response("", { status: 500 });
		}) as typeof fetch;

		const result = await verifyClaim("the great wall is in china, not japan");
		assert.equal(result.verified, false);
	});

	it("returns verified=false when both APIs throw", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network error");
		}) as typeof fetch;

		const result = await verifyClaim("the great wall is in china, not japan");
		assert.equal(result.verified, false);
	});

	it("runs both APIs in parallel under shared timeout", async () => {
		let ddgCalled = false;
		let wikiCalled = false;

		globalThis.fetch = (async (url: string | URL | Request) => {
			const u = typeof url === "string" ? url : url.toString();
			if (u.includes("duckduckgo")) {
				ddgCalled = true;
				return new Response(JSON.stringify({}), { status: 200 });
			}
			if (u.includes("wikipedia")) {
				wikiCalled = true;
				return new Response(
					JSON.stringify({
						extract: "Relevant factual information about the topic.",
					}),
					{ status: 200 },
				);
			}
			return new Response("", { status: 404 });
		}) as typeof fetch;

		await verifyClaim("the eiffel tower is in paris");
		assert.equal(ddgCalled, true, "DuckDuckGo should be called");
		assert.equal(wikiCalled, true, "Wikipedia should be called in parallel");
	});
});
