import type { PhilaConfig } from "./types.ts";

export const config: Readonly<PhilaConfig> = Object.freeze({
	model: process.env.PHILA_MODEL ?? "llama3.2",
	embedModel: process.env.PHILA_EMBED_MODEL ?? "nomic-embed-text",
	ollamaUrl: process.env.PHILA_OLLAMA_URL ?? "http://localhost:11434",
	batchWindowMs: Number(process.env.PHILA_BATCH_WINDOW) || 3000,
	memoryWindowSize: Number(process.env.PHILA_MEMORY_WINDOW) || 50,
	dbPath: process.env.PHILA_DB_PATH ?? "phila.db",
	pruneAfterDays: Number(process.env.PHILA_PRUNE_DAYS) || 7,
	gateMode: (["hierarchical", "dual"].includes(process.env.PHILA_GATE ?? "")
		? (process.env.PHILA_GATE as PhilaConfig["gateMode"])
		: "monolithic") as PhilaConfig["gateMode"],
});
