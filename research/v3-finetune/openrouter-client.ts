// Shared OpenRouter client with model rotation for free-tier rate limit avoidance.
// Cycles through free models, backs off on 429, tracks per-model cooldowns.

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Paid models - fast, no rate limits. Sorted by quality/cost ratio.
const FREE_MODELS = [
	"google/gemma-3-27b-it",
	"meta-llama/llama-3.3-70b-instruct",
	"google/gemma-3-12b-it",
];

const FALLBACK_MODEL = "google/gemma-3-27b-it";

interface ModelState {
	cooldownUntil: number;
	consecutive429s: number;
}

const modelStates = new Map<string, ModelState>();

let currentModelIdx = 0;
let totalRequests = 0;
let total429s = 0;

function getActiveModel(): string {
	const now = Date.now();

	// Try each model in order
	for (let i = 0; i < FREE_MODELS.length; i++) {
		const idx = (currentModelIdx + i) % FREE_MODELS.length;
		const model = FREE_MODELS[idx]!;
		const state = modelStates.get(model);
		if (!state || now >= state.cooldownUntil) {
			currentModelIdx = idx;
			return model;
		}
	}

	// All models on cooldown - check fallback
	const fallbackState = modelStates.get(FALLBACK_MODEL);
	if (!fallbackState || now >= fallbackState.cooldownUntil) {
		return FALLBACK_MODEL;
	}

	// Everything on cooldown - find the one that cools down soonest
	let soonest = Infinity;
	let soonestModel = FREE_MODELS[0]!;
	for (const model of [...FREE_MODELS, FALLBACK_MODEL]) {
		const state = modelStates.get(model);
		if (state && state.cooldownUntil < soonest) {
			soonest = state.cooldownUntil;
			soonestModel = model;
		}
	}
	return soonestModel;
}

function markRateLimited(model: string) {
	const state = modelStates.get(model) ?? {
		cooldownUntil: 0,
		consecutive429s: 0,
	};
	state.consecutive429s++;
	// Exponential backoff: 5s, 10s, 20s, 40s, 60s max
	const backoff = Math.min(5000 * 2 ** (state.consecutive429s - 1), 60_000);
	state.cooldownUntil = Date.now() + backoff;
	modelStates.set(model, state);
	total429s++;

	// Rotate to next model
	currentModelIdx = (currentModelIdx + 1) % FREE_MODELS.length;
}

function markSuccess(model: string) {
	const state = modelStates.get(model);
	if (state) state.consecutive429s = 0;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export async function callOpenRouter(
	apiKey: string,
	messages: ChatMessage[],
	opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string | null> {
	const model = getActiveModel();
	const isFallback = model === FALLBACK_MODEL;
	const maxTokens = isFallback ? 4000 : (opts.maxTokens ?? 500);

	// Wait if model is on cooldown
	const state = modelStates.get(model);
	if (state && Date.now() < state.cooldownUntil) {
		const wait = state.cooldownUntil - Date.now();
		await new Promise((r) => setTimeout(r, wait));
	}

	totalRequests++;

	try {
		const res = await fetch(API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(isFallback ? 45_000 : 20_000),
			body: JSON.stringify({
				model,
				messages,
				temperature: opts.temperature ?? 0.95,
				max_tokens: maxTokens,
				top_p: 0.95,
			}),
		});

		if (res.status === 429) {
			markRateLimited(model);
			return null;
		}

		if (!res.ok) return null;

		interface Choice {
			message: { content: string | null; reasoning?: string };
		}
		interface Response {
			choices?: Choice[];
		}
		const data = (await res.json()) as Response;
		const content = data.choices?.[0]?.message?.content;
		if (!content) return null;

		markSuccess(model);
		return content;
	} catch {
		return null;
	}
}

export function getStats(): string {
	const cooldowns = [...modelStates.entries()]
		.filter(([, s]) => Date.now() < s.cooldownUntil)
		.map(([m]) => m.split("/")[1]?.replace(":free", ""));
	return `reqs=${totalRequests} 429s=${total429s} cooled=${cooldowns.join(",") || "none"} active=${getActiveModel().split("/")[1]?.replace(":free", "")}`;
}

// Brief delay between batches to avoid bursting
export async function rateLimitDelay(_concurrency: number) {
	await new Promise((r) => setTimeout(r, 100));
}
