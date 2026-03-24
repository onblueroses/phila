import { IMessageSDK } from '@photon-ai/imessage-kit'
import type { Message } from '@photon-ai/imessage-kit'
import closeWithGrace from 'close-with-grace'
import { config } from './config.ts'
import { evaluate } from './gate.ts'
import { Memory, detectFeedback } from './memory.ts'
import { GateAction } from './types.ts'
import type { ChatMessage } from './types.ts'
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
    const state = pending.get(msg.chatId)
    if (state) {
      clearTimeout(state.timer)
      state.messages.push(msg)
    } else {
      pending.set(msg.chatId, { messages: [msg], timer: undefined })
    }

    const entry = pending.get(msg.chatId)!
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

    const decision = await evaluate(recent, profile, config)

    if (decision.action === GateAction.SPEAK) {
      const response = constrain(decision.response)
      log(`speak (${decision.reason}) in ${chatId.slice(0, 8)}: ${response}`)
      await sdk.send(chatId, response)
    } else {
      log(`silent in ${chatId.slice(0, 8)} (${newMessages.length} msgs)`)
    }
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`)
  }
})

log('starting...')

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
