#!/usr/bin/env bash
# phila overnight prompt optimization campaign
# Each round: adversarial gen -> mutation gen -> tournament -> quality dive -> report.
# Closed loop: round N+1 uses round N's best prompt + accumulated adversarial failures.
# Designed for tmux on VPS. Ctrl+C to stop gracefully.
#
# Usage:
#   ./test/research/overnight-campaign.sh [--rounds N] [--runs R] [--mutations M]
#   PHILA_OLLAMA_URL=http://localhost:11434 ./test/research/overnight-campaign.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPORTS_DIR="$PROJECT_DIR/test/research-reports"
STATE_FILE="$SCRIPT_DIR/overnight-state.json"
NODE="node --experimental-strip-types"
# Unset CLAUDECODE so claude --print calls work when launched from inside a Claude Code session
unset CLAUDECODE

# Time and budget limits
MAX_HOURS=13
MAX_CLAUDE_CALLS=100  # ~$3 at $0.03/call conservative estimate

# Defaults (can be overridden via env)
MAX_ROUNDS="${MAX_ROUNDS:-4}"
RUNS_PER_EVAL="${RUNS_PER_EVAL:-3}"
MUTATIONS_PER_ROUND="${MUTATIONS_PER_ROUND:-5}"
ADVERSARIAL_COUNT="${ADVERSARIAL_COUNT:-20}"
MODEL="${PHILA_MODEL:-llama3.2}"

cd "$PROJECT_DIR"
mkdir -p "$REPORTS_DIR/candidates" "$REPORTS_DIR/rounds"

# Graceful shutdown
RUNNING=true
CAMPAIGN_START=$(date +%s)
trap 'echo ""; echo "SIGINT: stopping after current phase..."; RUNNING=false' INT TERM

function elapsed_hours() {
  awk "BEGIN { printf \"%.2f\", ($(date +%s) - $CAMPAIGN_START) / 3600 }"
}

function check_budget() {
  local secs=$(( $(date +%s) - CAMPAIGN_START ))
  local limit_secs=$(( MAX_HOURS * 3600 ))
  if [ "$secs" -ge "$limit_secs" ]; then
    echo "Budget: $(elapsed_hours)h elapsed >= ${MAX_HOURS}h limit. Stopping."
    RUNNING=false
    return 1
  fi
  return 0
}

# Load or init state
if [ -f "$STATE_FILE" ]; then
  ROUND=$(jq -r '.round' "$STATE_FILE")
  CLAUDE_CALLS=$(jq -r '.claudeCalls' "$STATE_FILE")
  ACCUMULATED_FAILURES=$(jq -r '.accumulatedFailuresPath // empty' "$STATE_FILE")
  BEST_PROMPT_PATH=$(jq -r '.bestPromptPath // empty' "$STATE_FILE")
  echo "Resuming from round $ROUND (${CLAUDE_CALLS} claude calls used so far)"
else
  ROUND=0
  CLAUDE_CALLS=0
  ACCUMULATED_FAILURES=""
  BEST_PROMPT_PATH=""
  echo '{"round":0,"claudeCalls":0,"startedAt":"'"$(date -Iseconds)"'"}' > "$STATE_FILE"
  echo "Starting fresh overnight campaign"
fi

echo "Ollama: ${PHILA_OLLAMA_URL:-http://localhost:11434}"
echo "Reports: $REPORTS_DIR"
echo "Max rounds: $MAX_ROUNDS | Max hours: ${MAX_HOURS}h | Max claude calls: $MAX_CLAUDE_CALLS"
echo ""

