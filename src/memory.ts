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

interface MessageRow { chat_id: string; sender: string; text: string; timestamp: number }
interface ProfileRow { chat_id: string; speak_bias: number; updated_at: number }

const POSITIVE = /\b(thanks?|helpful|good\s+one|nice\s+one|nice|great)\b/i
const NEGATIVE = /\b(not\s+now|shut\s+up|nobody\s+asked|stop|be\s+quiet|go\s+away|enough)\b/i

// Requires "phila" in the message to avoid false positives
// from unrelated "thanks" or "stop" in normal conversation.
export function detectFeedback(messages: ChatMessage[]): FeedbackSignal | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i].text.toLowerCase()
    if (!text.includes('phila')) continue
    if (NEGATIVE.test(text)) return { type: FeedbackType.NEGATIVE, context: text, timestamp: messages[i].timestamp }
    if (POSITIVE.test(text)) return { type: FeedbackType.POSITIVE, context: text, timestamp: messages[i].timestamp }
  }
  return null
}

export class Memory {
  private db: Database.Database
  private insertMsg: Database.Statement
  private selectRecent: Database.Statement
  private selectProfile: Database.Statement
  private upsertProfile: Database.Statement
  private insertFeedback: Database.Statement

  constructor(config: PhilaConfig) {
    this.db = new Database(config.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)

    this.insertMsg = this.db.prepare(
      'INSERT INTO messages (chat_id, sender, text, timestamp) VALUES (?, ?, ?, ?)',
    )
    this.selectRecent = this.db.prepare(
      'SELECT chat_id, sender, text, timestamp FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?',
    )
    this.selectProfile = this.db.prepare(
      'SELECT chat_id, speak_bias, updated_at FROM group_profiles WHERE chat_id = ?',
    )
    this.upsertProfile = this.db.prepare(
      `INSERT INTO group_profiles (chat_id, speak_bias, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET speak_bias = excluded.speak_bias, updated_at = excluded.updated_at`,
    )
    this.insertFeedback = this.db.prepare(
      'INSERT INTO feedback (chat_id, type, context, timestamp) VALUES (?, ?, ?, ?)',
    )
  }

  storeMessage(msg: ChatMessage): void {
    this.insertMsg.run(msg.chatId, msg.sender, msg.text, msg.timestamp)
  }

  getRecentMessages(chatId: string, limit: number): ChatMessage[] {
    const rows = this.selectRecent.all(chatId, limit) as MessageRow[]
    // Reverse: query returns newest-first, LLM needs chronological
    return rows.reverse().map((r) => ({
      chatId: r.chat_id, sender: r.sender, text: r.text, timestamp: r.timestamp,
    }))
  }

  getGroupProfile(chatId: string): GroupProfile {
    const row = this.selectProfile.get(chatId) as ProfileRow | undefined
    if (!row) return { chatId, speakBias: 0.0, updatedAt: Date.now() }
    return { chatId: row.chat_id, speakBias: row.speak_bias, updatedAt: row.updated_at }
  }

  updateGroupProfile(chatId: string, updates: Partial<GroupProfile>): void {
    const current = this.getGroupProfile(chatId)
    const merged = { ...current, ...updates, updatedAt: Date.now() }
    this.upsertProfile.run(merged.chatId, merged.speakBias, merged.updatedAt)
  }

  storeFeedback(chatId: string, signal: FeedbackSignal): void {
    this.insertFeedback.run(chatId, signal.type, signal.context, signal.timestamp)
  }

  // Asymmetric: negative 2.5x positive weight
  applyFeedback(chatId: string, signal: FeedbackSignal): void {
    const profile = this.getGroupProfile(chatId)
    const delta = signal.type === FeedbackType.POSITIVE ? 0.02 : -0.05
    this.updateGroupProfile(chatId, {
      speakBias: Math.max(-0.3, Math.min(0.1, profile.speakBias + delta)),
    })
    this.storeFeedback(chatId, signal)
  }

  close(): void {
    this.db.close()
  }
}
