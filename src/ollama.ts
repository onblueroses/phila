import type { PhilaConfig } from "./types.ts";

interface OllamaResponse {
	message: { content: string };
}

interface OllamaEmbedResponse {
	embeddings: number[][];
}

async function attempt(
	system: string,
	user: string,
	config: PhilaConfig,
): Promise<string> {
	const res = await fetch(`${config.ollamaUrl}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(30_000),
		body: JSON.stringify({
			model: config.model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			stream: false,
			options: { temperature: 0.1, num_predict: 64, top_p: 0.52 },
		}),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`ollama ${res.status}: ${body}`);
	}

	return ((await res.json()) as OllamaResponse).message.content;
}

export async function chat(
	system: string,
	user: string,
	config: PhilaConfig,
): Promise<string> {
	try {
		return await attempt(system, user, config);
	} catch {
		await new Promise((r) => setTimeout(r, 2000));
		return attempt(system, user, config);
	}
}

// Fast classification call: numPredict=8 gives the model room to output a classification word
async function attemptFast(
	system: string,
	user: string,
	config: PhilaConfig,
): Promise<string> {
	const res = await fetch(`${config.ollamaUrl}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(15_000),
		body: JSON.stringify({
			model: config.model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			stream: false,
			options: { temperature: 0.1, num_predict: 8, top_p: 0.52 },
		}),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`ollama ${res.status}: ${body}`);
	}

	return ((await res.json()) as OllamaResponse).message.content;
}

export async function chatFast(
	system: string,
	user: string,
	config: PhilaConfig,
): Promise<string> {
	try {
		return await attemptFast(system, user, config);
	} catch {
		await new Promise((r) => setTimeout(r, 2000));
		return attemptFast(system, user, config);
	}
}

async function attemptEmbed(
	input: string,
	config: PhilaConfig,
): Promise<Float32Array> {
	const res = await fetch(`${config.ollamaUrl}/api/embed`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(15_000),
		body: JSON.stringify({ model: config.embedModel, input }),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`ollama embed ${res.status}: ${body}`);
	}

	const data = (await res.json()) as OllamaEmbedResponse;
	return new Float32Array(data.embeddings[0]);
}

export async function embed(
	input: string,
	config: PhilaConfig,
): Promise<Float32Array> {
	try {
		return await attemptEmbed(input, config);
	} catch {
		await new Promise((r) => setTimeout(r, 2000));
		return attemptEmbed(input, config);
	}
}

const SUMMARIZE_SYSTEM = `you maintain concise notes about a group chat. given the existing notes and new messages, produce updated notes.
keep only facts, recurring topics, and notable events. max 2000 characters.
use person1/person2 style labels, not real names. output only the updated notes, nothing else.`;

async function attemptSummarize(
	existingNotes: string,
	messages: string,
	config: PhilaConfig,
): Promise<string> {
	const user = `existing notes:\n${existingNotes}\n\nnew messages:\n${messages}`;
	const res = await fetch(`${config.ollamaUrl}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(60_000),
		body: JSON.stringify({
			model: config.model,
			messages: [
				{ role: "system", content: SUMMARIZE_SYSTEM },
				{ role: "user", content: user },
			],
			stream: false,
			options: { temperature: 0.3, num_predict: 256, top_p: 0.9 },
		}),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`ollama ${res.status}: ${body}`);
	}

	return ((await res.json()) as OllamaResponse).message.content;
}

export async function summarize(
	existingNotes: string,
	messages: string,
	config: PhilaConfig,
): Promise<string> {
	try {
		return await attemptSummarize(existingNotes, messages, config);
	} catch {
		await new Promise((r) => setTimeout(r, 2000));
		return attemptSummarize(existingNotes, messages, config);
	}
}
