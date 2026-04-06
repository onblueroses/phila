#!/usr/bin/env bash
# Overnight v3 benchmark campaign - runs multiple rounds of all configs
# against both test suites with crash recovery and result persistence.
#
# Usage: ssh root@VPS "cd /root/phila && bash research/overnight-v3-campaign.sh"
#
# Writes results to overnight-results/v3-YYYYMMDD-HHMM/ as JSON files.
# Each completed round appends a summary line to overnight-results/v3-campaign-log.txt.

set -euo pipefail

ROUNDS=${1:-5}
RUNS_PER_SCENARIO=15
OLLAMA_URL="http://localhost:11434"
TIMESTAMP=$(date +%Y%m%d-%H%M)
OUTDIR="overnight-results/v3-${TIMESTAMP}"
LOGFILE="overnight-results/v3-campaign-log.txt"
LOCKFILE="/tmp/phila-v3-campaign.lock"

mkdir -p "$OUTDIR"

# Configs to test
MODELS=("phila-ft-v3" "llama3.2" "phila-ft-v2")
GATES=("monolithic" "dual")
SUITES=("builtin" "independent")

# Lock to prevent duplicate campaigns
if [ -f "$LOCKFILE" ]; then
    pid=$(cat "$LOCKFILE")
    if kill -0 "$pid" 2>/dev/null; then
        echo "Campaign already running (PID $pid). Exiting."
        exit 1
    fi
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

echo "=== v3 Campaign: $ROUNDS rounds x ${#MODELS[@]} models x ${#GATES[@]} gates x ${#SUITES[@]} suites ===" | tee -a "$LOGFILE"
echo "Started: $(date -Iseconds)" | tee -a "$LOGFILE"
echo "Output: $OUTDIR" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

for round in $(seq 1 "$ROUNDS"); do
    echo "--- Round $round/$ROUNDS ($(date +%H:%M)) ---" | tee -a "$LOGFILE"

    for model in "${MODELS[@]}"; do
        for gate in "${GATES[@]}"; do
            for suite in "${SUITES[@]}"; do
                label="${suite}-${gate}-${model//[:.]/-}"
                outfile="${OUTDIR}/${label}-r${round}.json"

                # Skip if already completed (crash recovery)
                if [ -f "$outfile" ] && python3 -c "import json; json.load(open('$outfile'))" 2>/dev/null; then
                    echo "  SKIP $label r$round (already complete)" | tee -a "$LOGFILE"
                    continue
                fi

                scenario_flag=""
                if [ "$suite" = "independent" ]; then
                    scenario_flag="--scenarios research/independent-scenarios.json"
                fi

                echo -n "  RUN  $label r$round... " | tee -a "$LOGFILE"

                # Run with retry on crash (max 3 attempts)
                success=false
                for attempt in 1 2 3; do
                    if PHILA_OLLAMA_URL="$OLLAMA_URL" node --experimental-strip-types \
                        test/benchmark.ts \
                        --model "$model" \
                        --gate "$gate" \
                        --runs "$RUNS_PER_SCENARIO" \
                        $scenario_flag \
                        --out "$outfile" \
                        > "${outfile%.json}.log" 2>&1; then
                        success=true
                        break
                    else
                        echo -n "RETRY($attempt) " | tee -a "$LOGFILE"
                        sleep 5
                        # Check if Ollama is responsive
                        if ! curl -sf "$OLLAMA_URL/api/tags" > /dev/null 2>&1; then
                            echo "Ollama down, waiting 30s..." | tee -a "$LOGFILE"
                            sleep 30
                        fi
                    fi
                done

                if [ "$success" = true ]; then
                    # Extract accuracy from JSON result
                    acc=$(python3 -c "import json; d=json.load(open('$outfile')); print(f\"{d['summary']['accuracy']}%\")" 2>/dev/null || echo "?")
                    echo "DONE ($acc)" | tee -a "$LOGFILE"
                else
                    echo "FAILED after 3 attempts" | tee -a "$LOGFILE"
                fi
            done
        done
    done

    echo "Round $round complete at $(date +%H:%M)" | tee -a "$LOGFILE"
    echo "" | tee -a "$LOGFILE"
done

echo "=== Campaign complete: $(date -Iseconds) ===" | tee -a "$LOGFILE"

# Generate summary table
echo "" | tee -a "$LOGFILE"
echo "=== Summary (averaged across $ROUNDS rounds) ===" | tee -a "$LOGFILE"
python3 -c "
import json, glob, os

results = {}
for f in sorted(glob.glob('${OUTDIR}/*.json')):
    name = os.path.basename(f)
    # Parse: suite-gate-model-rN.json
    parts = name.rsplit('-r', 1)
    if len(parts) != 2:
        continue
    config = parts[0]
    try:
        d = json.load(open(f))
        if config not in results:
            results[config] = []
        results[config].append(d['summary']['accuracy'])
    except:
        pass

print(f\"{'Config':<50} {'Avg Acc':>8} {'Min':>8} {'Max':>8} {'Rounds':>7}\")
print('-' * 85)
for config in sorted(results.keys()):
    accs = results[config]
    avg_acc = sum(accs) / len(accs)
    print(f'{config:<50} {avg_acc:>7.1f}% {min(accs):>7.1f}% {max(accs):>7.1f}% {len(accs):>7}')
" 2>&1 | tee -a "$LOGFILE"

rm -f "$LOCKFILE"
