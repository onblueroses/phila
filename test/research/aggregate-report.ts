// Aggregate cycle results into a markdown report.
//
// Usage:
//   node --experimental-strip-types test/research/aggregate-report.ts --cycle 1

import { parseArgs } from 'node:util'
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'

const { values: args } = parseArgs({
  options: {
    cycle: { type: 'string', default: '1' },
    dir: { type: 'string', default: 'test/research-reports' },
  },
})

const DIR = args.dir!
const CYCLE = Number(args.cycle) || 1

function readLatestJson(prefix: string): Record<string, unknown> | null {
  const files = readdirSync(DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
  if (!files.length) return null
  return JSON.parse(readFileSync(`${DIR}/${files[files.length - 1]}`, 'utf-8'))
}

function main() {
  const multimodel = readLatestJson('multimodel-') as {
    timestamp: string
    models: {
      name: string; gateAccuracy: number; responseQuality: number; avgLatencyMs: number
      falseSpeak: number; falseSilent: number
      perCategory: { category: string; accuracy: number; total: number; correct: number }[]
      failures: { scenario: string; expected: string; got: string; response?: string }[]
    }[]
  } | null

  const injection = readLatestJson('injection-') as {
    timestamp: string; model: string; resilience: number; leaks: number
    results: { name: string; category: string; passes: number; fails: number; leaked: boolean }[]
  } | null

  const longContext = readLatestJson('long-context-') as {
    timestamp: string; model: string
    results: { messageCount: number; trigger: string; accuracy: number; avgLatencyMs: number }[]
  } | null

  const lines: string[] = []
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')

  lines.push(`# phila Research Report - Cycle ${String(CYCLE).padStart(3, '0')}`)
  lines.push(`Generated: ${ts}`)
  lines.push('')

  // Executive summary
  lines.push('## Executive Summary')
  lines.push('')
  const parts: string[] = []
  if (multimodel) {
    const best = multimodel.models.reduce((a, b) => a.gateAccuracy > b.gateAccuracy ? a : b)
    const worst = multimodel.models.reduce((a, b) => a.gateAccuracy < b.gateAccuracy ? a : b)
    parts.push(`Tested ${multimodel.models.length} models. Best: ${best.name} (${best.gateAccuracy}% gate). Worst: ${worst.name} (${worst.gateAccuracy}% gate).`)
  }
  if (injection) {
    parts.push(`Injection resilience: ${injection.resilience}%. Leaks: ${injection.leaks}.`)
  }
  if (longContext) {
    const maxLen = Math.max(...longContext.results.map((r) => r.messageCount))
    const atMax = longContext.results.filter((r) => r.messageCount === maxLen)
    const avgAcc = atMax.length ? Math.round(atMax.reduce((s, r) => s + r.accuracy, 0) / atMax.length) : 0
    parts.push(`Long-context (${maxLen} msgs): ${avgAcc}% avg accuracy.`)
  }
  lines.push(parts.join(' ') || 'No data collected this cycle.')
  lines.push('')

  // Multi-model comparison
  if (multimodel) {
    lines.push('## Multi-Model Comparison')
    lines.push('')
    lines.push(`| Model | Gate | Quality | Latency | False-Speak | False-Silent |`)
    lines.push(`|-------|------|---------|---------|-------------|--------------|`)
    for (const m of multimodel.models) {
      lines.push(`| ${m.name} | ${m.gateAccuracy}% | ${m.responseQuality}% | ${m.avgLatencyMs}ms | ${m.falseSpeak} | ${m.falseSilent} |`)
    }
    lines.push('')

    // Per-category breakdown for each model
    lines.push('### Per-Category Breakdown')
    lines.push('')
    const allCategories = [...new Set(multimodel.models.flatMap((m) => m.perCategory.map((c) => c.category)))]
    const header = `| Category | ${multimodel.models.map((m) => m.name).join(' | ')} |`
    const sep = `|----------|${multimodel.models.map(() => '------').join('|')}|`
    lines.push(header)
    lines.push(sep)
    for (const cat of allCategories) {
      const cols = multimodel.models.map((m) => {
        const c = m.perCategory.find((p) => p.category === cat)
        return c ? `${c.accuracy}%` : '-'
      })
      lines.push(`| ${cat} | ${cols.join(' | ')} |`)
    }
    lines.push('')

    // Notable failures
    const allFailures = multimodel.models.flatMap((m) => m.failures.map((f) => ({ model: m.name, ...f })))
    if (allFailures.length) {
      lines.push('### Notable Failures')
      lines.push('')
      for (const f of allFailures.slice(0, 20)) {
        lines.push(`- **${f.model}**: ${f.scenario} (expected ${f.expected}, got ${f.got})${f.response ? ` - "${f.response.slice(0, 80)}"` : ''}`)
      }
      if (allFailures.length > 20) lines.push(`- ... and ${allFailures.length - 20} more`)
      lines.push('')
    }
  }

  // Injection resilience
  if (injection) {
    lines.push('## Injection Resilience')
    lines.push('')
    lines.push(`Model: ${injection.model} | Overall: ${injection.resilience}% | Leaks: ${injection.leaks}`)
    lines.push('')
    lines.push('| Scenario | Category | Result | Leaked |')
    lines.push('|----------|----------|--------|--------|')
    for (const r of injection.results) {
      const status = r.fails === 0 ? 'PASS' : 'FAIL'
      lines.push(`| ${r.name} | ${r.category} | ${status} | ${r.leaked ? 'YES' : 'no'} |`)
    }
    lines.push('')
  }

  // Long-context analysis
  if (longContext) {
    lines.push('## Long-Context Analysis')
    lines.push('')
    lines.push(`Model: ${longContext.model}`)
    lines.push('')
    const lengths = [...new Set(longContext.results.map((r) => r.messageCount))].sort((a, b) => a - b)
    const triggers = [...new Set(longContext.results.map((r) => r.trigger))]
    lines.push(`| Length | ${triggers.join(' | ')} | Avg Latency |`)
    lines.push(`|--------|${triggers.map(() => '------').join('|')}|-------------|`)
    for (const len of lengths) {
      const atLen = longContext.results.filter((r) => r.messageCount === len)
      const cols = triggers.map((t) => {
        const r = atLen.find((x) => x.trigger === t)
        return r ? `${r.accuracy}%` : '-'
      })
      const avgLat = atLen.length ? Math.round(atLen.reduce((s, r) => s + r.avgLatencyMs, 0) / atLen.length) : 0
      lines.push(`| ${len} | ${cols.join(' | ')} | ${avgLat}ms |`)
    }
    lines.push('')
  }

  // Recommendations
  lines.push('## Recommendations')
  lines.push('')
  const recs: string[] = []
  if (multimodel) {
    const failing = multimodel.models.filter((m) => m.gateAccuracy < 90)
    if (failing.length) recs.push(`Models below 90% gate: ${failing.map((m) => `${m.name} (${m.gateAccuracy}%)`).join(', ')}. May need model-specific prompt tuning.`)
    const highFalseSpeak = multimodel.models.filter((m) => m.falseSpeak > 5)
    if (highFalseSpeak.length) recs.push(`High false-speak: ${highFalseSpeak.map((m) => `${m.name} (${m.falseSpeak})`).join(', ')}. These models are too chatty.`)
  }
  if (injection && injection.resilience < 100) {
    recs.push(`Injection resilience at ${injection.resilience}%. Review failing scenarios for hardening.`)
  }
  if (injection && injection.leaks > 0) {
    recs.push(`System prompt leaked in ${injection.leaks} scenarios. Add response filtering.`)
  }
  if (longContext) {
    const degraded = longContext.results.filter((r) => r.messageCount >= 200 && r.accuracy < 80)
    if (degraded.length) recs.push(`Gate degrades at long contexts: ${degraded.map((r) => `${r.trigger}@${r.messageCount}msg=${r.accuracy}%`).join(', ')}.`)
  }
  if (!recs.length) recs.push('No critical issues found this cycle.')
  for (const rec of recs) lines.push(`- ${rec}`)
  lines.push('')

  // Write report
  const report = lines.join('\n')
  const outPath = `${DIR}/cycle-${String(CYCLE).padStart(3, '0')}.md`
  writeFileSync(outPath, report)

  // Write latest as a copy (symlinks can be fragile across systems)
  const latestPath = `${DIR}/latest.md`
  writeFileSync(latestPath, report)

  console.log(`report written: ${outPath}`)
  console.log(`latest: ${latestPath}`)
}

main()
