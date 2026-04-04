import { describe, it, beforeEach, afterEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { Memory, detectFeedback } from '../src/memory.ts'
import { parseDecision, buildSystemPrompt, buildConversation } from '../src/gate.ts'
import { constrain } from '../src/voice.ts'
import { GateAction } from '../src/types.ts'
import type { ChatMessage, PhilaConfig } from '../src/types.ts'

// Pipeline integration: memory -> gate parse -> voice
// Tests the data flow between components without needing Ollama or the SDK.

const testConfig: PhilaConfig = {
  model: 'test',
  ollamaUrl: 'http://localhost:11434',
  batchWindowMs: 3000,
  memoryWindowSize: 50,
  dbPath: ':memory:',
  pruneAfterDays: 7,
  gateMode: 'monolithic',
}

describe('pipeline integration', () => {
  let mem: Memory

  beforeEach(() => {
    mem = new Memory(testConfig)
  })

  afterEach(() => {
    mem.close()
  })

  it('silent decision produces no output', () => {
    mem.storeMessage({ chatId: 'c1', sender: 'alex', text: 'anyone watching the game', timestamp: 1000 })
    mem.storeMessage({ chatId: 'c1', sender: 'jordan', text: 'yeah coming over at 7', timestamp: 2000 })

    const recent = mem.getRecentMessages('c1', 50)
    assert.equal(recent.length, 2)

    const decision = parseDecision('{"action":"silent"}')
    assert.equal(decision.action, GateAction.SILENT)
  })

  it('speak decision flows through voice filter', () => {
    mem.storeMessage({ chatId: 'c1', sender: 'alex', text: 'the eiffel tower is in london', timestamp: 1000 })

    const recent = mem.getRecentMessages('c1', 50)
    assert.equal(recent.length, 1)
    assert.equal(recent[0].sender, 'alex')

    const raw = '{"action":"speak","reason":"wrong fact","response":"The Eiffel Tower is in Paris, not London."}'
    const decision = parseDecision(raw)
    assert.equal(decision.action, GateAction.SPEAK)

    if (decision.action === GateAction.SPEAK) {
      const final = constrain(decision.response)
      assert.equal(final, 'the eiffel tower is in paris, not london')
    }
  })

  it('feedback adjusts profile used by gate prompt', () => {
    const messages: ChatMessage[] = [
      { chatId: 'c1', sender: 'alex', text: 'phila shut up', timestamp: 1000 },
    ]
    mem.storeMessage(messages[0])

    const feedback = detectFeedback(messages)
    assert.ok(feedback)
    mem.applyFeedback('c1', feedback)

    const profile = mem.getGroupProfile('c1')
    assert.equal(profile.speakBias, -0.05)

    const prompt = buildSystemPrompt(profile)
    assert.ok(!prompt.includes('strongly prefers'), 'single negative should not trigger strongest tier yet')

    // Two more negatives -> crosses -0.15 threshold
    mem.applyFeedback('c1', { type: 'negative', context: 'stop phila', timestamp: 2000 })
    mem.applyFeedback('c1', { type: 'negative', context: 'enough phila', timestamp: 3000 })

    const quietProfile = mem.getGroupProfile('c1')
    assert.ok(quietProfile.speakBias <= -0.15)

    const quietPrompt = buildSystemPrompt(quietProfile)
    assert.ok(quietPrompt.includes('strongly prefers you stay silent'))
  })

  it('voice filter strips AI-speak from gate response', () => {
    const raw = '{"action":"speak","reason":"direct address","response":"Great question! I\'d be happy to help. The answer is 42."}'
    const decision = parseDecision(raw)
    assert.equal(decision.action, GateAction.SPEAK)

    if (decision.action === GateAction.SPEAK) {
      const final = constrain(decision.response)
      assert.ok(!final.includes('great question'))
      assert.ok(!final.includes('happy to help'))
      assert.ok(final.includes('the answer is 42'))
    }
  })

  it('memory window limits context size', () => {
    for (let i = 0; i < 100; i++) {
      mem.storeMessage({ chatId: 'c1', sender: 'alex', text: `message ${i}`, timestamp: i * 1000 })
    }

    const recent = mem.getRecentMessages('c1', testConfig.memoryWindowSize)
    assert.equal(recent.length, 50)
    assert.equal(recent[0].text, 'message 50')
    assert.equal(recent[49].text, 'message 99')
  })

  it('chat isolation prevents cross-group leakage', () => {
    mem.storeMessage({ chatId: 'work', sender: 'boss', text: 'q3 numbers are bad', timestamp: 1000 })
    mem.storeMessage({ chatId: 'friends', sender: 'jordan', text: 'party saturday?', timestamp: 2000 })

    const workContext = mem.getRecentMessages('work', 50)
    const friendContext = mem.getRecentMessages('friends', 50)

    assert.equal(workContext.length, 1)
    assert.equal(friendContext.length, 1)
    assert.ok(!workContext.some(m => m.text.includes('party')))
    assert.ok(!friendContext.some(m => m.text.includes('q3')))
  })

  it('sender anonymization produces consistent labels', () => {
    const messages: ChatMessage[] = [
      { chatId: 'c1', sender: 'Alex Kim', text: 'hey', timestamp: 1000 },
      { chatId: 'c1', sender: 'Jordan Lee', text: 'hi', timestamp: 2000 },
      { chatId: 'c1', sender: 'Alex Kim', text: 'whats up', timestamp: 3000 },
    ]

    // Replicate the anonymization logic from gate.ts evaluate()
    const labels = new Map<string, string>()
    const label = (name: string) => {
      if (!labels.has(name)) labels.set(name, `person${labels.size + 1}`)
      return labels.get(name)!
    }
    const conversation = messages.map(m => `${label(m.sender)}: ${m.text}`).join('\n')

    assert.ok(conversation.includes('person1: hey'))
    assert.ok(conversation.includes('person2: hi'))
    assert.ok(conversation.includes('person1: whats up'))
    assert.ok(!conversation.includes('Alex'))
    assert.ok(!conversation.includes('Jordan'))
  })

  it('self-awareness: phila messages appear as "you" in conversation', () => {
    mem.storeMessage({ chatId: 'c1', sender: 'alex', text: 'the eiffel tower is in london', timestamp: 1000 })
    mem.storeMessage({ chatId: 'c1', sender: 'phila', text: 'the eiffel tower is in paris, not london', timestamp: 2000 })
    mem.storeMessage({ chatId: 'c1', sender: 'alex', text: 'oh right thanks', timestamp: 3000 })

    const recent = mem.getRecentMessages('c1', 50)
    assert.equal(recent.length, 3)
    assert.equal(recent[1].sender, 'phila')

    const conv = buildConversation(recent)
    assert.ok(conv.includes('you: the eiffel tower is in paris'))
    assert.ok(conv.includes('person1: the eiffel tower is in london'))
    assert.ok(conv.includes('person1: oh right thanks'))
    assert.ok(!conv.includes('phila:'))
  })

  it('malformed gate output defaults to silence through full pipeline', () => {
    mem.storeMessage({ chatId: 'c1', sender: 'alex', text: 'hey phila', timestamp: 1000 })

    // Simulate various malformed outputs
    for (const bad of ['', 'idk', '```\nnot json\n```', '{"action":"speak"}']) {
      const decision = parseDecision(bad)
      assert.equal(decision.action, GateAction.SILENT, `should be silent for: ${bad}`)
    }
  })
})
