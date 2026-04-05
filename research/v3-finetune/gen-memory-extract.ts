// Generate memory extraction training data using Ollama on VPS.
// Teaches the model to extract structured facts from group chat conversations.
// Format: system=EXTRACT_SYSTEM, user=conversation, assistant=JSON array
//
// Usage: node --experimental-strip-types research/v3-finetune/gen-memory-extract.ts --out data/v3-finetune/memory-extract.jsonl --count 3000

import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'data/v3-finetune/memory-extract.jsonl' },
    count: { type: 'string', default: '3000' },
  },
})

const TARGET = parseInt(args.count!)
const OLLAMA_URL = process.env['PHILA_OLLAMA_URL'] ?? 'http://localhost:11434'

// Must match src/memory-extract.ts EXTRACT_SYSTEM exactly
const EXTRACT_SYSTEM = `extract factual information from this group chat snippet.
return a JSON array of objects. each object has:
- "type": one of "logistics", "commitment", "preference", "personal"
- "key": short label (e.g. "meeting_location", "allergy", "dinner_time", "whos_driving")
- "value": the fact itself (e.g. "thai place on main at 7pm", "person1 is allergic to shellfish")

only extract concrete facts. ignore opinions, jokes, emotions, greetings, banter.
if no facts, return [].
respond with ONLY the JSON array, no other text.`

// Scenarios that should produce DIFFERENT extraction outputs
const EXTRACTION_TEMPLATES = [
  // LOGISTICS - plans, times, places
  { type: 'logistics', conversations: [
    'person1: lets do dinner at the sushi place on oak street\nperson2: what time\nperson1: 7:30?\nperson2: perfect',
    'person1: game starts at 3pm at the park\nperson2: which park\nperson1: riverside\nperson3: ill be there',
    'person1: flight lands at terminal C gate 14 at 2:45pm\nperson2: ill pick you up\nperson3: safe travels',
    'person1: meeting moved to conference room B at 10am\nperson2: got it\nperson3: thanks for the heads up',
    'person1: party is saturday the 20th at my apartment\nperson2: bringing wine\nperson3: ill be there at 8',
  ]},
  // COMMITMENTS - who said they'd do what
  { type: 'commitment', conversations: [
    'person1: ill handle the decorations\nperson2: ill get the cake\nperson3: im on music',
    'person1: i can drive tomorrow morning\nperson2: thanks youre the best\nperson3: shotgun',
    'person1: ill send the invites by friday\nperson2: cool\nperson3: make sure to include alex',
    'person1: ill cover your shift thursday\nperson2: you serious? thanks\nperson3: thats nice of you',
    'person1: ill bring my projector for movie night\nperson2: sweet\nperson3: ill bring snacks',
  ]},
  // PREFERENCES
  { type: 'preference', conversations: [
    'person1: i always go with oat milk\nperson2: noted\nperson3: almond for me',
    'person1: no spicy food for me please\nperson2: ok well pick somewhere mild\nperson3: thai has mild options',
    'person1: i prefer window seats on flights\nperson2: same\nperson3: aisle all day',
    'person1: i dont do horror movies\nperson2: noted\nperson3: comedy it is then',
    'person1: im a morning person so earlier works better\nperson2: ok 9am then\nperson3: ugh fine',
  ]},
  // PERSONAL FACTS
  { type: 'personal', conversations: [
    'person1: im allergic to peanuts btw\nperson2: good to know\nperson3: well be careful ordering',
    'person1: my birthday is june 12\nperson2: saved it\nperson3: well plan something',
    'person1: im vegetarian so no meat options for me\nperson2: cool well make sure\nperson3: plenty of veggie options',
    'person1: i have a nut allergy heads up\nperson2: thanks for telling us\nperson3: noted',
    'person1: im lactose intolerant\nperson2: dairy free it is\nperson3: oat milk gang',
  ]},
  // NEGATIVE - social chat with NO extractable facts
  { type: 'none', conversations: [
    'person1: that movie was so good\nperson2: right?? the ending\nperson3: no spoilers!',
    'person1: im so tired today\nperson2: same\nperson3: coffee is the answer\nperson1: already on my third',
    'person1: did you see that tiktok\nperson2: which one\nperson1: the cat one\nperson2: lmaooo yes',
    'person1: mondays am i right\nperson2: the worst\nperson3: at least its almost over',
    'person1: who else is bored\nperson2: me\nperson3: same\nperson1: lets do something',
  ]},
]

