#!/usr/bin/env bash
# phila autonomous research campaign
# Runs multi-model benchmarks, injection tests, and long-context stress tests in a loop.
# Designed for tmux on VPS. Ctrl+C to stop gracefully.
#
# Usage:
#   ./research/research-campaign.sh
#   PHILA_OLLAMA_URL=http://localhost:11434 ./research/research-campaign.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORTS_DIR="$PROJECT_DIR/test/research-reports"
STATE_FILE="$SCRIPT_DIR/state.json"
NODE="node --experimental-strip-types"
SLEEP_BETWEEN_CYCLES=300 # 5 minutes

cd "$PROJECT_DIR"
mkdir -p "$REPORTS_DIR"

# Graceful shutdown
RUNNING=true
trap 'echo ""; echo "shutting down after current phase..."; RUNNING=false' INT TERM

# Load or init state
if [ -f "$STATE_FILE" ]; then
  CYCLE=$(jq -r '.cycle' "$STATE_FILE")
  echo "resuming from cycle $CYCLE"
else
  CYCLE=0
  echo '{"cycle":0,"startedAt":"'"$(date -Iseconds)"'"}' > "$STATE_FILE"
  echo "starting fresh"
fi

echo "reports: $REPORTS_DIR"
echo ""

while $RUNNING; do
  # Refresh model list each cycle (picks up newly pulled models)
  MODELS=$(curl -s "${PHILA_OLLAMA_URL:-http://localhost:11434}/api/tags" | jq -r '.models[].name' | tr '\n' ',' | sed 's/,$//')
  echo "models: $MODELS"
  CYCLE=$((CYCLE + 1))
  CYCLE_START=$(date +%s)
  echo "=========================================="
  echo "  CYCLE $CYCLE - $(date)"
  echo "=========================================="
  echo ""

  # Phase 1: Multi-model benchmark
  if $RUNNING; then
    echo "--- multi-model benchmark ---"
    $NODE research/benchmark-multimodel.ts \
      --models "$MODELS" \
      --runs 3 \
      --out "$REPORTS_DIR/multimodel-$(date +%s).json" \
      2>&1 || echo "  [ERROR] multi-model benchmark failed"
    echo ""
  fi

  # Phase 2: Injection resilience (run per model)
  if $RUNNING; then
    echo "--- injection resilience ---"
    # Just test the primary model for injection (others are similar)
    PRIMARY_MODEL=$(echo "$MODELS" | cut -d',' -f1)
    $NODE research/eval-injection.ts \
      --model "$PRIMARY_MODEL" \
      --runs 3 \
      --out "$REPORTS_DIR/injection-$(date +%s).json" \
      2>&1 || echo "  [ERROR] injection test failed"
    echo ""
  fi

  # Phase 3: Long-context stress test
  if $RUNNING; then
    echo "--- long-context stress test ---"
    PRIMARY_MODEL=$(echo "$MODELS" | cut -d',' -f1)
    $NODE research/eval-long-context.ts \
      --model "$PRIMARY_MODEL" \
      --runs 3 \
      --out "$REPORTS_DIR/long-context-$(date +%s).json" \
      2>&1 || echo "  [ERROR] long-context test failed"
    echo ""
  fi

  # Phase 4: Aggregate report
  if $RUNNING; then
    echo "--- generating report ---"
    $NODE research/aggregate-report.ts \
      --cycle "$CYCLE" \
      --dir "$REPORTS_DIR" \
      2>&1 || echo "  [ERROR] report generation failed"
    echo ""
  fi

  # Update state
  CYCLE_END=$(date +%s)
  DURATION=$((CYCLE_END - CYCLE_START))
  jq --argjson cycle "$CYCLE" --arg ts "$(date -Iseconds)" --argjson dur "$DURATION" \
    '.cycle = $cycle | .lastCompleted = $ts | .lastDurationSecs = $dur' \
    "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"

  echo "cycle $CYCLE complete in ${DURATION}s"
  echo "next cycle in ${SLEEP_BETWEEN_CYCLES}s ($(date -d "+${SLEEP_BETWEEN_CYCLES} seconds" +%H:%M 2>/dev/null || date -v+${SLEEP_BETWEEN_CYCLES}S +%H:%M 2>/dev/null || echo 'soon'))"
  echo ""

  if $RUNNING; then
    sleep $SLEEP_BETWEEN_CYCLES &
    wait $! 2>/dev/null || true  # interruptible sleep
  fi
done

echo ""
echo "=== campaign stopped ==="
echo "completed cycles: $CYCLE"
echo "reports: $REPORTS_DIR"
