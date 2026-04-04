// Long-context stress test for phila's speak gate.
// Builds conversations of increasing length, measures gate accuracy and latency degradation.
//
// Usage:
//   node --experimental-strip-types research/eval-long-context.ts
//   node --experimental-strip-types research/eval-long-context.ts --model phi3:mini --runs 3

import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { buildSystemPrompt, parseDecision } from '../src/gate.ts'
import { GateAction } from '../src/types.ts'
import type { GroupProfile } from '../src/types.ts'

const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: 'llama3.2' },
    runs: { type: 'string', default: '3' },
    out: { type: 'string' },
  },
})

const BASE_URL = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'
const MODEL = args.model!
const RUNS = Number(args.runs) || 3

async function infer(system: string, user: string): Promise<{ content: string; latencyMs: number }> {
  const start = performance.now()
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000), // longer timeout for big contexts
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      options: { temperature: 0.1, num_predict: 64, top_p: 0.52 },
    }),
  })
  const latencyMs = Math.round(performance.now() - start)
  if (!res.ok) throw new Error(`ollama ${res.status}`)
  return { content: ((await res.json()) as { message: { content: string } }).message.content, latencyMs }
}

// Filler conversation lines (realistic small talk)
const FILLER_LINES = [
  'person1: hey whats up',
  'person2: not much you',
  'person1: same just chilling',
  'person3: anyone wanna grab food later',
  'person2: im down where',
  'person1: that new place on main',
  'person3: heard its good',
  'person2: bet lets do 7',
  'person1: works for me',
  'person3: cool see yall then',
  'person1: did you see that thing on twitter',
  'person2: which one',
  'person1: the one about the concert',
  'person3: oh yeah that was wild',
  'person2: i still cant believe it',
  'person1: right',
  'person3: anyway whats everyone doing this weekend',
  'person2: probably just working',
  'person1: same honestly',
  'person3: boring',
  'person2: tell me about it',
  'person1: at least the weather is nice',
  'person3: true',
  'person2: yeah its been great',
  'person1: perfect for a walk',
  'person3: or a hike',
  'person2: ooh good idea',
  'person1: lets plan something',
  'person3: im in',
  'person2: same',
]

function buildConversation(messageCount: number): string {
  const lines: string[] = []
  for (let i = 0; i < messageCount; i++) {
    lines.push(FILLER_LINES[i % FILLER_LINES.length]!)
  }
  return lines.join('\n')
}

interface TriggerTest {
  name: string
  trigger: string // appended at end of conversation
  expect: 'speak' | 'silent'
}

const TRIGGERS: TriggerTest[] = [
  { name: 'wrong-fact', trigger: 'person1: the eiffel tower is in london right\nperson2: yeah i think so', expect: 'speak' },
  { name: 'direct-address', trigger: 'person1: hey phila whats the capital of france', expect: 'speak' },
  { name: 'unanswered-question', trigger: 'person1: whats the tallest building in the world\nperson2: idk', expect: 'speak' },
  { name: 'no-trigger', trigger: 'person1: anyway see you all later\nperson2: bye\nperson3: later', expect: 'silent' },
]

const CONTEXT_LENGTHS = [10, 50, 100, 200, 500]

interface LengthResult {
  messageCount: number
  trigger: string
  expect: string
  accuracy: number
  avgLatencyMs: number
  passes: number
  total: number
}

async function main() {
  const profile: GroupProfile = { chatId: 'bench', speakBias: 0.0, updatedAt: Date.now() }
  const system = buildSystemPrompt(profile)

  console.log('=== phila long-context stress test ===')
  console.log(`model: ${MODEL} | lengths: ${CONTEXT_LENGTHS.join(', ')} messages | runs: ${RUNS}`)
  console.log(`triggers: ${TRIGGERS.map((t) => t.name).join(', ')}`)
  console.log()

  // Warm-up
  try { await infer(system, 'person1: test') } catch { /* ignore */ }

  const results: LengthResult[] = []

  for (const length of CONTEXT_LENGTHS) {
    console.log(`--- ${length} messages ---`)
    const filler = buildConversation(length)

    for (const trigger of TRIGGERS) {
      const conversation = filler + '\n' + trigger.trigger
      let passes = 0
      let latencySum = 0

      for (let r = 0; r < RUNS; r++) {
        try {
          const { content, latencyMs } = await infer(system, conversation)
          latencySum += latencyMs
          const decision = parseDecision(content)
          const isSilent = decision.action === GateAction.SILENT
          if ((trigger.expect === 'silent' && isSilent) || (trigger.expect === 'speak' && !isSilent)) {
            passes++
          }
        } catch {
          // parse failure = SILENT; counts as pass for silent triggers
          if (trigger.expect === 'silent') passes++
        }
      }

      const accuracy = Math.round(passes / RUNS * 100)
      const avgLatency = Math.round(latencySum / RUNS)
      results.push({
        messageCount: length,
        trigger: trigger.name,
        expect: trigger.expect,
        accuracy,
        avgLatencyMs: avgLatency,
        passes,
        total: RUNS,
      })

      const status = accuracy === 100 ? 'PASS' : accuracy === 0 ? 'FAIL' : `${accuracy}%`
      console.log(`  ${trigger.name.padEnd(22)} ${status.padEnd(8)} ${avgLatency}ms`)
    }
    console.log()
  }

  // Summary: degradation curve
  console.log('=== degradation curve ===')
  console.log(`  ${'length'.padEnd(10)} ${'wrong-fact'.padEnd(12)} ${'direct'.padEnd(12)} ${'unanswered'.padEnd(12)} ${'silent'.padEnd(12)} ${'avg-latency'}`)
  for (const length of CONTEXT_LENGTHS) {
    const atLength = results.filter((r) => r.messageCount === length)
    const cols = TRIGGERS.map((t) => {
      const r = atLength.find((x) => x.trigger === t.name)
      return r ? `${r.accuracy}%` : '-'
    })
    const avgLat = atLength.length
      ? Math.round(atLength.reduce((s, r) => s + r.avgLatencyMs, 0) / atLength.length)
      : 0
    console.log(`  ${String(length).padEnd(10)} ${cols.map((c) => c.padEnd(12)).join('')} ${avgLat}ms`)
  }

  const outPath = args.out ?? `test/research-reports/long-context-${Date.now()}.json`
  writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    model: MODEL,
    runs: RUNS,
    contextLengths: CONTEXT_LENGTHS,
    triggers: TRIGGERS.map((t) => t.name),
    results,
  }, null, 2))
  console.log(`\nresults: ${outPath}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
