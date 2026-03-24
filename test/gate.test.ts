import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { parseDecision, buildSystemPrompt } from '../src/gate.ts'
import { GateAction } from '../src/types.ts'
import type { GroupProfile } from '../src/types.ts'

const baseProfile: GroupProfile = {
  chatId: 'test-chat',
  speakBias: 0.0,
  updatedAt: Date.now(),
}

describe('gate', () => {
  describe('parseDecision', () => {
    it('parses SILENT response', () => {
      const result = parseDecision('{"action":"silent"}')
      assert.equal(result.action, GateAction.SILENT)
    })

    it('parses SPEAK response with reason and response', () => {
      const json = '{"action":"speak","reason":"factual error","response":"actually that was in 1969"}'
      const result = parseDecision(json)
      assert.equal(result.action, GateAction.SPEAK)
      if (result.action === GateAction.SPEAK) {
        assert.equal(result.reason, 'factual error')
        assert.equal(result.response, 'actually that was in 1969')
      }
    })

    it('strips markdown code fences', () => {
      const wrapped = '```json\n{"action":"silent"}\n```'
      const result = parseDecision(wrapped)
      assert.equal(result.action, GateAction.SILENT)
    })

    it('defaults to SILENT on malformed JSON', () => {
      const result = parseDecision('this is not json at all')
      assert.equal(result.action, GateAction.SILENT)
    })

    it('defaults to SILENT on empty string', () => {
      const result = parseDecision('')
      assert.equal(result.action, GateAction.SILENT)
    })

    it('defaults to SILENT when SPEAK is missing required fields', () => {
      const result = parseDecision('{"action":"speak"}')
      assert.equal(result.action, GateAction.SILENT)
    })
  })

  describe('buildSystemPrompt', () => {
    it('default profile has no bias line', () => {
      const prompt = buildSystemPrompt(baseProfile)
      assert.ok(!prompt.includes('extra quiet'))
      assert.ok(!prompt.includes('appreciates'))
    })

    it('negative bias tells model to stay extra quiet', () => {
      const quieter = { ...baseProfile, speakBias: -0.15 }
      const prompt = buildSystemPrompt(quieter)
      assert.ok(prompt.includes('extra quiet'))
    })

    it('positive bias tells model group appreciates input', () => {
      const friendly = { ...baseProfile, speakBias: 0.08 }
      const prompt = buildSystemPrompt(friendly)
      assert.ok(prompt.includes('appreciates'))
    })

    it('includes core instructions', () => {
      const prompt = buildSystemPrompt(baseProfile)
      assert.ok(prompt.includes('ALWAYS SPEAK'))
      assert.ok(prompt.includes('STAY SILENT'))
      assert.ok(prompt.includes('json'))
    })
  })
})
