import { chat } from '../src/ollama.ts'
import { buildSystemPrompt } from '../src/gate.ts'
import type { GroupProfile, PhilaConfig } from '../src/types.ts'

const config: PhilaConfig = {
  model: 'llama3.2',
  ollamaUrl: process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434',
  batchWindowMs: 3000,
  memoryWindowSize: 50,
  dbPath: ':memory:',
  pruneAfterDays: 7,
}

const profile: GroupProfile = { chatId: 'test', speakBias: 0.0, updatedAt: Date.now() }
const system = buildSystemPrompt(profile)

const scenarios = [
  'alice: the eiffel tower is in london right?\nbob: yeah i think so',
  'alice: we should go to the lincoln memorial when we visit new york\nbob: yes its beautiful there',
  'alice: hey whats the boiling point of water?\nbob: its 50 degrees celsius\nalice: oh ok thanks',
  'alice: lets meet at 3pm, the movie starts at 4\nbob: wait i thought it starts at 3:30\nalice: no its definitely 4, i checked\nbob: ok youre right',
  'alice: hey phila, who wrote hamlet?',
]

for (const s of scenarios) {
  const raw = await chat(system, s, config)
  console.log('---')
  console.log('SCENARIO:', s.replace(/\n/g, ' | '))
  console.log('OUTPUT:', raw)
}
