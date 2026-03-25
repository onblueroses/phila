import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { constrain } from '../src/voice.ts'

describe('voice', () => {
  it('lowercases everything', () => {
    assert.equal(constrain('Hello World'), 'hello world')
  })

  it('strips trailing periods', () => {
    assert.equal(constrain('here is my answer.'), 'here is my answer')
  })

  it('keeps trailing question marks', () => {
    assert.equal(constrain('are you sure?'), 'are you sure?')
  })

  it('keeps trailing exclamation marks', () => {
    assert.equal(constrain('no way!'), 'no way!')
  })

  it('caps at 2 sentences', () => {
    const long = 'First sentence. Second sentence. Third sentence. Fourth sentence.'
    const result = constrain(long)
    // Should only have 2 sentences
    const sentences = result.split(/(?<=[.!?])\s+/).filter(Boolean)
    assert.ok(sentences.length <= 2, `expected <= 2 sentences, got ${sentences.length}: "${result}"`)
  })

  it('flattens bullet points', () => {
    const bulleted = '- item one\n- item two\n- item three'
    const result = constrain(bulleted)
    assert.ok(!result.includes('-'))
    assert.ok(!result.includes('\n'))
  })

  it('flattens numbered lists', () => {
    const numbered = '1. first thing\n2. second thing'
    const result = constrain(numbered)
    assert.ok(!result.includes('1.'))
    assert.ok(!result.includes('2.'))
  })

  it('strips wrapping quotes', () => {
    assert.equal(constrain('"hello there"'), 'hello there')
    assert.equal(constrain("'hello there'"), 'hello there')
  })

  it('collapses whitespace', () => {
    assert.equal(constrain('too   much   space'), 'too much space')
  })

  it('handles empty string', () => {
    assert.equal(constrain(''), '')
  })

  it('strips AI-speak phrases', () => {
    assert.equal(constrain('Great question! The answer is 42'), 'the answer is 42')
    assert.equal(constrain("I'd be happy to help. The capital is paris"), 'the capital is paris')
    assert.equal(constrain('Absolutely! It was built in 1889'), 'it was built in 1889')
  })
})
