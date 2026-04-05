# Agent Guide

Codebase map for automated agents, evaluators, and reviewers.

## What this is

A silence-first iMessage group chat agent. The core design challenge: teach a 3B language model to default to not responding, and speak only for factual corrections, unanswered questions, and direct address. Runs fully local via Ollama — no cloud inference.

## Architecture in 30 seconds

```
message → batcher (3s debounce) → memory (SQLite) → gate (LLM) → voice filter → send
                                                         |
                                                    SILENT 95% of the time
```

The gate is the entire product. Everything else is plumbing.

## Source files (`src/`)

| File | Role |
|------|------|
| `gate.ts` | Monolithic speak/silent decision engine (Pass 1). `buildSystemPrompt()` encodes the rules. `parseDecision()` extracts action + response. Parse failures default to SILENT (load-bearing). |
| `gate-dual.ts` | Dual-pass gate: Pass 1 monolithic + regex gate + Pass 2 memory-recall with injected facts. `MEMORY_CHECK_SYSTEM` prompt, `MEMORY_QUERY_PATTERNS` regex, `evaluateDual()`. Feature-flagged via `PHILA_GATE=dual`. |
| `gate-hierarchical.ts` | Experimental hierarchical gate (kept as reference, not production). Binary filter + monolithic fallback. Benchmarked at 77.9% - decomposition hurts 3B accuracy. |
| `memory-extract.ts` | Background fact extraction pipeline. `EXTRACT_SYSTEM` prompt, `parseExtraction()`. Extracts logistics, commitments, preferences, personal facts from conversations into SQLite. |
| `types.ts` | Shared types: `GateAction`, `GateMode`, `Classification`, `HierarchicalDecision`, `FactType`, `ExtractedFact`, `GroupProfile`, `PhilaConfig` |
| `memory.ts` | SQLite persistence. Conversation history, group profiles, asymmetric feedback, `extracted_facts` table with `storeFact()`/`getRecentFacts()`/`searchFacts()`. |
| `voice.ts` | Post-processing: lowercase, strip AI-speak, enforce length. Safety net if the model slips. |
| `ollama.ts` | Ollama chat API wrapper. `chat()` for standard calls, `chatFast()` (numPredict=8) for classification. |
| `config.ts` | Env-var configuration. `PHILA_GATE` controls gate mode (monolithic/hierarchical/dual). |
| `index.ts` | Entry point. iMessage watcher, 3s batcher, gate mode branching, background fact extraction, pipeline orchestration. |

## Test files (`test/`)

**Unit/integration tests** (run with `npm test`):
- `gate.test.ts`, `memory.test.ts`, `voice.test.ts`, `pipeline.test.ts`, `scorer.test.ts` — 132 tests, node:test runner

**Benchmark + eval infrastructure** (run on VPS with Ollama):
- `scenarios.ts` — 101 labeled scenarios across 9 categories, 4 difficulty tiers. 58 train / 43 holdout split. Source of truth for all evaluations.
- `scorer.ts` — Response quality scoring: topic accuracy (0.35), casualness (0.25), AI-speak absence (0.20), length fit (0.10), voice survival (0.10)
- `eval-shared.ts` — Shared `evaluate()`, `pairedTTest()` (p < 0.10), reward-hacking detector
- `benchmark.ts` — Single benchmark run against all 101 scenarios
- `finetune-eval.ts` — Three-part eval: holdout accuracy, full composite scoring, regression deep-dive. Use this to compare fine-tuned vs baseline.
- `inference.ts` — Ollama inference wrapper used by all benchmark scripts

**Research log**: `FINDINGS.md` at repo root — cumulative benchmark results and decisions. Read this for full experiment history.

**Research pipeline** (`research/`):
- `gen-finetune-data.ts` — Generates labeled JSONL training data by category
- `buried-thread-probe.ts` — Targeted probe of the hardest failure category
- `gen-adversarial.ts`, `gen-prompt-mutations.ts` — LLM-assisted scenario/prompt generation

**Fine-tuning pipeline** (`research/finetune/`):
- `finetune.py` — Unsloth QLoRA training. Reads `train.jsonl`, fine-tunes `unsloth/Llama-3.2-3B-Instruct`, exports GGUF via `save_pretrained_gguf`. Saves LoRA to HuggingFace before GGUF export as recovery checkpoint.
- `launch-remote.sh` — Runs on Vast.ai instance via SSH. Installs deps, pre-builds llama.cpp (must run in foreground — nohup breaks the interactive build), launches training as nohup.
- `monitor.sh` — Local cron monitor. Waits for `done.json`, checks training status, downloads GGUF, destroys instance. Uses `find -newer done.json` to verify GGUF is from the current run.

**Fine-tune data** (`test/research-reports/finetune-data/`):
- `train-v2.jsonl` — 1,138 training examples (755 base + 150 speak-unanswered + 153 silent-sarcasm + 80 near-miss)
- `Modelfile-v2-deploy` — Ollama Modelfile for gate use (temperature=0.1, topP=0.52, numPredict=64 — GPU-optimized)
- `phila-ft-v2.Q4_K_M.gguf` — Fine-tuned model weights (gitignored, 1.93GB). Download from [HuggingFace](https://huggingface.co/onblueroses/phila-ft-v2-GGUF).

## Key invariants

- **Parse failure → SILENT.** Any unparseable LLM output is treated as silent. Worst failure mode is being too quiet.
- **Holdout never trains.** `scenarios.ts` has `split: 'train' | 'holdout'`. The holdout set is never optimized against — only used to detect overfitting.
- **Reward-hacking guard.** Optimizer reverts if holdout drops >3% from its peak, even if train accuracy improves.
- **Asymmetric feedback.** Negative feedback (-0.05) outweighs positive (+0.02) by 2.5x. People say "thanks" casually; they don't say "shut up" casually.
- **Local only.** No API calls to external LLM providers. Ollama only.

## Running things

```bash
npm test                          # 132 unit tests
npm start                         # run the agent (macOS + Ollama required)

# on VPS (where Ollama runs):
node --experimental-strip-types test/benchmark.ts --runs 3
node --experimental-strip-types test/finetune-eval.ts --model phila-ft-v2 --baseline llama3.2 --runs 5
```

## Research history summary

1. **660+ prompt/parameter mutations** via automated optimizer — no statistically significant improvement over baseline prompt
2. **Buried-thread failure** confirmed as model capability limit (0% across 4 models × 4 prompts × 30 scenarios)
3. **phila-ft v1** (755 examples): fixed buried-thread (0%→100%) but introduced 3 hard regressions
4. **phila-ft v2** (1,138 examples, adds 383 targeted): all 4 regression scenarios back to 100%, holdout +5.1pp vs baseline

Full details: `FINDINGS.md` (repo root)
