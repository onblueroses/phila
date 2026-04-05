import Database from "better-sqlite3";
import { buildConversation } from "./gate.ts";
import { summarize } from "./ollama.ts";
import type {
	ChatMessage,
	FeedbackSignal,
	GroupProfile,
	PhilaConfig,
} from "./types.ts";
import { FeedbackType } from "./types.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_id, timestamp);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text,
    content='messages',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
  END;

  CREATE TABLE IF NOT EXISTS group_profiles (
    chat_id TEXT PRIMARY KEY,
    speak_bias REAL NOT NULL DEFAULT 0.0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    type TEXT NOT NULL,
    context TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_chat ON feedback (chat_id, timestamp);

  CREATE TABLE IF NOT EXISTS group_notes (
    chat_id TEXT PRIMARY KEY,
    notes TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS extracted_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    type TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    message_id INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_facts_chat_type ON extracted_facts (chat_id, type, timestamp);
  CREATE INDEX IF NOT EXISTS idx_facts_chat_key ON extracted_facts (chat_id, key);
`;

interface MessageRow {
	chat_id: string;
	sender: string;
	text: string;
	timestamp: number;
}
interface ProfileRow {
	chat_id: string;
	speak_bias: number;
	updated_at: number;
}
interface NotesRow {
	chat_id: string;
	notes: string;
	updated_at: number;
}

// Truncate to maxChars at the last sentence boundary within the limit
function truncateToLimit(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const slice = text.slice(0, maxChars);
	const lastSentence = Math.max(
		slice.lastIndexOf(". "),
		slice.lastIndexOf(".\n"),
	);
	return lastSentence > 0 ? slice.slice(0, lastSentence + 1) : slice;
}

const POSITIVE = /\b(thanks?|helpful|good\s+one|nice\s+one|nice|great)\b/i;
const NEGATIVE =
	/\b(not\s+now|shut\s+up|nobody\s+asked|stop|be\s+quiet|go\s+away|enough)\b/i;

// Requires "phila" in the message to avoid false positives
// from unrelated "thanks" or "stop" in normal conversation.
export function detectFeedback(messages: ChatMessage[]): FeedbackSignal | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = messages[i].text.toLowerCase();
		if (!text.includes("phila")) continue;
		if (NEGATIVE.test(text))
			return {
				type: FeedbackType.NEGATIVE,
				context: text,
				timestamp: messages[i].timestamp,
			};
		if (POSITIVE.test(text))
			return {
				type: FeedbackType.POSITIVE,
				context: text,
				timestamp: messages[i].timestamp,
			};
	}
	return null;
}

export class Memory {
	private db: Database.Database;
	private insertMsg: Database.Statement;
	private selectRecent: Database.Statement;
	private selectProfile: Database.Statement;
	private upsertProfile: Database.Statement;
	private insertFeedback: Database.Statement;
	private deleteOld: Database.Statement;
	private searchFts: Database.Statement;
	private selectNotes: Database.Statement;
	private upsertNotes: Database.Statement;
	private insertFact: Database.Statement;
	private selectRecentFacts: Database.Statement;
	private selectFactsByType: Database.Statement;
	private selectFactsByKey: Database.Statement;
	private config: PhilaConfig;
	private pruneIntervalMs: number;
	private lastPruneAt = 0;

	constructor(config: PhilaConfig) {
		this.db = new Database(config.dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(SCHEMA);

		this.insertMsg = this.db.prepare(
			"INSERT INTO messages (chat_id, sender, text, timestamp) VALUES (?, ?, ?, ?)",
		);
		this.selectRecent = this.db.prepare(
			"SELECT chat_id, sender, text, timestamp FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?",
		);
		this.selectProfile = this.db.prepare(
			"SELECT chat_id, speak_bias, updated_at FROM group_profiles WHERE chat_id = ?",
		);
		this.upsertProfile = this.db.prepare(
			`INSERT INTO group_profiles (chat_id, speak_bias, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET speak_bias = excluded.speak_bias, updated_at = excluded.updated_at`,
		);
		this.insertFeedback = this.db.prepare(
			"INSERT INTO feedback (chat_id, type, context, timestamp) VALUES (?, ?, ?, ?)",
		);
		this.deleteOld = this.db.prepare(
			"DELETE FROM messages WHERE timestamp < ?",
		);
		this.searchFts = this.db.prepare(
			`SELECT m.chat_id, m.sender, m.text, m.timestamp
       FROM messages m
       JOIN messages_fts f ON m.id = f.rowid
       WHERE messages_fts MATCH ? AND m.chat_id = ?
       ORDER BY f.rank
       LIMIT ?`,
		);
		this.selectNotes = this.db.prepare(
			"SELECT chat_id, notes, updated_at FROM group_notes WHERE chat_id = ?",
		);
		this.upsertNotes = this.db.prepare(
			`INSERT INTO group_notes (chat_id, notes, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at`,
		);
		this.insertFact = this.db.prepare(
			"INSERT INTO extracted_facts (chat_id, type, key, value, message_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		);
		this.selectRecentFacts = this.db.prepare(
			"SELECT chat_id, type, key, value, message_id, timestamp FROM extracted_facts WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?",
		);
		this.selectFactsByType = this.db.prepare(
			"SELECT chat_id, type, key, value, message_id, timestamp FROM extracted_facts WHERE chat_id = ? AND type = ? ORDER BY timestamp DESC LIMIT ?",
		);
		this.selectFactsByKey = this.db.prepare(
			"SELECT chat_id, type, key, value, message_id, timestamp FROM extracted_facts WHERE chat_id = ? AND key = ? ORDER BY timestamp DESC LIMIT ?",
		);
		this.config = config;
		this.pruneIntervalMs = config.pruneAfterDays * 24 * 60 * 60 * 1000;
	}

	storeMessage(msg: ChatMessage): number {
		const result = this.insertMsg.run(
			msg.chatId,
			msg.sender,
			msg.text,
			msg.timestamp,
		);
		this.maybePrune(msg.timestamp);
		return Number(result.lastInsertRowid);
	}

	getMessagesBeforeCutoff(
		cutoff: number,
		limitPerChat: number,
	): Map<string, ChatMessage[]> {
		const rows = this.db
			.prepare(
				"SELECT chat_id, sender, text, timestamp FROM messages WHERE timestamp < ? ORDER BY chat_id, timestamp DESC LIMIT ?",
			)
			.all(cutoff, limitPerChat * 100) as MessageRow[];

		const grouped = new Map<string, ChatMessage[]>();
		for (const r of rows) {
			let msgs = grouped.get(r.chat_id);
			if (!msgs) {
				msgs = [];
				grouped.set(r.chat_id, msgs);
			}
			if (msgs.length < limitPerChat) {
				msgs.push({
					chatId: r.chat_id,
					sender: r.sender,
					text: r.text,
					timestamp: r.timestamp,
				});
			}
		}
		return grouped;
	}

	pruneOldMessages(now: number): number {
		const cutoff = now - this.pruneIntervalMs;
		const result = this.deleteOld.run(cutoff);
		this.lastPruneAt = now;
		return result.changes;
	}

	async pruneWithSummary(now: number): Promise<number> {
		const cutoff = now - this.pruneIntervalMs;
		const doomed = this.getMessagesBeforeCutoff(cutoff, 200);

		for (const [chatId, msgs] of doomed) {
			try {
				const existing = this.getGroupNotes(chatId);
				const formatted = buildConversation(msgs);
				const updated = await summarize(existing, formatted, this.config);
				this.setGroupNotes(chatId, updated);
			} catch (err) {
				console.error(
					`[phila] summarization failed for ${chatId.slice(0, 8)}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		return this.pruneOldMessages(now);
	}

	private maybePrune(now: number): void {
		// Run at most once per hour
		if (now - this.lastPruneAt > 3_600_000) {
			this.lastPruneAt = now;
			this.pruneWithSummary(now).catch((err) =>
				console.error(
					"[phila] prune error:",
					err instanceof Error ? err.message : err,
				),
			);
		}
	}

	getRecentMessages(chatId: string, limit: number): ChatMessage[] {
		const rows = this.selectRecent.all(chatId, limit) as MessageRow[];
		// Reverse: query returns newest-first, LLM needs chronological
		return rows.reverse().map((r) => ({
			chatId: r.chat_id,
			sender: r.sender,
			text: r.text,
			timestamp: r.timestamp,
		}));
	}

	searchMessages(chatId: string, query: string, limit: number): ChatMessage[] {
		try {
			const rows = this.searchFts.all(query, chatId, limit) as MessageRow[];
			return rows.map((r) => ({
				chatId: r.chat_id,
				sender: r.sender,
				text: r.text,
				timestamp: r.timestamp,
			}));
		} catch {
			// FTS5 query syntax errors should not crash the caller
			return [];
		}
	}

	getGroupProfile(chatId: string): GroupProfile {
		const row = this.selectProfile.get(chatId) as ProfileRow | undefined;
		if (!row) return { chatId, speakBias: 0.0, updatedAt: Date.now() };
		return {
			chatId: row.chat_id,
			speakBias: row.speak_bias,
			updatedAt: row.updated_at,
		};
	}

	updateGroupProfile(chatId: string, updates: Partial<GroupProfile>): void {
		const current = this.getGroupProfile(chatId);
		const merged = { ...current, ...updates, updatedAt: Date.now() };
		this.upsertProfile.run(merged.chatId, merged.speakBias, merged.updatedAt);
	}

	storeFeedback(chatId: string, signal: FeedbackSignal): void {
		this.insertFeedback.run(
			chatId,
			signal.type,
			signal.context,
			signal.timestamp,
		);
	}

	getGroupNotes(chatId: string): string {
		const row = this.selectNotes.get(chatId) as NotesRow | undefined;
		return row?.notes ?? "";
	}

	setGroupNotes(chatId: string, notes: string): void {
		const bounded = truncateToLimit(notes, 2000);
		this.upsertNotes.run(chatId, bounded, Date.now());
	}

	// Asymmetric: negative 2.5x positive weight
	applyFeedback(chatId: string, signal: FeedbackSignal): void {
		const profile = this.getGroupProfile(chatId);
		const delta = signal.type === FeedbackType.POSITIVE ? 0.02 : -0.05;
		this.updateGroupProfile(chatId, {
			speakBias: Math.max(-0.3, Math.min(0.1, profile.speakBias + delta)),
		});
		this.storeFeedback(chatId, signal);
	}

	storeFact(fact: import("./types.ts").ExtractedFact): void {
		this.insertFact.run(
			fact.chatId,
			fact.type,
			fact.key,
			fact.value,
			fact.messageId,
			fact.timestamp,
		);
	}

	getRecentFacts(
		chatId: string,
		limit = 10,
	): import("./types.ts").ExtractedFact[] {
		interface FactRow {
			chat_id: string;
			type: string;
			key: string;
			value: string;
			message_id: number;
			timestamp: number;
		}
		const rows = this.selectRecentFacts.all(chatId, limit) as FactRow[];
		return rows.map((r) => ({
			chatId: r.chat_id,
			type: r.type as import("./types.ts").FactType,
			key: r.key,
			value: r.value,
			messageId: r.message_id,
			timestamp: r.timestamp,
		}));
	}

	searchFactsByType(
		chatId: string,
		type: import("./types.ts").FactType,
		limit = 10,
	): import("./types.ts").ExtractedFact[] {
		interface FactRow {
			chat_id: string;
			type: string;
			key: string;
			value: string;
			message_id: number;
			timestamp: number;
		}
		const rows = this.selectFactsByType.all(chatId, type, limit) as FactRow[];
		return rows.map((r) => ({
			chatId: r.chat_id,
			type: r.type as import("./types.ts").FactType,
			key: r.key,
			value: r.value,
			messageId: r.message_id,
			timestamp: r.timestamp,
		}));
	}

	searchFactsByKey(
		chatId: string,
		key: string,
		limit = 10,
	): import("./types.ts").ExtractedFact[] {
		interface FactRow {
			chat_id: string;
			type: string;
			key: string;
			value: string;
			message_id: number;
			timestamp: number;
		}
		const rows = this.selectFactsByKey.all(chatId, key, limit) as FactRow[];
		return rows.map((r) => ({
			chatId: r.chat_id,
			type: r.type as import("./types.ts").FactType,
			key: r.key,
			value: r.value,
			messageId: r.message_id,
			timestamp: r.timestamp,
		}));
	}

	close(): void {
		this.db.close();
	}
}
