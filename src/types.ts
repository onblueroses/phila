// Re-export the SDK's Message type under a namespace to avoid collision
import type { Message as SDKMessage } from '@photon-ai/imessage-kit'

export type { SDKMessage }

// Internal representation - stripped to what phila needs
export interface ChatMessage {
  text: string
  sender: string
  chatId: string
  timestamp: number
}

export const GateAction = {
  SILENT: 'silent',
  SPEAK: 'speak',
} as const

export type GateAction = (typeof GateAction)[keyof typeof GateAction]

export type GateDecision =
  | { action: typeof GateAction.SILENT }
  | { action: typeof GateAction.SPEAK; reason: string; response: string }

export interface GroupProfile {
  chatId: string
  speakBias: number
  updatedAt: number
}

export const FeedbackType = {
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
} as const

export type FeedbackType = (typeof FeedbackType)[keyof typeof FeedbackType]

export interface FeedbackSignal {
  type: FeedbackType
  context: string
  timestamp: number
}

export interface PhilaConfig {
  model: string
  ollamaUrl: string
  batchWindowMs: number
  memoryWindowSize: number
  dbPath: string
}

// Convert SDK message to our internal format at the boundary
export function fromSDKMessage(msg: SDKMessage): ChatMessage | null {
  if (!msg.text) return null
  return {
    text: msg.text,
    sender: msg.sender,
    chatId: msg.chatId,
    timestamp: msg.date.getTime(),
  }
}
