#!/bin/bash
# Overnight benchmark campaign for phila v3
# Runs on VPS only. Generates a fresh independent test suite, then benchmarks
# all configurations against both old and new suites with 15 runs each.
#
# Usage: bash research/overnight-benchmark.sh
# Expected duration: ~10-12 hours
# Output: /root/phila/overnight-results/

set -euo pipefail

RESULTS_DIR="/root/phila/overnight-results"
TIMESTAMP=$(date +%Y%m%d-%H%M)
RUN_DIR="$RESULTS_DIR/$TIMESTAMP"
mkdir -p "$RUN_DIR"

log() { echo "[$(date +%H:%M:%S)] $1" | tee -a "$RUN_DIR/campaign.log"; }

log "=== phila overnight benchmark campaign ==="
log "Results: $RUN_DIR"

# Phase 1: Generate independent test suite (~1-2 hours)
log "--- Phase 1: Generating independent test suite ---"
node --experimental-strip-types research/gen-independent-scenarios.ts \
  --out "$RUN_DIR/independent-scenarios.json" \
  --count 200 \
  2>&1 | tee -a "$RUN_DIR/generation.log"
log "Generation complete"

# Phase 2: Benchmark all configs against ORIGINAL test suite (15 runs each)
# Run sequentially - one at a time for clean latency measurements
log "--- Phase 2: Original suite benchmarks (15 runs) ---"

CONFIGS=(
  "monolithic:llama3.2"
  "monolithic:phila-ft-v2"
  "dual:llama3.2"
  "dual:phila-ft-v2"
)

for config in "${CONFIGS[@]}"; do
  gate="${config%%:*}"
  model="${config##*:}"
  outfile="$RUN_DIR/original-${gate}-${model//[:\/]/-}-15runs.json"
  log "Running: gate=$gate model=$model runs=15 suite=original"
  node --experimental-strip-types test/benchmark.ts \
    --gate "$gate" --model "$model" --runs 15 \
    --out "$outfile" \
    2>&1 | tee -a "$RUN_DIR/${gate}-${model//[:\/]/-}-original.log"
  log "Done: $outfile"
done

# Phase 3: Benchmark all configs against INDEPENDENT test suite (15 runs each)
log "--- Phase 3: Independent suite benchmarks (15 runs) ---"

for config in "${CONFIGS[@]}"; do
  gate="${config%%:*}"
  model="${config##*:}"
  outfile="$RUN_DIR/independent-${gate}-${model//[:\/]/-}-15runs.json"
  log "Running: gate=$gate model=$model runs=15 suite=independent"
  node --experimental-strip-types test/benchmark.ts \
    --gate "$gate" --model "$model" --runs 15 \
    --scenarios "$RUN_DIR/independent-scenarios.json" \
    --out "$outfile" \
    2>&1 | tee -a "$RUN_DIR/${gate}-${model//[:\/]/-}-independent.log"
  log "Done: $outfile"
done

log "=== Campaign complete ==="
log "Results in: $RUN_DIR"
ls -la "$RUN_DIR"/*.json | tee -a "$RUN_DIR/campaign.log"
