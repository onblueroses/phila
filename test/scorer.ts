import { constrain } from "../src/voice.ts";
import type { Scenario } from "./scenarios.ts";

// -- Dimension scorers (each returns 0-1) --

export function scoreTopicAccuracy(
	response: string,
	scenario: Scenario,
): number {
	if (!scenario.validators?.length) {
		// No validators = social/opinion scenario. Gate decision already validates speak intent.
		// Quality is measured by casualness, AI-speak, length, voice dimensions instead.
		return 1;
	}
	// At least one validator group must pass
	const lower = response.toLowerCase();
	for (const group of scenario.validators) {
		const allRequired = group.required.every((kw) => {
			const re = new RegExp(
				`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
				"i",
			);
			return re.test(lower);
		});
		const noForbidden = group.forbidden.every((kw) => {
			const re = new RegExp(
				`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
				"i",
			);
			return !re.test(lower);
		});
		if (allRequired && noForbidden) return 1;
	}
	return 0;
}

const FORMAL_CONNECTORS =
	/\b(furthermore|moreover|additionally|consequently|nevertheless|in conclusion|as a result|it is important to note)\b/i;
const HEDGING =
	/\b(i would suggest|it might be|perhaps you could|one could argue|it's worth noting|i should mention)\b/i;

export function scoreCasualness(response: string): number {
	if (!response) return 0;
	let score = 0;

	// (a) no formal connectors
	if (!FORMAL_CONNECTORS.test(response)) score += 0.25;

	// (b) avg sentence length < 15 words
	const sentences = response.split(/[.!?]+/).filter((s) => s.trim());
	const avgWords = sentences.length
		? sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) /
			sentences.length
		: 0;
	if (avgWords < 15) score += 0.25;

	// (c) no hedging
	if (!HEDGING.test(response)) score += 0.25;

	// (d) not all-caps or title-case throughout
	const allCaps = response === response.toUpperCase() && response.length > 5;
	const titleCase =
		response.split(" ").every((w) => w[0] === w[0]?.toUpperCase()) &&
		response.length > 10;
	if (!allCaps && !titleCase) score += 0.25;

	return score;
}

const AI_SPEAK_CLUSTERS: RegExp[] = [
	/\b(hi there|hello|hey there)[!,.]?\s*(how can i|what can i|i'?m here to)/i, // greetings
	/\b(i'?d be happy to|happy to help|glad to help|glad you asked)\b/i, // offers
	/\b(great question|excellent question|good question|wonderful question)\b/i, // enthusiasm
	/\b(i would suggest|perhaps you could|you might want to|it might be worth)\b/i, // hedging
	/\b(as an ai|as a language model|i don'?t have personal)\b/i, // meta
	/\b(certainly|absolutely|indeed|furthermore|moreover)\b/i, // formal
];

export function scoreAiSpeakAbsence(response: string): number {
	if (!response) return 0;
	let score = 1.0;
	for (const pattern of AI_SPEAK_CLUSTERS) {
		if (pattern.test(response)) score -= 0.2;
	}
	return Math.max(0, score);
}

export function scoreLengthFit(response: string): number {
	const len = response.length;
	if (len < 5) return 0;
	if (len <= 80) return 1.0;
	if (len <= 120) return 0.7;
	if (len <= 150) return 0.4;
	return 0.1;
}

export function scoreVoiceSurvival(response: string): number {
	if (!response) return 0;
	const constrained = constrain(response);
	if (!constrained) return 0;
	return constrained.length / response.length;
}

// -- Composite --

const WEIGHTS = {
	topicAccuracy: 0.35,
	casualness: 0.25,
	aiSpeakAbsence: 0.2,
	lengthFit: 0.1,
	voiceSurvival: 0.1,
};

export interface ScoreBreakdown {
	topicAccuracy: number;
	casualness: number;
	aiSpeakAbsence: number;
	lengthFit: number;
	voiceSurvival: number;
	composite: number;
}

export function scoreResponse(
	response: string,
	scenario: Scenario,
): ScoreBreakdown {
	const topicAccuracy = scoreTopicAccuracy(response, scenario);
	const casualness = scoreCasualness(response);
	const aiSpeakAbsence = scoreAiSpeakAbsence(response);
	const lengthFit = scoreLengthFit(response);
	const voiceSurvival = scoreVoiceSurvival(response);

	const composite =
		topicAccuracy * WEIGHTS.topicAccuracy +
		casualness * WEIGHTS.casualness +
		aiSpeakAbsence * WEIGHTS.aiSpeakAbsence +
		lengthFit * WEIGHTS.lengthFit +
		voiceSurvival * WEIGHTS.voiceSurvival;

	return {
		topicAccuracy,
		casualness,
		aiSpeakAbsence,
		lengthFit,
		voiceSurvival,
		composite,
	};
}

// -- Auto-rebalancing composite weights --

export function compositeWeights(gateAccuracy: number): {
	gate: number;
	quality: number;
	latency: number;
} {
	if (gateAccuracy >= 0.99) return { gate: 0.4, quality: 0.45, latency: 0.15 };
	return { gate: 0.7, quality: 0.2, latency: 0.1 };
}
