#!/usr/bin/env bash
# Overnight campaign for phila-ft-v5.
# Runs: benchmark -> finetune-eval -> continuous-optimize with holdout guard.
# Run on VPS where Ollama serves phila-ft-v5.
#
# Usage: nohup bash overnight-campaign-v5.sh > /root/phila/v5-campaign.log 2>&1 &
set -uo pipefail

MODEL="phila-ft-v5"
GATE_MODEL="llama3.2"
BASELINE="llama3.2"
LOGDIR="/root/v5-campaign-results"
CAMPAIGN_LOG="/root/v5-campaign.log"
export PHILA_OLLAMA_URL="http://localhost:11434"

mkdir -p "$LOGDIR"
cd /root/phila

echo "=== phila v5 overnight campaign ==="
echo "Started: $(date)"
echo "Model: $MODEL | Baseline: $BASELINE"
echo ""

# Phase 1: Full benchmark (5 runs, all scenarios)
echo "=== Phase 1: Full benchmark (5 runs) ==="
node --experimental-strip-types test/benchmark.ts \
    --model "$MODEL" --runs 5 \
    --out "$LOGDIR/benchmark-v5.json" 2>&1
echo "Benchmark saved to $LOGDIR/benchmark-v5.json"
echo ""

# Phase 2: Finetune eval with regression deep-dive
echo "=== Phase 2: Finetune eval vs $BASELINE ==="
node --experimental-strip-types test/finetune-eval.ts \
    --model "$MODEL" --baseline "$BASELINE" --runs 5 --regression-runs 10 \
    --out "$LOGDIR/finetune-eval-v5.json" 2>&1
echo "Finetune eval saved to $LOGDIR/finetune-eval-v5.json"
echo ""

# Phase 3: Baseline benchmark for comparison
echo "=== Phase 3: Baseline benchmark ($BASELINE, 5 runs) ==="
node --experimental-strip-types test/benchmark.ts \
    --model "$BASELINE" --runs 5 \
    --out "$LOGDIR/benchmark-v4.json" 2>&1
echo "Baseline benchmark saved to $LOGDIR/benchmark-v4.json"
echo ""

# Phase 3.5: Split-model benchmark (llama3.2 gate + v5 response)
# llama3.2 base had 94.1% gate accuracy with zero false-speaks.
# v5 handles response generation where its fine-tuning helps.
echo "=== Phase 3.5: Split benchmark ($GATE_MODEL gate + $MODEL response, 5 runs) ==="
node --experimental-strip-types test/benchmark.ts \
    --model "$MODEL" --gate-model "$GATE_MODEL" --runs 5 \
    --out "$LOGDIR/benchmark-split-v3gate-v5resp.json" 2>&1
echo "Split benchmark saved to $LOGDIR/benchmark-split-v3gate-v5resp.json"
echo ""

# Auto-select winner: compare v5 solo vs split holdout accuracy
echo "=== Selecting optimizer config ==="
SOLO_ACC=$(node --experimental-strip-types -e "
const d = JSON.parse(require('fs').readFileSync('$LOGDIR/benchmark-v5.json','utf-8'));
const h = d.holdoutCI?.mean ?? d.summary?.accuracy/100 ?? 0;
console.log(h);
" 2>/dev/null || echo "0")
SPLIT_ACC=$(node --experimental-strip-types -e "
const d = JSON.parse(require('fs').readFileSync('$LOGDIR/benchmark-split-v3gate-v5resp.json','utf-8'));
const h = d.holdoutCI?.mean ?? d.summary?.accuracy/100 ?? 0;
console.log(h);
" 2>/dev/null || echo "0")
echo "v5 solo holdout: $SOLO_ACC | split holdout: $SPLIT_ACC"

USE_SPLIT=$(node --experimental-strip-types -e "console.log(Number($SPLIT_ACC) > Number($SOLO_ACC) ? 'yes' : 'no')" 2>/dev/null)

if [ "$USE_SPLIT" = "yes" ]; then
    echo "WINNER: split ($GATE_MODEL gate + $MODEL response)"
    OPT_GATE_FLAG="--gate-model $GATE_MODEL"
    BENCH_GATE_FLAG="--gate-model $GATE_MODEL"
else
    echo "WINNER: v5 solo (monolithic)"
    OPT_GATE_FLAG=""
    BENCH_GATE_FLAG=""
fi
echo ""

# Phase 4+5 loop: optimize -> verify -> repeat until manually stopped
LOOP=1
while true; do
    echo "=== Phase 4: Continuous optimizer (500 generations, loop $LOOP) ==="
    echo "Holdout guard: cross-validation every 10 gens, paired t-test significance"
    node --experimental-strip-types test/continuous-optimize.ts \
        --model "$MODEL" $OPT_GATE_FLAG --runs 3 --generations 500 \
        --cv-interval 10 \
        --checkpoint "$LOGDIR/checkpoint-v5.json" 2>&1
    echo "Optimizer loop $LOOP complete"
    echo ""

    echo "=== Phase 5: Post-optimization holdout verification (loop $LOOP) ==="
    node --experimental-strip-types test/benchmark.ts \
        --model "$MODEL" $BENCH_GATE_FLAG --runs 5 \
        --out "$LOGDIR/benchmark-v5-post-loop${LOOP}.json" 2>&1
    echo "Post-optimization benchmark saved (loop $LOOP)"
    echo ""

    echo "=== Loop $LOOP complete: $(date) ==="
    ls -la "$LOGDIR/"
    echo ""
    LOOP=$((LOOP + 1))
done
