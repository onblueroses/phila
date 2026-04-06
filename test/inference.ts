// Shared inference config and Ollama client for benchmark/optimization tools.

export interface InferenceConfig {
	model: string;
	temperature: number;
	numPredict: number;
	topP: number;
	repeatPenalty?: number;
	mirostat?: number;
	mirostatTau?: number;
	mirostatEta?: number;
	seed?: number | null;
}

export async function infer(
	system: string,
	user: string,
	config: InferenceConfig,
	ollamaUrl: string,
): Promise<string> {
	const res = await fetch(`${ollamaUrl}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(120_000),
		body: JSON.stringify({
			model: config.model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			stream: false,
			options: {
				temperature: config.temperature,
				num_predict: config.numPredict,
				top_p: config.topP,
				...(config.repeatPenalty != null
					? { repeat_penalty: config.repeatPenalty }
					: {}),
				...(config.mirostat != null ? { mirostat: config.mirostat } : {}),
				...(config.mirostatTau != null
					? { mirostat_tau: config.mirostatTau }
					: {}),
				...(config.mirostatEta != null
					? { mirostat_eta: config.mirostatEta }
					: {}),
				...(config.seed != null ? { seed: config.seed } : {}),
			},
		}),
	});
	if (!res.ok) throw new Error(`ollama ${res.status}`);
	return ((await res.json()) as { message: { content: string } }).message
		.content;
}
