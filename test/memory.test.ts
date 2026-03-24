import { describe, it, beforeEach, afterEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { Memory } from '../src/memory.ts'
import type { PhilaConfig, ChatMessage } from '../src/types.ts'
import { FeedbackType } from '../src/types.ts'

const testConfig: PhilaConfig = {
  model: 'test',
  ollamaUrl: 'http://localhost:11434',
  batchWindowMs: 3000,
  memoryWindowSize: 50,
  dbPath: ':memory:',
}

describe('Memory', () => {
  let mem: Memory

  beforeEach(() => {
    mem = new Memory(testConfig)
  })

  afterEach(() => {
    mem.close()
  })

  it('stores and retrieves messages in chronological order', () => {
    const msgs: ChatMessage[] = [
      { chatId: 'chat1', sender: 'alice', text: 'hello', timestamp: 1000 },
      { chatId: 'chat1', sender: 'bob', text: 'hey', timestamp: 2000 },
      { chatId: 'chat1', sender: 'alice', text: 'whats up', timestamp: 3000 },
    ]
    for (const m of msgs) mem.storeMessage(m)

    const recent = mem.getRecentMessages('chat1', 10)
    assert.equal(recent.length, 3)
    assert.equal(recent[0].text, 'hello')
    assert.equal(recent[2].text, 'whats up')
  })

  it('respects limit on getRecentMessages', () => {
    for (let i = 0; i < 10; i++) {
      mem.storeMessage({ chatId: 'chat1', sender: 'alice', text: `msg ${i}`, timestamp: i * 1000 })
    }

    const recent = mem.getRecentMessages('chat1', 3)
    assert.equal(recent.length, 3)
    // Should be the 3 most recent, in chronological order
    assert.equal(recent[0].text, 'msg 7')
    assert.equal(recent[2].text, 'msg 9')
  })

  it('isolates messages by chatId', () => {
    mem.storeMessage({ chatId: 'chat1', sender: 'alice', text: 'in chat1', timestamp: 1000 })
    mem.storeMessage({ chatId: 'chat2', sender: 'bob', text: 'in chat2', timestamp: 2000 })

    assert.equal(mem.getRecentMessages('chat1', 10).length, 1)
    assert.equal(mem.getRecentMessages('chat2', 10).length, 1)
  })

  it('returns default group profile for unknown chatId', () => {
    const profile = mem.getGroupProfile('unknown')
    assert.equal(profile.chatId, 'unknown')
    assert.equal(profile.speakBias, 0.0)
  })

  it('updates and persists group profile', () => {
    mem.updateGroupProfile('chat1', { speakBias: -0.1 })
    const profile = mem.getGroupProfile('chat1')
    assert.equal(profile.speakBias, -0.1)

    // Update again - should upsert
    mem.updateGroupProfile('chat1', { speakBias: -0.15 })
    const updated = mem.getGroupProfile('chat1')
    assert.equal(updated.speakBias, -0.15)
  })

  it('stores feedback records', () => {
    mem.storeFeedback('chat1', {
      type: FeedbackType.NEGATIVE,
      context: 'told to shut up',
      timestamp: Date.now(),
    })
  })

  describe('social learning', () => {
    it('detects positive feedback mentioning phila', () => {
      const msgs: ChatMessage[] = [
        { chatId: 'c', sender: 'alice', text: 'thanks phila', timestamp: 1000 },
      ]
      const signal = mem.detectFeedback(msgs)
      assert.ok(signal)
      assert.equal(signal.type, FeedbackType.POSITIVE)
    })

    it('detects negative feedback mentioning phila', () => {
      const msgs: ChatMessage[] = [
        { chatId: 'c', sender: 'bob', text: 'shut up phila', timestamp: 1000 },
      ]
      const signal = mem.detectFeedback(msgs)
      assert.ok(signal)
      assert.equal(signal.type, FeedbackType.NEGATIVE)
    })

    it('ignores feedback that does not mention phila', () => {
      // "lol" or "stop" in unrelated conversation should not trigger
      const msgs: ChatMessage[] = [
        { chatId: 'c', sender: 'alice', text: 'lol thats hilarious', timestamp: 1000 },
        { chatId: 'c', sender: 'bob', text: 'stop youre killing me', timestamp: 2000 },
      ]
      assert.equal(mem.detectFeedback(msgs), null)
    })

    it('returns null when no feedback present', () => {
      const msgs: ChatMessage[] = [
        { chatId: 'c', sender: 'alice', text: 'anyone want tacos?', timestamp: 1000 },
      ]
      assert.equal(mem.detectFeedback(msgs), null)
    })

    it('applies positive feedback (+0.02)', () => {
      mem.applyFeedback('chat1', { type: FeedbackType.POSITIVE, context: 'thanks', timestamp: 1000 })
      const profile = mem.getGroupProfile('chat1')
      assert.equal(profile.speakBias, 0.02)
    })

    it('applies negative feedback (-0.05) - asymmetric', () => {
      mem.applyFeedback('chat1', { type: FeedbackType.NEGATIVE, context: 'shut up', timestamp: 1000 })
      const profile = mem.getGroupProfile('chat1')
      assert.equal(profile.speakBias, -0.05)
    })

    it('clamps bias at lower bound (-0.3)', () => {
      // Drive bias down past the clamp
      for (let i = 0; i < 10; i++) {
        mem.applyFeedback('chat1', { type: FeedbackType.NEGATIVE, context: 'stop', timestamp: i })
      }
      const profile = mem.getGroupProfile('chat1')
      assert.equal(profile.speakBias, -0.3)
    })

    it('clamps bias at upper bound (0.1)', () => {
      for (let i = 0; i < 10; i++) {
        mem.applyFeedback('chat1', { type: FeedbackType.POSITIVE, context: 'good', timestamp: i })
      }
      const profile = mem.getGroupProfile('chat1')
      assert.equal(profile.speakBias, 0.1)
    })

    it('recovers from negative with positive feedback', () => {
      mem.applyFeedback('chat1', { type: FeedbackType.NEGATIVE, context: 'stop', timestamp: 1 })
      assert.equal(mem.getGroupProfile('chat1').speakBias, -0.05)

      mem.applyFeedback('chat1', { type: FeedbackType.POSITIVE, context: 'thanks', timestamp: 2 })
      // -0.05 + 0.02 = -0.03
      const bias = mem.getGroupProfile('chat1').speakBias
      assert.ok(Math.abs(bias - -0.03) < 0.001, `expected -0.03, got ${bias}`)
    })
  })
})
