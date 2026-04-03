#!/usr/bin/env bash
# Local cron monitor. Checks for completion, downloads results, destroys instance.
# Set PHILA_FINETUNE_INSTANCE_ID before installing in cron.
# Cron: */10 * * * * /path/to/monitor.sh >> /path/to/monitor.log 2>&1
set -euo pipefail

INSTANCE_ID="${PHILA_FINETUNE_INSTANCE_ID:?Need PHILA_FINETUNE_INSTANCE_ID}"
RESULTS_DIR="$(cd "$(dirname "$0")"/../research-reports/finetune-data && pwd)"
# Instance-specific marker prevents stale done.json from a previous run triggering teardown
DONE_MARKER="$RESULTS_DIR/done-${INSTANCE_ID}.json"
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

# Get SSH credentials for scp (vastai copy fails with 403)
SSH_INFO=$(vastai show instance "$INSTANCE_ID" --raw 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ssh_host',''), d.get('ssh_port',''))" 2>/dev/null \
    || echo "")
SSH_HOST=$(echo "$SSH_INFO" | awk '{print $1}')
SSH_PORT=$(echo "$SSH_INFO" | awk '{print $2}')
SCP_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=15"

scp_from() { scp $SCP_OPTS -P "$SSH_PORT" "root@${SSH_HOST}:$1" "$2" 2>/dev/null; }

# Try to copy done.json
scp_from /workspace/done.json "$DONE_MARKER" || true

if [ ! -f "$DONE_MARKER" ]; then
    echo "  Not done yet - checking log tail..." | tee -a "$LOG"
    scp_from /workspace/run.log "$RESULTS_DIR/run.log" || true
    if [ -f "$RESULTS_DIR/run.log" ]; then
        tail -5 "$RESULTS_DIR/run.log" | sed 's/^/  log: /' | tee -a "$LOG"
    fi
    exit 0
fi

echo "  Training complete! Downloading results..." | tee -a "$LOG"

# Check if HF repo is in done.json (instance may have already self-destructed after uploading)
HF_REPO=$(python3 -c "import json; d=json.load(open('$DONE_MARKER')); print(d.get('hf_repo',''))" 2>/dev/null || echo "")

if [ -n "$HF_REPO" ]; then
    echo "  Pulling from HuggingFace: $HF_REPO" | tee -a "$LOG"
    python3 -c "
from huggingface_hub import snapshot_download
import os
snapshot_download('$HF_REPO', repo_type='model', local_dir='$RESULTS_DIR',
    token=open(os.path.expanduser('~/.config/huggingface/token')).read().strip())
print('Downloaded from HF')
" 2>&1 | tee -a "$LOG" \
        || echo "  WARNING: HF download failed" | tee -a "$LOG"
else
    echo "  No HF repo in done.json - falling back to scp" | tee -a "$LOG"
    GGUF_FILE=$(ssh $SCP_OPTS -p "$SSH_PORT" "root@${SSH_HOST}" \
        "ls /workspace/phila-ft*.gguf 2>/dev/null | head -1" 2>/dev/null || echo "")
    if [ -n "$GGUF_FILE" ]; then
        scp_from "$GGUF_FILE" "$RESULTS_DIR/$(basename $GGUF_FILE)" \
            && echo "  Downloaded $(basename $GGUF_FILE)" | tee -a "$LOG" \
            || echo "  WARNING: GGUF download failed" | tee -a "$LOG"
    else
        echo "  WARNING: no GGUF found in /workspace" | tee -a "$LOG"
    fi
    scp_from /workspace/Modelfile "$RESULTS_DIR/Modelfile" \
        && echo "  Downloaded Modelfile" | tee -a "$LOG" || true
fi

scp_from /workspace/run.log "$RESULTS_DIR/run.log" || true

# Verify GGUF is local before destroying - scp directly if not already present
LOCAL_GGUF=$(ls "$RESULTS_DIR"/phila-ft*.gguf 2>/dev/null | head -1)
if [ -z "$LOCAL_GGUF" ]; then
    echo "  WARNING: No GGUF found locally - attempting direct scp from instance" | tee -a "$LOG"
    REMOTE_GGUF=$(ssh $SCP_OPTS -p "$SSH_PORT" "root@${SSH_HOST}" \
        "ls /workspace/phila-ft*.gguf 2>/dev/null | head -1" 2>/dev/null || echo "")
    if [ -n "$REMOTE_GGUF" ]; then
        scp_from "$REMOTE_GGUF" "$RESULTS_DIR/$(basename $REMOTE_GGUF)" \
            && echo "  Rescued GGUF via scp: $(basename $REMOTE_GGUF)" | tee -a "$LOG" \
            || echo "  ERROR: scp rescue also failed" | tee -a "$LOG"
    else
        echo "  ERROR: No GGUF on instance either - training may have failed" | tee -a "$LOG"
    fi
fi

# Also grab Modelfile if not already present
[ -f "$RESULTS_DIR/Modelfile" ] || scp_from /workspace/Modelfile "$RESULTS_DIR/Modelfile" || true

# Final check - refuse to destroy if no GGUF landed locally
LOCAL_GGUF=$(ls "$RESULTS_DIR"/phila-ft*.gguf 2>/dev/null | head -1)
if [ -z "$LOCAL_GGUF" ]; then
    echo "  ABORT DESTROY: No GGUF confirmed locally. Manual intervention needed." | tee -a "$LOG"
    echo "  Instance $INSTANCE_ID left running - check /workspace on instance." | tee -a "$LOG"
    exit 1
fi
echo "  GGUF confirmed: $LOCAL_GGUF ($(du -sh "$LOCAL_GGUF" | cut -f1))" | tee -a "$LOG"

# List what we got
echo "  Results in $RESULTS_DIR:" | tee -a "$LOG"
ls -lh "$RESULTS_DIR"/*.gguf "$RESULTS_DIR/Modelfile" "$DONE_MARKER" 2>/dev/null \
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
