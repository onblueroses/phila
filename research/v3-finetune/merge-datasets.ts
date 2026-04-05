// Merge all v3 fine-tuning data sources into train.jsonl + holdout.jsonl.
// Applies: format validation, deduplication, stratified 80/20 split.
//
// Usage: node --experimental-strip-types research/v3-finetune/merge-datasets.ts
//
// Expects data files in data/v3-finetune/:
//   gate-friends.jsonl    (Friends corpus, casual)
//   gate-ami.jsonl        (AMI meetings, formal)
//   gate-synthetic.jsonl  (Haiku-generated, casual)
//   memory-extract.jsonl  (extraction training)
//   memory-recall.jsonl   (Pass 2 recall training)
//   adversarial-opus.jsonl (Opus edge cases)

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: 'data/v3-finetune' },
    'train-ratio': { type: 'string', default: '0.8' },
  },
})

const DIR = args.dir!
const TRAIN_RATIO = parseFloat(args['train-ratio']!)

interface Message { role: string; content: string }
interface Example { messages: Message[] }

const SOURCES = [
  { file: 'gate-friends.jsonl', category: 'gate-friends' },
  { file: 'gate-ami.jsonl', category: 'gate-ami' },
  { file: 'gate-synthetic.jsonl', category: 'gate-synthetic' },
  { file: 'memory-extract.jsonl', category: 'memory-extract' },
  { file: 'memory-recall.jsonl', category: 'memory-recall' },
  { file: 'adversarial-opus.jsonl', category: 'adversarial' },
]

function loadAndValidate(filepath: string, category: string): { examples: Example[]; invalid: number } {
  if (!existsSync(filepath)) {
    console.log(`  SKIP: ${filepath} (not found)`)
    return { examples: [], invalid: 0 }
  }

  const lines = readFileSync(filepath, 'utf-8').trim().split('\n').filter(Boolean)
  const examples: Example[] = []
  let invalid = 0

  for (const line of lines) {
    try {
      const ex = JSON.parse(line) as Example
      // Validate: must have messages array with system, user, assistant
      if (!ex.messages || ex.messages.length < 3) { invalid++; continue }
      if (ex.messages[0].role !== 'system') { invalid++; continue }
      if (ex.messages[1].role !== 'user') { invalid++; continue }
      if (ex.messages[2].role !== 'assistant') { invalid++; continue }
      // Validate assistant is valid JSON
      try { JSON.parse(ex.messages[2].content) } catch { invalid++; continue }
      examples.push(ex)
    } catch {
      invalid++
    }
  }

  console.log(`  ${category}: ${examples.length} valid, ${invalid} invalid (${filepath})`)
  return { examples, invalid }
}

// Simple hash for dedup (conversation text)
function exampleHash(ex: Example): string {
  return ex.messages[1].content.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200)
}

function main() {
  console.log('=== Merging v3 fine-tuning datasets ===\n')

  // Load all sources
  const allExamples: { example: Example; category: string }[] = []
  let totalInvalid = 0

  for (const source of SOURCES) {
    const filepath = `${DIR}/${source.file}`
    const { examples, invalid } = loadAndValidate(filepath, source.category)
    for (const ex of examples) {
      allExamples.push({ example: ex, category: source.category })
    }
    totalInvalid += invalid
  }

  console.log(`\nTotal loaded: ${allExamples.length} valid, ${totalInvalid} invalid`)

  // Exact-match dedup on conversation text
  const seen = new Set<string>()
  const deduped: typeof allExamples = []
  let dupes = 0

  for (const item of allExamples) {
    const hash = exampleHash(item.example)
    if (seen.has(hash)) {
      dupes++
      continue
    }
    seen.add(hash)
    deduped.push(item)
  }

  console.log(`Dedup: removed ${dupes} exact duplicates (${deduped.length} remaining)`)

  // Shuffle
  for (let i = deduped.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = deduped[i]!
    deduped[i] = deduped[j]!
    deduped[j] = tmp
  }

  // Stratified split by category
  const byCategory = new Map<string, typeof allExamples>()
  for (const item of deduped) {
    const cat = byCategory.get(item.category) ?? []
    cat.push(item)
    byCategory.set(item.category, cat)
  }

  const train: Example[] = []
  const holdout: Example[] = []

  for (const [cat, items] of byCategory) {
    const splitIdx = Math.floor(items.length * TRAIN_RATIO)
    for (let i = 0; i < items.length; i++) {
      if (i < splitIdx) train.push(items[i]!.example)
      else holdout.push(items[i]!.example)
    }
    console.log(`  ${cat}: ${splitIdx} train, ${items.length - splitIdx} holdout`)
  }

  // Shuffle train and holdout
  for (let i = train.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = train[i]!; train[i] = train[j]!; train[j] = tmp
  }
  for (let i = holdout.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = holdout[i]!; holdout[i] = holdout[j]!; holdout[j] = tmp
  }

  // Write
  const trainPath = `${DIR}/train-v3.jsonl`
  const holdoutPath = `${DIR}/holdout-v3.jsonl`

  writeFileSync(trainPath, train.map(e => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(holdoutPath, holdout.map(e => JSON.stringify(e)).join('\n') + '\n')

  console.log(`\n=== Output ===`)
  console.log(`Train: ${train.length} examples -> ${trainPath}`)
  console.log(`Holdout: ${holdout.length} examples -> ${holdoutPath}`)
  console.log(`Total: ${train.length + holdout.length}`)
}

main()
