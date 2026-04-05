export interface ChatMessage {
	text: string;
	sender: string;
	chatId: string;
	timestamp: number;
}

export const GateAction = {
	SILENT: "silent",
	SPEAK: "speak",
} as const;

export type GateAction = (typeof GateAction)[keyof typeof GateAction];

export type GateDecision =
	| { action: typeof GateAction.SILENT }
	| { action: typeof GateAction.SPEAK; reason: string; response: string };

export interface GroupProfile {
	chatId: string;
	speakBias: number;
	updatedAt: number;
}

export const FeedbackType = {
	POSITIVE: "positive",
	NEGATIVE: "negative",
} as const;

export type FeedbackType = (typeof FeedbackType)[keyof typeof FeedbackType];

export interface FeedbackSignal {
	type: FeedbackType;
	context: string;
	timestamp: number;
}

export interface ConversationContext {
	correctionHint: boolean;
	messagesPerMinute: number | null;
	latestMessageHour: number | null; // 0-23, local time
	groupNotes: string | null;
}

export type GateMode = "monolithic" | "hierarchical" | "dual";

export type Classification = "social" | "claim" | "question" | "memory-query";

export type HierarchicalDecision = GateDecision & {
	stages: string[];
	classification?: Classification;
};

export type FactType = "logistics" | "commitment" | "preference" | "personal";

export interface ExtractedFact {
	chatId: string;
	type: FactType;
	key: string;
	value: string;
	messageId: number;
	timestamp: number;
}

export interface PhilaConfig {
	model: string;
	ollamaUrl: string;
	batchWindowMs: number;
	memoryWindowSize: number;
	dbPath: string;
	pruneAfterDays: number;
	gateMode: GateMode;
}
