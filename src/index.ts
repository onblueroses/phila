import { IMessageSDK } from '@photon-ai/imessage-kit'
import type { Message } from '@photon-ai/imessage-kit'
import closeWithGrace from 'close-with-grace'
import { config } from './config.ts'
import { evaluate, detectCorrection, computeMomentum, extractHour } from './gate.ts'
import { evaluateHierarchical } from './gate-hierarchical.ts'
import { Memory, detectFeedback } from './memory.ts'
import { GateAction } from './types.ts'
import type { ChatMessage, ConversationContext } from './types.ts'
import { constrain } from './voice.ts'

function toInternal(msg: Message): ChatMessage | null {
  if (!msg.text) return null
  return { text: msg.text, sender: msg.sender, chatId: msg.chatId, timestamp: msg.date.getTime() }
}

function createBatcher(
  windowMs: number,
  onBatch: (chatId: string, messages: ChatMessage[]) => void | Promise<void>,
): (msg: ChatMessage) => void {
  const pending = new Map<string, { messages: ChatMessage[]; timer: ReturnType<typeof setTimeout> | undefined }>()

  return (msg) => {
    let entry = pending.get(msg.chatId)
    if (entry) {
      clearTimeout(entry.timer)
      entry.messages.push(msg)
    } else {
      entry = { messages: [msg], timer: undefined }
      pending.set(msg.chatId, entry)
    }

    entry.timer = setTimeout(() => {
      pending.delete(msg.chatId)
      onBatch(msg.chatId, entry.messages)
    }, windowMs)
  }
}

const memory = new Memory(config)
const sdk = new IMessageSDK({ watcher: { pollInterval: 2000, excludeOwnMessages: true } })
const log = (msg: string) => console.log(`[phila ${new Date().toISOString().slice(11, 19)}] ${msg}`)

const feed = createBatcher(config.batchWindowMs, async (chatId, newMessages) => {
  try {
    const recent = memory.getRecentMessages(chatId, config.memoryWindowSize)
    const profile = memory.getGroupProfile(chatId)

    const feedback = detectFeedback(newMessages)
    if (feedback) {
      memory.applyFeedback(chatId, feedback)
      log(`feedback: ${feedback.type} in ${chatId.slice(0, 8)}`)
    }

    const lastTs = newMessages[newMessages.length - 1].timestamp
    const ctx: ConversationContext = {
      correctionHint: detectCorrection(recent),
      messagesPerMinute: computeMomentum(recent),
      latestMessageHour: extractHour(lastTs),
      groupNotes: memory.getGroupNotes(chatId) || null,
    }

    const decision = config.gateMode === 'hierarchical'
      ? await evaluateHierarchical(newMessages, profile, config, ctx, recent)
      : await evaluate(recent, profile, config, ctx)

    const stageTrace = 'stages' in decision ? ` [${(decision as { stages: string[] }).stages.join(' -> ')}]` : ''

    if (decision.action === GateAction.SPEAK) {
      const response = constrain(decision.response)
      log(`speak (${decision.reason}) in ${chatId.slice(0, 8)}${stageTrace}: ${response}`)
      await sdk.send(chatId, response)
      memory.storeMessage({ chatId, sender: 'phila', text: response, timestamp: Date.now() })
    } else {
      log(`silent in ${chatId.slice(0, 8)} (${newMessages.length} msgs)${stageTrace}`)
    }
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`)
  }
})

log(`starting... (gate: ${config.gateMode})`)

await sdk.startWatching({
  onGroupMessage: (msg) => {
    const internal = toInternal(msg)
    if (!internal) return
    memory.storeMessage(internal)
    feed(internal)
  },
  onError: (err) => log(`watcher error: ${err.message}`),
})

log('watching group chats')

closeWithGrace({ delay: 3000 }, async () => {
  log('shutting down...')
  sdk.stopWatching()
  memory.close()
  log('goodbye')
})
