#!/usr/bin/env bash
# Launch the phila research campaign in tmux.
# Creates a tmux session with 3 windows: orchestrator, ollama, watcher.
#
# Usage:
#   ./test/research/start-campaign.sh

set -euo pipefail

SESSION="phila-research"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Kill existing session if any
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Create session with orchestrator window
tmux new-session -d -s "$SESSION" -n orchestrator -c "$PROJECT_DIR"
tmux send-keys -t "$SESSION:orchestrator" "./test/research/research-campaign.sh" Enter

# Ollama logs window
tmux new-window -t "$SESSION" -n ollama
tmux send-keys -t "$SESSION:ollama" "journalctl -u ollama -f 2>/dev/null || tail -f /var/log/ollama.log 2>/dev/null || echo 'ollama logs not found - check ollama serve output'" Enter

# Report watcher window
tmux new-window -t "$SESSION" -n watcher -c "$PROJECT_DIR"
tmux send-keys -t "$SESSION:watcher" "watch -n 60 'cat test/research-reports/latest.md 2>/dev/null || echo \"no reports yet\"'" Enter

# Focus on orchestrator
tmux select-window -t "$SESSION:orchestrator"

echo "campaign started in tmux session '$SESSION'"
echo "  tmux attach -t $SESSION"
echo ""
echo "windows:"
echo "  0:orchestrator - campaign loop"
echo "  1:ollama       - ollama logs"
echo "  2:watcher      - latest report (refreshes every 60s)"
