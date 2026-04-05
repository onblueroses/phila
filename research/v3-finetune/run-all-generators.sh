#!/usr/bin/env bash
# Run all three generators sequentially on VPS.
# Each resumes from checkpoint, so safe to restart.
# Usage: bash research/v3-finetune/run-all-generators.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== phila v3 fine-tuning data generation ==="
echo "Started: $(date)"
echo ""

# Gate synthetic (5000 target)
echo "--- Gate Synthetic ---"
node --experimental-strip-types research/v3-finetune/gen-gate-synthetic.ts \
  --count 5000 --concurrency 10
echo ""

# Memory extraction (3000 target)
echo "--- Memory Extraction ---"
node --experimental-strip-types research/v3-finetune/gen-memory-extract.ts \
  --count 3000 --concurrency 10
echo ""

# Memory recall (3000 target)
echo "--- Memory Recall ---"
node --experimental-strip-types research/v3-finetune/gen-memory-recall.ts \
  --count 3000 --concurrency 10
echo ""

echo "=== All generators complete ==="
echo "Finished: $(date)"

# Show counts
echo ""
echo "Final counts:"
for f in data/v3-finetune/gate-synthetic.jsonl data/v3-finetune/memory-extract.jsonl data/v3-finetune/memory-recall.jsonl; do
  if [ -f "$f" ]; then
    echo "  $(wc -l < "$f") $f"
  fi
done

# Run merge
echo ""
echo "--- Merging datasets ---"
node --experimental-strip-types research/v3-finetune/merge-datasets.ts
echo ""
echo "Done!"
