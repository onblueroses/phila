#!/usr/bin/env bash
# Local cron monitor. Checks for completion, downloads results, destroys instance.
# Set PHILA_FINETUNE_INSTANCE_ID before installing in cron.
# Cron: */10 * * * * /path/to/monitor.sh >> /path/to/monitor.log 2>&1
set -euo pipefail

INSTANCE_ID="${PHILA_FINETUNE_INSTANCE_ID:?Need PHILA_FINETUNE_INSTANCE_ID}"
RESULTS_DIR="$(cd "$(dirname "$0")"/../research-reports/finetune-data && pwd)"
DONE_MARKER="$RESULTS_DIR/done.json"
LOG="$RESULTS_DIR/monitor.log"

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

echo "[$(timestamp)] Checking instance $INSTANCE_ID..." | tee -a "$LOG"

# Check if still running
STATUS=$(vastai show instance "$INSTANCE_ID" --raw 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('actual_status','unknown'))" 2>/dev/null \
    || echo "gone")
echo "  Status: $STATUS" | tee -a "$LOG"

if [ "$STATUS" = "gone" ] || [ "$STATUS" = "destroyed" ] || [ "$STATUS" = "unknown" ]; then
    echo "  Instance gone - checking if results were saved before teardown" | tee -a "$LOG"
    # Try to get any results that may have been synced
    if [ -f "$DONE_MARKER" ]; then
        echo "  done.json exists locally - training completed before teardown" | tee -a "$LOG"
    else
        echo "  WARNING: instance gone but no done.json locally - training may have failed" | tee -a "$LOG"
    fi
    echo "  Removing cron entry..." | tee -a "$LOG"
    crontab -l 2>/dev/null | grep -v "monitor.sh" | crontab - 2>/dev/null || true
    exit 0
fi

# Try to copy done.json
vastai copy "C.${INSTANCE_ID}:/workspace/done.json" "$DONE_MARKER" 2>/dev/null || true

if [ ! -f "$DONE_MARKER" ]; then
    echo "  Not done yet - checking log tail..." | tee -a "$LOG"
    vastai copy "C.${INSTANCE_ID}:/workspace/run.log" "$RESULTS_DIR/run.log" 2>/dev/null || true
    if [ -f "$RESULTS_DIR/run.log" ]; then
        tail -3 "$RESULTS_DIR/run.log" | sed 's/^/  log: /' | tee -a "$LOG"
    fi
    exit 0
fi

echo "  Training complete! Downloading results..." | tee -a "$LOG"

# Download GGUF and Modelfile
vastai copy "C.${INSTANCE_ID}:/workspace/phila-ft-q4_k_m.gguf" "$RESULTS_DIR/" 2>/dev/null \
    && echo "  Downloaded phila-ft-q4_k_m.gguf" | tee -a "$LOG" \
    || echo "  WARNING: GGUF download failed - check /workspace for exact filename" | tee -a "$LOG"

vastai copy "C.${INSTANCE_ID}:/workspace/Modelfile" "$RESULTS_DIR/" 2>/dev/null \
    && echo "  Downloaded Modelfile" | tee -a "$LOG" \
    || echo "  WARNING: Modelfile not found" | tee -a "$LOG"

vastai copy "C.${INSTANCE_ID}:/workspace/run.log" "$RESULTS_DIR/" 2>/dev/null || true

# List what we got
echo "  Results in $RESULTS_DIR:" | tee -a "$LOG"
ls -lh "$RESULTS_DIR"/*.gguf "$RESULTS_DIR/Modelfile" "$RESULTS_DIR/done.json" 2>/dev/null \
    | sed 's/^/    /' | tee -a "$LOG"

# Destroy instance
echo "  Destroying instance $INSTANCE_ID..." | tee -a "$LOG"
vastai destroy instance "$INSTANCE_ID" 2>&1 | tee -a "$LOG"

# Verify gone
sleep 5
FINAL=$(vastai show instance "$INSTANCE_ID" --raw 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('actual_status','gone'))" 2>/dev/null \
    || echo "gone")
echo "  Post-destroy status: $FINAL" | tee -a "$LOG"
if [ "$FINAL" != "gone" ] && [ "$FINAL" != "destroyed" ]; then
    echo "  WARNING: MANUAL CLEANUP NEEDED - instance $INSTANCE_ID may still be billing" | tee -a "$LOG"
fi

# Remove from cron
crontab -l 2>/dev/null | grep -v "monitor.sh" | crontab - 2>/dev/null || true
echo "  Done. Cron entry removed." | tee -a "$LOG"
