// Test how the model handles different factual error scenarios
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

const scenarios = [
  // Original test case
  'alice: the eiffel tower is in london right?\nbob: yeah i think so',

  // More natural error
  'alice: we should go to the lincoln memorial when we visit new york\nbob: yes its beautiful there',

  // Direct wrong fact with someone relying on it
  'alice: hey whats the boiling point of water?\nbob: its 50 degrees celsius\nalice: oh ok thanks',

  // Planning based on wrong info
  'alice: lets meet at 3pm, the movie starts at 4\nbob: wait i thought it starts at 3:30\nalice: no its definitely 4, i checked\nbob: ok youre right',

  // Consistency test - direct question (should always work)
  'alice: hey phila, who wrote hamlet?',
]

for (const s of scenarios) {
  const raw = await chat([{ role: 'system', content: system }, { role: 'user', content: s }], config)
  console.log('---')
  console.log('SCENARIO:', s.replace(/\n/g, ' | '))
  console.log('OUTPUT:', raw)
}
