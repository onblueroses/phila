# Research Infrastructure

Everything that went into making the speak gate work - benchmarks, automated prompt optimization, fine-tuning, and the tooling that ties them together.

## Pipeline overview

```
scenarios (101 labeled)
    |
    ├── benchmark.ts ─────────── single-run accuracy/latency sweep
    ├── continuous-optimize.ts ── indefinite mutation loop with reward-hacking guard
    ├── finetune-eval.ts ──────── holdout accuracy + composite scoring + regression deep-dive
    └── cross-validation.ts ──── stratified k-fold on train split
    
gen-adversarial.ts ──→ gen-prompt-mutations.ts ──→ tournament.ts
    (edge cases)           (prompt variants)         (paired t-test selection)
                                                          |
                                            overnight-campaign.sh (closed loop)
```

## Evaluation (`test/`)

| File | What it does |
|------|--------------|
| `scenarios.ts` | 101 scenarios across 9 categories. 58 train / 43 holdout. Source of truth for all evals. |
| `eval-shared.ts` | Shared `evaluate()`, `pairedTTest()` (p < 0.10), reward-hacking detector |
| `scorer.ts` | Response quality scoring: topic accuracy, casualness, AI-speak absence, length, voice survival |
| `inference.ts` | Ollama inference wrapper with configurable temperature/topP/numPredict |
| `benchmark.ts` | Full sweep across all scenarios with per-category accuracy breakdown |
| `continuous-optimize.ts` | Generates prompt mutations, tests them, keeps improvements. Reward-hacking rollback if holdout degrades >3pp while train improves. |
| `finetune-eval.ts` | Three-part eval for fine-tuned models: holdout-only gate accuracy, composite scoring vs baseline, regression analysis on prior failures |
| `cross-validation.ts` | Stratified k-fold CV on train scenarios, grouped by expected action and difficulty tier |

## Generation (`research/`)

| File | What it does |
|------|--------------|
| `gen-adversarial.ts` | LLM-generated adversarial scenarios targeting gate rule ambiguities |
| `gen-prompt-mutations.ts` | LLM-generated prompt variants guided by prior adversarial failures |
| `gen-finetune-data.ts` | Generates labeled JSONL training data for fine-tuning by category |

## Multi-model analysis (`research/`)

| File | What it does |
|------|--------------|
| `benchmark-multimodel.ts` | Runs all scenarios against every available Ollama model |
| `model-compare.ts` | Comparative accuracy table across models with per-scenario breakdown |
| `buried-thread-probe.ts` | Targeted probe: 4 models x 4 prompt variants x 30 scenarios on hardest failure category |
| `eval-injection.ts` | Prompt injection resilience and system prompt leakage testing |
| `eval-long-context.ts` | Gate accuracy/latency degradation as conversation length increases |

## Optimization campaigns (`research/`)

| File | What it does |
|------|--------------|
| `tournament.ts` | Single-elimination tournament with paired t-test. Validates winner against holdout after selection. |
| `overnight-campaign.sh` | Closed-loop optimization: adversarial gen -> mutation gen -> tournament -> report. 13h/100-call budget with round state persistence. |
| `start-campaign.sh` | Launches campaign in tmux with 3 windows: orchestrator, ollama logs, report watcher |
| `research-campaign.sh` | Autonomous loop: multi-model benchmark -> injection tests -> long-context stress -> aggregate report (5min cycles) |
| `overnight-report.ts` | Generates morning summary from tournament, adversarial, and quality data |
| `aggregate-report.ts` | Aggregates multimodel/injection/long-context JSON reports into cycle markdown |

## Fine-tuning (`research/finetune/`)

| File | What it does |
|------|--------------|
| `finetune.py` | QLoRA training via Unsloth. Reads `train.jsonl`, fine-tunes llama3.2:3b, exports GGUF. Saves LoRA to HuggingFace as recovery checkpoint before GGUF export. |
| `launch-remote.sh` | Deploys to Vast.ai instance via SSH, installs deps, builds llama.cpp, launches training |
| `monitor.sh` | Local cron monitor: waits for `done.json`, downloads GGUF, destroys instance |

Training data and model files in `test/research-reports/finetune-data/`:
- `train-v2.jsonl` - 1,138 examples (755 base + 383 targeted regression fixes)
- `Modelfile-v2-deploy` - Ollama Modelfile with GPU-optimized inference params
- GGUF weights: [onblueroses/phila-ft-v2-GGUF on HuggingFace](https://huggingface.co/onblueroses/phila-ft-v2-GGUF)

## Running things

```bash
# single benchmark run (requires Ollama with model loaded)
node --experimental-strip-types test/benchmark.ts --runs 3

# compare fine-tuned vs baseline
node --experimental-strip-types test/finetune-eval.ts --model phila-ft-v2 --baseline llama3.2 --runs 5

# overnight optimization campaign
bash research/overnight-campaign.sh
```

Full results and methodology: [FINDINGS.md](../FINDINGS.md)
