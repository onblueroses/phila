// Debug script to see raw model output for specific scenarios
import { chat } from '../src/ollama.ts'
import { buildSystemPrompt } from '../src/gate.ts'
import type { GroupProfile, PhilaConfig } from '../src/types.ts'

const config: PhilaConfig = {
  model: 'llama3.2',
  ollamaUrl: process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434',
  batchWindowMs: 3000,
  memoryWindowSize: 50,
  dbPath: ':memory:',
}

const profile: GroupProfile = { chatId: 'test', speakBias: 0.0, updatedAt: Date.now() }
const system = buildSystemPrompt(profile)

console.log('system prompt:\n' + system)
console.log('\n===\n')

const cases = [
  'alice: phila what year did the moon landing happen?',
  'alice: the eiffel tower is in london right?\nbob: yeah i think so',
  'alice: hey whats up\nbob: not much, you?',
]

for (const c of cases) {
  const raw = await chat([{ role: 'system', content: system }, { role: 'user', content: c }], config)
  console.log('INPUT:', c.replace(/\n/g, ' | '))
  console.log('RAW:', JSON.stringify(raw))
  console.log()
}
