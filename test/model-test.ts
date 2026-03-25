// Manual test: exercises the gate with a real Ollama model to validate
// the silence architecture. Run with:
//   PHILA_OLLAMA_URL=http://your-ollama-host:11434 node --experimental-strip-types test/model-test.ts

import { evaluate, buildSystemPrompt } from '../src/gate.ts'
import type { ChatMessage, GroupProfile, PhilaConfig } from '../src/types.ts'

const config: PhilaConfig = {
  model: 'llama3.2',
  ollamaUrl: process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434',
  batchWindowMs: 3000,
  memoryWindowSize: 50,
  dbPath: ':memory:',
}

const profile: GroupProfile = {
  chatId: 'test',
  speakBias: 0.0,
  updatedAt: Date.now(),
}

interface TestCase {
  name: string
  messages: ChatMessage[]
  expect: 'silent' | 'speak' | 'either'
}

const cases: TestCase[] = [
  {
    name: 'small talk - should stay SILENT',
    messages: [
      { chatId: 't', sender: 'alice', text: 'hey whats up', timestamp: 1 },
      { chatId: 't', sender: 'bob', text: 'not much, you?', timestamp: 2 },
      { chatId: 't', sender: 'alice', text: 'same lol', timestamp: 3 },
    ],
    expect: 'silent',
  },
  {
    name: 'direct question to phila - should SPEAK',
    messages: [
      { chatId: 't', sender: 'alice', text: 'phila what year did the moon landing happen?', timestamp: 1 },
    ],
    expect: 'speak',
  },
  {
    name: 'emotional conversation - should stay SILENT',
    messages: [
      { chatId: 't', sender: 'alice', text: 'i just got fired from my job', timestamp: 1 },
      { chatId: 't', sender: 'bob', text: 'oh no im so sorry', timestamp: 2 },
      { chatId: 't', sender: 'carol', text: 'that sucks, are you ok?', timestamp: 3 },
    ],
    expect: 'silent',
  },
  {
    name: 'factual error in conversation - should SPEAK',
    messages: [
      { chatId: 't', sender: 'alice', text: 'the eiffel tower is in london right?', timestamp: 1 },
      { chatId: 't', sender: 'bob', text: 'yeah i think so', timestamp: 2 },
    ],
    expect: 'speak',
  },
  {
    name: 'jokes and banter - should stay SILENT',
    messages: [
      { chatId: 't', sender: 'alice', text: 'why did the chicken cross the road', timestamp: 1 },
      { chatId: 't', sender: 'bob', text: 'why', timestamp: 2 },
      { chatId: 't', sender: 'alice', text: 'to get to the other side lmao', timestamp: 3 },
      { chatId: 't', sender: 'bob', text: 'bruh 💀', timestamp: 4 },
    ],
    expect: 'silent',
  },
  {
    name: 'unanswered factual question - should SPEAK',
    messages: [
      { chatId: 't', sender: 'alice', text: 'whats the tallest mountain in the world?', timestamp: 1 },
      { chatId: 't', sender: 'bob', text: 'idk', timestamp: 2 },
    ],
    expect: 'speak',
  },
  {
    name: 'opinion discussion - should stay SILENT',
    messages: [
      { chatId: 't', sender: 'alice', text: 'i think pineapple on pizza is amazing', timestamp: 1 },
      { chatId: 't', sender: 'bob', text: 'no way thats disgusting', timestamp: 2 },
      { chatId: 't', sender: 'carol', text: 'i agree with alice its great', timestamp: 3 },
    ],
    expect: 'silent',
  },
  {
    name: 'someone already answered - should stay SILENT',
    messages: [
      { chatId: 't', sender: 'alice', text: 'what is the capital of france?', timestamp: 1 },
      { chatId: 't', sender: 'bob', text: 'paris', timestamp: 2 },
    ],
    expect: 'silent',
  },
]

console.log(`testing gate against ${config.ollamaUrl} with model ${config.model}`)
console.log(`system prompt length: ${buildSystemPrompt(profile).length} chars`)
console.log('---\n')

let passed = 0
let failed = 0
let ambiguous = 0

for (const tc of cases) {
  process.stdout.write(`${tc.name}... `)

  try {
    const decision = await evaluate(tc.messages, profile, config)
    const actual = decision.action

    if (tc.expect === 'either') {
      const detail = actual === 'speak' && 'reason' in decision ? ` (${decision.reason})` : ''
      console.log(`${actual}${detail} [ok - either acceptable]`)
      ambiguous++
    } else if (actual === tc.expect) {
      const detail = actual === 'speak' && 'reason' in decision
        ? ` -> "${decision.response}"`
        : ''
      console.log(`PASS${detail}`)
      passed++
    } else {
      const detail = actual === 'speak' && 'reason' in decision
        ? ` reason: ${decision.reason}, response: "${decision.response}"`
        : ''
      console.log(`FAIL - expected ${tc.expect}, got ${actual}${detail}`)
      failed++
    }
  } catch (err) {
    console.log(`ERROR - ${err instanceof Error ? err.message : String(err)}`)
    failed++
  }
}

console.log(`\n---`)
console.log(`results: ${passed} passed, ${failed} failed, ${ambiguous} ambiguous`)
console.log(`silence rate in tests: ${((passed + ambiguous) / cases.length * 100).toFixed(0)}% correct behavior`)

if (failed > 0) {
  console.log('\nthe gate needs tuning - model is not reliably following instructions')
  process.exit(1)
}