while $RUNNING && [ "$ROUND" -lt "$MAX_ROUNDS" ]; do
  check_budget || break

  ROUND=$((ROUND + 1))
  ROUND_LABEL=$(printf '%03d' "$ROUND")
  ROUND_DIR="$REPORTS_DIR/rounds/round-$ROUND_LABEL"
  mkdir -p "$ROUND_DIR"

  ROUND_START=$(date +%s)
  echo "=========================================="
  echo "  ROUND $ROUND - $(date)"
  echo "  Elapsed: $(elapsed_hours)h / ${MAX_HOURS}h"
  echo "  Claude calls: ${CLAUDE_CALLS} / ${MAX_CLAUDE_CALLS}"
  echo "=========================================="
  echo ""

  # -- Phase A: Adversarial scenario generation --
  if $RUNNING; then
    echo "--- adversarial gen (${ADVERSARIAL_COUNT} scenarios) ---"
    ADV_OUT="$ROUND_DIR/adversarial-$(date +%s).json"

    FINDINGS_FLAG=""
    if [ -f "$PROJECT_DIR/test/research/FINDINGS.md" ]; then
      FINDINGS_FLAG="--findings $PROJECT_DIR/test/research/FINDINGS.md"
    fi

    $NODE test/research/gen-adversarial.ts \
      --count "$ADVERSARIAL_COUNT" \
      --out "$ADV_OUT" \
      $FINDINGS_FLAG \
      2>&1 || { echo "  [ERROR] adversarial gen failed - continuing without new scenarios"; ADV_OUT=""; }

    # Increment claude call count (gen-adversarial makes 1 claude call)
    CLAUDE_CALLS=$((CLAUDE_CALLS + 1))

    # Accumulate adversarial failures across rounds
    if [ -n "$ADV_OUT" ] && [ -f "$ADV_OUT" ]; then
      ACCUMULATED_FAILURES="$ADV_OUT"
    fi
    echo ""
  fi

  check_budget || break

  # -- Phase B: Prompt mutation generation --
  if $RUNNING; then
    echo "--- mutation gen (${MUTATIONS_PER_ROUND} mutations) ---"
    MUT_OUT="$ROUND_DIR/mutations-$(date +%s).json"

    FAILURES_FLAG=""
    if [ -n "$ACCUMULATED_FAILURES" ] && [ -f "$ACCUMULATED_FAILURES" ]; then
      FAILURES_FLAG="--failures $ACCUMULATED_FAILURES"
    fi

    BASE_PROMPT_FLAG=""
    if [ -n "$BEST_PROMPT_PATH" ] && [ -f "$BEST_PROMPT_PATH" ]; then
      BASE_PROMPT_FLAG="--base-prompt $BEST_PROMPT_PATH"
    fi

    $NODE test/research/gen-prompt-mutations.ts \
      --count "$MUTATIONS_PER_ROUND" \
      --out "$MUT_OUT" \
      $FAILURES_FLAG \
      $BASE_PROMPT_FLAG \
      2>&1 || { echo "  [ERROR] mutation gen failed - skipping tournament"; MUT_OUT=""; }

    # Mutation gen makes 1 claude call
    CLAUDE_CALLS=$((CLAUDE_CALLS + 1))
    echo ""
  fi

  check_budget || break

  # -- Phase C: Tournament --
  if $RUNNING && [ -n "${MUT_OUT:-}" ] && [ -f "${MUT_OUT:-/dev/null}" ]; then
    echo "--- tournament (runs=$RUNS_PER_EVAL, model=$MODEL) ---"
    TOURN_OUT="$ROUND_DIR/tournament-$(date +%s).json"

    $NODE test/research/tournament.ts \
      --mutations "$MUT_OUT" \
      --runs "$RUNS_PER_EVAL" \
      --model "$MODEL" \
      --quality-dive \
      --out "$TOURN_OUT" \
      2>&1 || { echo "  [ERROR] tournament failed"; TOURN_OUT=""; }

    # Update best prompt path if tournament found an improvement
    if [ -n "${TOURN_OUT:-}" ] && [ -f "${TOURN_OUT:-/dev/null}" ]; then
      WINNER_NAME=$(jq -r '.winner.name' "$TOURN_OUT" 2>/dev/null || echo "")
      if [ -n "$WINNER_NAME" ] && [ "$WINNER_NAME" != "baseline" ]; then
        # Find the most recent best-*.txt written by tournament
        LATEST_BEST=$(ls -t "$REPORTS_DIR/candidates"/best-*.txt 2>/dev/null | head -1 || echo "")
        if [ -n "$LATEST_BEST" ]; then
          BEST_PROMPT_PATH="$LATEST_BEST"
          echo "  New best prompt: $BEST_PROMPT_PATH ($WINNER_NAME)"
        fi
      fi
    fi
    echo ""
  else
    echo "--- tournament skipped (no mutations) ---"
    TOURN_OUT=""
    echo ""
  fi

  check_budget || break

  # -- Phase D: Report --
  if $RUNNING; then
    echo "--- generating report ---"
    REPORT_OUT="$REPORTS_DIR/overnight-round-${ROUND_LABEL}.md"

    $NODE test/research/overnight-report.ts \
      --dir "$ROUND_DIR" \
      --round "$ROUND" \
      --out "$REPORT_OUT" \
      2>&1 || echo "  [ERROR] report generation failed"

    # Append round report to FINDINGS.md
    FINDINGS_FILE="$SCRIPT_DIR/FINDINGS.md"
    if [ -f "$REPORT_OUT" ]; then
      printf '\n---\n\n## Overnight Round %s — %s\n\n' "$ROUND_LABEL" "$(date '+%Y-%m-%d')" >> "$FINDINGS_FILE"
      cat "$REPORT_OUT" >> "$FINDINGS_FILE"
      echo "  Appended to FINDINGS.md"
    fi
    echo ""
  fi

  # Update state checkpoint (for restart survival)
  ROUND_END=$(date +%s)
  ROUND_DURATION=$((ROUND_END - ROUND_START))
  jq --argjson round "$ROUND" \
     --arg ts "$(date -Iseconds)" \
     --argjson dur "$ROUND_DURATION" \
     --argjson calls "$CLAUDE_CALLS" \
     --arg failures "${ACCUMULATED_FAILURES:-}" \
     --arg best "${BEST_PROMPT_PATH:-}" \
     '.round = $round | .lastCompleted = $ts | .lastDurationSecs = $dur | .claudeCalls = $calls | .accumulatedFailuresPath = $failures | .bestPromptPath = $best' \
    "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"

  echo "Round $ROUND complete in ${ROUND_DURATION}s ($(elapsed_hours)h elapsed)"

  if [ "$CLAUDE_CALLS" -ge "$MAX_CLAUDE_CALLS" ]; then
    echo "Claude call budget exhausted (${CLAUDE_CALLS} / ${MAX_CLAUDE_CALLS}). Stopping."
    RUNNING=false
  fi
  echo ""
done

echo ""
echo "=== overnight campaign complete ==="
echo "Rounds completed: $ROUND"
echo "Claude calls used: $CLAUDE_CALLS"
echo "Elapsed: $(elapsed_hours)h"
if [ -n "$BEST_PROMPT_PATH" ] && [ -f "$BEST_PROMPT_PATH" ]; then
  echo "Best prompt candidate: $BEST_PROMPT_PATH"
else
  echo "No improvement over baseline found"
fi
echo "Reports: $REPORTS_DIR"