const GEN_PROMPT = `Generate a realistic group chat conversation (3-6 messages, person1/person2/person3) about a SPECIFIC topic.
The conversation must contain extractable facts of type: {TYPE}.
Use casual language - lowercase, abbreviations, slang.
Make the topic DIFFERENT from these examples - be creative with domains (travel, work, school, hobbies, events, sports, food, health).

Respond with ONLY a JSON object:
{"conversation":"person1: ...\nperson2: ...\nperson3: ...","facts":[{"type":"TYPE","key":"short_key","value":"the fact"}]}`

async function generateOne(factType: string): Promise<string | null> {
  const prompt = factType === 'none'
    ? `Generate a casual group chat conversation (3-5 messages) that contains NO extractable facts - just social chat, opinions, jokes, reactions. Respond with ONLY: {"conversation":"person1: ...\nperson2: ..."}`
    : GEN_PROMPT.replace(/\{TYPE\}/g, factType)

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [
          { role: 'system', content: 'Generate group chat conversations with extractable facts. JSON only.' },
          { role: 'user', content: prompt },
        ],
        stream: false,
        options: { temperature: 0.9, num_predict: 300, top_p: 0.95 },
      }),
    })
    if (!res.ok) return null

    interface OllamaResponse { message: { content: string } }
    const data = (await res.json()) as OllamaResponse
    let raw = data.message.content.replace(/```(?:json)?\s*|```\s*/g, '').trim()
    if (!raw.startsWith('{')) {
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start !== -1 && end > start) raw = raw.slice(start, end + 1)
    }

    const parsed = JSON.parse(raw) as { conversation?: string; facts?: Array<{type: string; key: string; value: string}> }
    if (!parsed.conversation) return null

    // Build assistant response (the extraction output)
    const facts = factType === 'none' ? [] : (parsed.facts ?? [])
    const assistantContent = JSON.stringify(facts)

    const example = {
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: parsed.conversation },
        { role: 'assistant', content: assistantContent },
      ],
    }
    return JSON.stringify(example)
  } catch {
    return null
  }
}

async function generateFromTemplate(template: { type: string; conversations: string[] }): Promise<string[]> {
  const results: string[] = []
  for (const conv of template.conversations) {
    // For templates, we know the expected output format
    const facts = template.type === 'none' ? '[]' : `[{"type":"${template.type}","key":"see_conversation","value":"extracted from context"}]`
    const example = {
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: conv },
        { role: 'assistant', content: facts },
      ],
    }
    results.push(JSON.stringify(example))
  }
  return results
}

async function main() {
  let written = 0
  if (existsSync(args.out!)) {
    written = readFileSync(args.out!, 'utf-8').trim().split('\n').filter(Boolean).length
    console.log(`Resuming from ${written}`)
  } else {
    writeFileSync(args.out!, '')
  }

  // Seed with templates first (25 high-quality examples)
  if (written === 0) {
    for (const template of EXTRACTION_TEMPLATES) {
      const examples = await generateFromTemplate(template)
      for (const ex of examples) {
        appendFileSync(args.out!, ex + '\n')
        written++
      }
    }
    console.log(`Seeded ${written} template examples`)
  }

  // Generate rest via Ollama
  const types = ['logistics', 'commitment', 'preference', 'personal', 'none']
  let attempts = 0

  while (written < TARGET && attempts < TARGET * 3) {
    const factType = types[Math.floor(Math.random() * types.length)]!
    attempts++

    const result = await generateOne(factType)
    if (result) {
      appendFileSync(args.out!, result + '\n')
      written++
      if (written % 100 === 0) {
        console.log(`[${written}/${TARGET}] type=${factType} (${attempts} attempts, ${Math.round(written / attempts * 100)}% success)`)
      }
    }
  }

  console.log(`\nDone: ${written} examples`)
  console.log(`Output: ${args.out}`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
