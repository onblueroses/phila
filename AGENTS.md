# Agent Guide

Codebase map for automated agents, evaluators, and reviewers.

## What this is

A silence-first iMessage group chat agent. The core design challenge: teach a 3B language model to default to not responding, and speak only for factual corrections, unanswered questions, and direct address. Runs fully local via Ollama - no cloud inference.

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
| `gate.ts` | Monolithic speak/silent decision engine. `buildSystemPrompt()` encodes NEVER SPEAK / ALWAYS SPEAK rules with 7 worked examples. `parseDecision()` extracts action + response. Conditional double-check on speak decisions via `DOUBLE_CHECK_PROMPT`. Parse failures default to SILENT (load-bearing). |
| `gate-dual.ts` | Dual-pass gate: Pass 1 monolithic + regex gate + Pass 2 memory-recall with injected facts. Feature-flagged via `PHILA_GATE=dual`. Benchmarked at 91.7% but adds no value over v5 monolithic (95.2%). |
| `gate-hierarchical.ts` | Experimental hierarchical gate (kept as reference, not production). Binary filter + monolithic fallback. Benchmarked at 77.9% - decomposition hurts 3B accuracy. |
| `memory-extract.ts` | Background fact extraction pipeline. `EXTRACT_SYSTEM` prompt, `parseExtraction()`. Extracts logistics, commitments, preferences, personal facts from conversations into SQLite. |
| `types.ts` | Shared types: `GateAction`, `GateMode`, `Classification`, `HierarchicalDecision`, `FactType`, `ExtractedFact`, `GroupProfile`, `PhilaConfig`, `AllowedTool` |
| `memory.ts` | SQLite persistence. Conversation history, group profiles, asymmetric feedback, `extracted_facts` table with `storeFact()`/`getRecentFacts()`/`searchFacts()`. |
| `voice.ts` | Post-processing: lowercase, strip AI-speak, enforce length. Safety net if the model slips. |
| `ollama.ts` | Ollama chat API wrapper. `chat()` for standard calls, `chatFast()` (numPredict=8) for classification. |
| `similarity.ts` | Cosine similarity for semantic memory recall. |
| `verify.ts` | Fact verification against DuckDuckGo and Wikipedia. 3s timeout. |
| `config.ts` | Env-var configuration. `PHILA_GATE` controls gate mode (monolithic/hierarchical/dual). |
| `index.ts` | Entry point. iMessage watcher, 3s batcher, gate mode branching, background fact extraction, pipeline orchestration. |

## Test files (`test/`)

**Unit/integration tests** (run with `npm test`):
- `gate.test.ts`, `memory.test.ts`, `voice.test.ts`, `pipeline.test.ts`, `scorer.test.ts`, `similarity.test.ts`, `verify.test.ts` - 224 tests, node:test runner

**Benchmark + eval infrastructure** (run on VPS with Ollama):
- `scenarios.ts` - 146 labeled scenarios across 9 categories, 4 difficulty tiers. Train/holdout split. Source of truth for all evaluations.
- `scorer.ts` - Response quality scoring: topic accuracy (0.35), casualness (0.25), AI-speak absence (0.20), length fit (0.10), voice survival (0.10)
- `eval-shared.ts` - Shared `evaluate()`, `pairedTTest()` (p < 0.10), reward-hacking detector, bootstrap CI
- `benchmark.ts` - Single benchmark run with confusion matrix, bootstrap CI, `--double-check` flag
- `layer-benchmark.ts` - 5-layer prompt experiment (3-11 examples) to find optimal example count
- `continuous-optimize.ts` - Multi-generation prompt optimizer with mutation/crossover
- `cross-validation.ts` - Multi-suite validation across original + independent + adversarial scenarios
- `finetune-eval.ts` - Three-part eval: holdout accuracy, full composite scoring, regression deep-dive
- `inference.ts` - Ollama inference wrapper used by all benchmark scripts

**Research pipeline** (`research/`):
- `gen-finetune-data.ts`, `gen-finetune-data-v4.ts` - Generates labeled JSONL training data by category
- `compile-train-v4.ts`, `compile-train-v5.ts` - Compile training data with holdout contamination checks
- `buried-thread-probe.ts` - Targeted probe of the hardest failure category
- `gen-adversarial.ts`, `gen-prompt-mutations.ts`, `gen-independent-scenarios.ts` - LLM-assisted generation
- `tournament.ts` - Single-elimination tournament with paired t-tests

**Fine-tuning pipeline** (`research/finetune/`):
- `finetune.py` - Unsloth QLoRA training. Reads `train.jsonl`, fine-tunes `unsloth/Llama-3.2-3B-Instruct`, exports GGUF.
- `launch-remote.sh` - Vast.ai remote training runner
- `monitor.sh` - Local cron monitor. Waits for completion, downloads GGUF, destroys instance.

## Key invariants

- **Parse failure → SILENT.** Any unparseable LLM output is treated as silent. Worst failure mode is being too quiet.
- **Holdout never trains.** `scenarios.ts` has `split: 'train' | 'holdout'`. The holdout set is never optimized against.
- **Reward-hacking guard.** Optimizer reverts if holdout drops >3% from its peak, even if train accuracy improves.
- **Asymmetric feedback.** Negative feedback (-0.05) outweighs positive (+0.02) by 2.5x.
- **Local only.** No API calls to external LLM providers. Ollama only.
- **NEVER SPEAK first.** Gate prompt checks silence conditions before speak conditions - flat rule structure, no nested conditionals.

## Running things

```bash
npm test                          # 224 unit tests
npm start                         # run the agent (macOS + Ollama required)

# on VPS (where Ollama runs):
node --experimental-strip-types test/benchmark.ts --runs 5 --model phila-ft-v5
node --experimental-strip-types test/layer-benchmark.ts --runs 3
node --experimental-strip-types test/continuous-optimize.ts --runs 5
```

## Research history summary

1. **4 models evaluated** (llama3.2, qwen2.5:3b, qwen2.5:7b, phi3:mini, gemma2:2b) - llama3.2 selected for gate
2. **750+ prompt/parameter mutations** via automated optimizer - gen 46 found optimal example set
3. **5 fine-tune iterations**: v1 (755 ex, buried-thread fixed), v2 (1,138 ex, regressions fixed), v3 (3,799 ex, generalization gap closed), v5 (4,780 ex, already-corrected fixed)
4. **8 architecture iterations**: 3 hierarchical, 4 dual-pass, 1 monolithic winner - decomposition hurts at 3B
5. **Prompt engineering campaign**: 5-layer benchmark, NEVER SPEAK restructure, double-check experiment
6. **Final: 95.2% holdout** [90.1%, 99.0% CI], 0.983 precision, 0.912 recall, F1 0.946

Full details: `FINDINGS.md` (repo root)
