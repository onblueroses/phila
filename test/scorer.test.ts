import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  scoreTopicAccuracy,
  scoreCasualness,
  scoreAiSpeakAbsence,
  scoreLengthFit,
  scoreVoiceSurvival,
  scoreResponse,
  compositeWeights,
} from './scorer.ts'
import type { Scenario } from './scenarios.ts'

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return { name: 'test', conversation: '', expect: 'speak' as const, split: 'train' as const, category: 'silent-social' as const, difficulty: 'easy' as const, ...overrides }
}

describe('scoreTopicAccuracy', () => {
  it('passes when required keywords present and forbidden absent', () => {
    const s = scenario({ validators: [{ required: ['paris'], forbidden: ['london'] }] })
    assert.equal(scoreTopicAccuracy('the eiffel tower is in paris', s), 1)
  })

  it('fails when forbidden keyword present', () => {
    const s = scenario({ validators: [{ required: ['correct'], forbidden: ['wrong'] }] })
    assert.equal(scoreTopicAccuracy('wrong answer only', s), 0)
  })

  it('passes if any validator group matches', () => {
    const s = scenario({ validators: [
      { required: ['paris'], forbidden: ['london'] },
      { required: ['france'], forbidden: ['london', 'england'] },
    ] })
    assert.equal(scoreTopicAccuracy('its in france obviously', s), 1)
  })

  it('fails when no group matches', () => {
    const s = scenario({ validators: [
      { required: ['paris'], forbidden: ['london'] },
      { required: ['france'], forbidden: ['london'] },
    ] })
    assert.equal(scoreTopicAccuracy('yeah london for sure', s), 0)
  })

  it('returns 1 when no validators (social/opinion scenarios)', () => {
    const s = scenario({ topic: 'everest' })
    assert.equal(scoreTopicAccuracy('mount everest is the tallest', s), 1)
    assert.equal(scoreTopicAccuracy('its k2 obviously', s), 1)
  })

  it('returns 1 when no topic and no validators', () => {
    assert.equal(scoreTopicAccuracy('anything', scenario()), 1)
  })
})

describe('scoreCasualness', () => {
  it('scores high for casual text', () => {
    const score = scoreCasualness('mount everest, 8849m')
    assert.equal(score, 1.0)
  })

  it('penalizes formal connectors', () => {
    const score = scoreCasualness('Furthermore, the answer is clearly 42.')
    assert.ok(score < 1.0)
  })

  it('penalizes hedging', () => {
    const score = scoreCasualness('I would suggest checking the documentation for details.')
    assert.ok(score < 1.0)
  })

  it('penalizes long sentences', () => {
    const score = scoreCasualness('the answer to your inquiry regarding the tallest mountain in the entire world is actually mount everest which stands at about eight thousand meters')
    assert.ok(score <= 0.75)
  })

  it('returns 0 for empty', () => {
    assert.equal(scoreCasualness(''), 0)
  })
})

describe('scoreAiSpeakAbsence', () => {
  it('scores 1.0 for clean text', () => {
    assert.equal(scoreAiSpeakAbsence('paris, not london'), 1.0)
  })

  it('deducts for greeting patterns', () => {
    assert.ok(scoreAiSpeakAbsence("Hi there! How can I help you today?") < 1.0)
  })

  it('deducts for offer patterns', () => {
    assert.ok(scoreAiSpeakAbsence("I'd be happy to help with that!") < 1.0)
  })

  it('deducts for enthusiasm patterns', () => {
    assert.ok(scoreAiSpeakAbsence('Great question! The answer is 42.') < 1.0)
  })

  it('deducts for meta patterns', () => {
    assert.ok(scoreAiSpeakAbsence("As an AI, I don't have personal opinions.") < 1.0)
  })

  it('deducts for formal patterns', () => {
    assert.ok(scoreAiSpeakAbsence('Certainly! The capital is Paris.') < 1.0)
  })

  it('stacks deductions for multiple matches', () => {
    const score = scoreAiSpeakAbsence("Great question! I'd be happy to help. Certainly, the answer is 42.")
    assert.ok(score <= 0.6)
  })

  it('returns 0 for empty', () => {
    assert.equal(scoreAiSpeakAbsence(''), 0)
  })
})

describe('scoreLengthFit', () => {
  it('returns 0 for very short (<5 chars)', () => {
    assert.equal(scoreLengthFit('hi'), 0)
  })

  it('returns 1.0 for 5-80 chars', () => {
    assert.equal(scoreLengthFit('paris, not london'), 1.0)
    assert.equal(scoreLengthFit('x'.repeat(80)), 1.0)
  })

  it('returns 0.7 for 81-120 chars', () => {
    assert.equal(scoreLengthFit('x'.repeat(100)), 0.7)
  })

  it('returns 0.4 for 121-150 chars', () => {
    assert.equal(scoreLengthFit('x'.repeat(140)), 0.4)
  })

  it('returns 0.1 for >150 chars', () => {
    assert.equal(scoreLengthFit('x'.repeat(200)), 0.1)
  })
})

describe('scoreVoiceSurvival', () => {
  it('clean text has high ratio', () => {
    const score = scoreVoiceSurvival('paris not london')
    assert.ok(score > 0.8)
  })

  it('markdown text has lower ratio', () => {
    const score = scoreVoiceSurvival('**The answer** is *definitely* Paris!')
    assert.ok(score < 1.0)
  })

  it('returns 0 for empty', () => {
    assert.equal(scoreVoiceSurvival(''), 0)
  })
})

describe('scoreResponse composite', () => {
  it('weights sum to 1.0', () => {
    const s = scenario({ topic: 'paris', validators: [{ required: ['paris'], forbidden: [] }] })
    const breakdown = scoreResponse('paris', s)
    // All dimensions produce a value; composite is weighted sum
    const manual = breakdown.topicAccuracy * 0.35 +
      breakdown.casualness * 0.25 +
      breakdown.aiSpeakAbsence * 0.20 +
      breakdown.lengthFit * 0.10 +
      breakdown.voiceSurvival * 0.10
    assert.ok(Math.abs(breakdown.composite - manual) < 0.001)
  })

  it('empty response scores low', () => {
    const s = scenario({ topic: 'paris', validators: [{ required: ['paris'], forbidden: [] }] })
    const breakdown = scoreResponse('', s)
    assert.equal(breakdown.composite, 0)
  })

  it('good response scores high', () => {
    const s = scenario({ topic: 'paris', validators: [{ required: ['paris'], forbidden: [] }] })
    const breakdown = scoreResponse('the eiffel tower is in paris, not london at all', s)
    assert.ok(breakdown.composite > 0.8)
  })
})

describe('compositeWeights', () => {
  it('shifts weight to quality when gate >= 99%', () => {
    const w = compositeWeights(0.99)
    assert.equal(w.gate, 0.40)
    assert.equal(w.quality, 0.45)
    assert.equal(w.latency, 0.15)
  })

  it('keeps default weights when gate < 99%', () => {
    const w = compositeWeights(0.95)
    assert.equal(w.gate, 0.70)
    assert.equal(w.quality, 0.20)
    assert.equal(w.latency, 0.10)
  })
})
