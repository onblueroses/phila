import Database from 'better-sqlite3'
import { FeedbackType } from './types.ts'
import type { ChatMessage, FeedbackSignal, GroupProfile, PhilaConfig } from './types.ts'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_id, timestamp);

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
`

export class Memory {
  private db: Database.Database

  constructor(config: PhilaConfig) {
    this.db = new Database(config.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  storeMessage(msg: ChatMessage): void {
    this.db
      .prepare('INSERT INTO messages (chat_id, sender, text, timestamp) VALUES (?, ?, ?, ?)')
      .run(msg.chatId, msg.sender, msg.text, msg.timestamp)
  }

  getRecentMessages(chatId: string, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare(
        'SELECT chat_id, sender, text, timestamp FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(chatId, limit) as Array<{
      chat_id: string
      sender: string
      text: string
      timestamp: number
    }>

    // Reverse so oldest is first (chronological order for LLM context)
    return rows
      .map((r) => ({
        chatId: r.chat_id,
        sender: r.sender,
        text: r.text,
        timestamp: r.timestamp,
      }))
      .reverse()
  }

  getGroupProfile(chatId: string): GroupProfile {
    const row = this.db
      .prepare('SELECT chat_id, speak_bias, updated_at FROM group_profiles WHERE chat_id = ?')
      .get(chatId) as
      | { chat_id: string; speak_bias: number; updated_at: number }
      | undefined

    if (!row) {
      return { chatId, speakBias: 0.0, updatedAt: Date.now() }
    }

    return {
      chatId: row.chat_id,
      speakBias: row.speak_bias,
      updatedAt: row.updated_at,
    }
  }

  updateGroupProfile(chatId: string, updates: Partial<GroupProfile>): void {
    const current = this.getGroupProfile(chatId)
    const merged = { ...current, ...updates, updatedAt: Date.now() }

    this.db
      .prepare(
        `INSERT INTO group_profiles (chat_id, speak_bias, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           speak_bias = excluded.speak_bias,
           updated_at = excluded.updated_at`,
      )
      .run(merged.chatId, merged.speakBias, merged.updatedAt)
  }

  storeFeedback(chatId: string, signal: FeedbackSignal): void {
    this.db
      .prepare('INSERT INTO feedback (chat_id, type, context, timestamp) VALUES (?, ?, ?, ?)')
      .run(chatId, signal.type, signal.context, signal.timestamp)
  }

  // Scan recent messages for feedback directed at phila.
  // Requires "phila" in the message to avoid false positives from
  // unrelated "lol" or "stop" in normal conversation.
  detectFeedback(messages: ChatMessage[]): FeedbackSignal | null {
    const positivePatterns = /\b(thanks?|helpful|good\s+one|nice\s+one|nice|great)\b/i
    const negativePatterns = /\b(not\s+now|shut\s+up|nobody\s+asked|stop|be\s+quiet|go\s+away|enough)\b/i

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (!msg.text) continue

      const text = msg.text.toLowerCase()

      // Feedback must mention phila by name - otherwise "lol" or "stop"
      // in unrelated conversation would be misread as feedback
      if (!text.includes('phila')) continue

      if (negativePatterns.test(text)) {
        return { type: FeedbackType.NEGATIVE, context: text, timestamp: msg.timestamp }
      }
      if (positivePatterns.test(text)) {
        return { type: FeedbackType.POSITIVE, context: text, timestamp: msg.timestamp }
      }
    }

    return null
  }

  // Adjust group profile based on feedback. Asymmetric: negative has 2.5x the weight.
  applyFeedback(chatId: string, signal: FeedbackSignal): void {
    const profile = this.getGroupProfile(chatId)
    const delta = signal.type === FeedbackType.POSITIVE ? 0.02 : -0.05
    const newBias = Math.max(-0.3, Math.min(0.1, profile.speakBias + delta))

    this.updateGroupProfile(chatId, { speakBias: newBias })
    this.storeFeedback(chatId, signal)
  }

  close(): void {
    this.db.close()
  }
}
