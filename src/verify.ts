// Fact verification via external sources.
// When the gate says SPEAK for a wrong-fact correction, verify the claim
// against DuckDuckGo Instant Answer API and Wikipedia before responding.
// Falls back to LLM-only response if verification fails or returns nothing.

export interface VerifiedResponse {
	response: string;
	source?: string;
	verified: boolean;
}

interface DuckDuckGoResponse {
	AbstractText?: string;
	Answer?: string;
	Heading?: string;
}

interface WikipediaResponse {
	extract?: string;
	title?: string;
}

function extractSearchQuery(response: string): string {
	return response
		.replace(
			/\b(actually|no|not|nope|wrong|incorrect|that'?s not right)\b,?\s*/gi,
			"",
		)
		.replace(/[.,!?]+$/, "")
		.trim();
}

async function queryDuckDuckGo(
	query: string,
	signal: AbortSignal,
): Promise<{ text: string; source: string } | null> {
	const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
	const res = await fetch(url, { signal });
	if (!res.ok) return null;

	const data = (await res.json()) as DuckDuckGoResponse;
	const text = data.AbstractText || data.Answer || "";
	if (text.length < 10) return null;

	return { text, source: "duckduckgo" };
}

async function queryWikipedia(
	query: string,
	signal: AbortSignal,
): Promise<{ text: string; source: string } | null> {
	const topic = query.replace(/\s+/g, "_");
	const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`;
	const res = await fetch(url, { signal });
	if (!res.ok) return null;

	const data = (await res.json()) as WikipediaResponse;
	if (!data.extract || data.extract.length < 10) return null;

	return { text: data.extract, source: "wikipedia" };
}

// Build a corrected response from the source text, keeping it short and casual.
// Extracts the first sentence from the source as the factual basis.
function buildCorrectedResponse(
	sourceText: string,
	originalResponse: string,
): string {
	const firstSentence = sourceText.split(/[.!?]\s/)[0];
	if (firstSentence && firstSentence.length > 10) {
		return firstSentence.toLowerCase();
	}
	return originalResponse;
}

export async function verifyClaim(response: string): Promise<VerifiedResponse> {
	const query = extractSearchQuery(response);
	if (query.length < 5) {
		return { response, verified: false };
	}

	// Run both lookups in parallel under a shared 3s deadline
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 3000);

	try {
		const results = await Promise.allSettled([
			queryDuckDuckGo(query, controller.signal),
			queryWikipedia(query, controller.signal),
		]);

		const ddg = results[0].status === "fulfilled" ? results[0].value : null;
		const wiki = results[1].status === "fulfilled" ? results[1].value : null;
		const result = ddg ?? wiki;

		if (!result) {
			return { response, verified: false };
		}

		return {
			response: buildCorrectedResponse(result.text, response),
			source: result.source,
			verified: true,
		};
	} catch {
		return { response, verified: false };
	} finally {
		clearTimeout(timeout);
	}
}

// Exported for testing
export { extractSearchQuery, queryDuckDuckGo, queryWikipedia };
