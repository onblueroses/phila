# phila

iMessage group chat agent biased toward silence. Photon Fellowship build challenge submission.

## Architecture

Silence-first design: speak gate evaluates every message batch, returns SILENT ~95% of the time.

```
message -> batcher (3s debounce) -> memory -> gate (local LLM) -> voice filter -> send
```

**Source** (src/): config.ts, types.ts, ollama.ts, gate.ts, memory.ts, voice.ts, index.ts
**Tests** (test/): gate.test.ts, memory.test.ts, voice.test.ts, pipeline.test.ts, scorer.test.ts (113 tests via node:test)
**Benchmarks** (test/): benchmark.ts, autooptimize.ts, continuous-optimize.ts, cross-validation.ts, scenarios.ts, scorer.ts, inference.ts
**GPU runner** (test/): build-kaggle-script.py, kaggle-kernel/ (Kaggle T4 GPU optimizer)

## Key decisions

- Parse failure defaults to silence (load-bearing safety)
- Sender anonymization (person1/person2) reduces noise for 3B model
- Asymmetric feedback: negative -0.05, positive +0.02 (silence bias)
- No build step: node --experimental-strip-types (Node 22.6+)
- Local inference only (Ollama), no cloud APIs

## Constraints

- This is a PUBLIC repo. No personal details, business names, private IPs.
- The gate prompt in gate.ts is the core of the product. Changes need benchmark validation.
- Tests: `npm test` (node:test, not vitest)
- macOS only at runtime (@photon-ai/imessage-kit requires darwin)
- Inference params validated via 660-gen GPU optimization: temperature=0.1, topP=0.52, numPredict=64 are optimal. Don't change without benchmarking.
- Train/holdout scenario split: 58 train, 43 holdout (101 total). Holdout is never optimized against.
- Known limitation: model knowledge gaps (Berlin Wall date, Gandhi quote, H2O formula) cause false-silent on hard correction scenarios. These are in holdout.

## Running benchmarks

```bash
# On VPS (where Ollama runs):
node --experimental-strip-types test/benchmark.ts --runs 3
node --experimental-strip-types test/continuous-optimize.ts --runs 5

# GPU optimization (Kaggle T4):
python3 test/build-kaggle-script.py  # regenerate kaggle-kernel/script.py from source
cd test/kaggle-kernel && kaggle kernels push
```
