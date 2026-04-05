// Transform ishiki-labs/multi-party-dialogue AMI data to phila training JSONL.
// Maps their SPEAK/SILENT labels to phila's gate format with buildSystemPrompt().
//
// Usage: node --experimental-strip-types research/v3-finetune/gen-gate-corpus.ts --out data/v3-finetune/gate-corpus.jsonl

import { writeFileSync, appendFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { buildSystemPrompt } from '../../src/gate.ts'
import type { GroupProfile } from '../../src/types.ts'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'data/v3-finetune/gate-corpus.jsonl' },
    limit: { type: 'string', default: '15000' },
  },
})

const LIMIT = parseInt(args.limit!)
const profile: GroupProfile = { chatId: 'train', speakBias: 0.0, updatedAt: Date.now() }
const systemPrompt = buildSystemPrompt(profile)

interface ContextTurn { speaker: string; text: string }
interface Row {
  context_turns: ContextTurn[]
  current_turn: { speaker: string; text: string }
  decision: string
  target_speaker: string
  all_speakers: string[]
  category: string
  reason: string
  num_context_turns: number
}

function speakerLabel(speaker: string, speakers: string[]): string {
  const idx = speakers.indexOf(speaker)
  return idx >= 0 ? `person${idx + 1}` : speaker.toLowerCase()
}

function buildConversation(row: Row): string {
  const speakers = row.all_speakers
  const lines: string[] = []

  for (const turn of row.context_turns) {
    const label = turn.speaker === row.target_speaker ? 'you' : speakerLabel(turn.speaker, speakers)
    lines.push(`${label}: ${turn.text.trim()}`)
  }

  const currentLabel = row.current_turn.speaker === row.target_speaker
    ? 'you'
    : speakerLabel(row.current_turn.speaker, speakers)
  lines.push(`${currentLabel}: ${row.current_turn.text.trim()}`)

  return lines.join('\n')
}

function buildAssistantResponse(row: Row): string {
  if (row.decision === 'SPEAK') {
    return JSON.stringify({ action: 'speak', reason: row.reason || 'relevant context', response: '(training placeholder)' })
  }
  return JSON.stringify({ action: 'silent' })
}

async function main() {
  // Dynamic import for datasets streaming
  const response = await fetch('https://huggingface.co/api/datasets/ishiki-labs/multi-party-dialogue')
  if (!response.ok) throw new Error(`HF API: ${response.status}`)

  console.log('Streaming ishiki-labs/multi-party-dialogue...')

  // Use HF API to stream JSONL directly
  const dataUrl = 'https://huggingface.co/datasets/ishiki-labs/multi-party-dialogue/resolve/main/data/train-00000-of-00001.jsonl'
  const dataRes = await fetch(dataUrl)
  if (!dataRes.ok) {
    // Try parquet
    console.log('JSONL not found, trying parquet URL patterns...')
    throw new Error('Need to find correct data URL - check HF file listing')
  }

  const text = await dataRes.text()
  const lines = text.trim().split('\n')
  console.log(`Downloaded ${lines.length} rows`)

  // Clear output
  writeFileSync(args.out!, '')

  let written = 0
  let skipped = 0

  for (const line of lines) {
    if (written >= LIMIT) break

    try {
      const row = JSON.parse(line) as Row

      // Filter: need at least 3 context turns, skip filler turns
      if (row.num_context_turns < 3) { skipped++; continue }

      const conversation = buildConversation(row)
      const assistant = buildAssistantResponse(row)

      const example = {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: conversation },
          { role: 'assistant', content: assistant },
        ],
      }

      appendFileSync(args.out!, JSON.stringify(example) + '\n')
      written++
    } catch {
      skipped++
    }
  }

  console.log(`Written: ${written}, Skipped: ${skipped}`)
  console.log(`Output: ${args.out}`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
