#!/usr/bin/env bash
# v3 benchmark campaign with overfitting detection.
# Tests mono + dual (semantic + regex fallback) across 3 test suites.
#
# Usage: ssh root@VPS "cd /root/phila && bash research/overnight-v3-campaign.sh [rounds]"
#
# Writes JSON results to overnight-results/v3-YYYYMMDD-HHMM/.
# Appends summary lines to overnight-results/v3-campaign-log.txt.

set -euo pipefail

ROUNDS=${1:-3}
RUNS_PER_SCENARIO=10
DUAL_ROUNDS=${2:-1}   # dual config runs only this many rounds (default: 1)
OLLAMA_URL="http://localhost:11434"
TIMESTAMP=$(date +%Y%m%d-%H%M)
OUTDIR="overnight-results/v3-${TIMESTAMP}"
LOGFILE="overnight-results/v3-campaign-log.txt"
LOCKFILE="/tmp/phila-v3-campaign.lock"

mkdir -p "$OUTDIR"

# Configs: model x gate
CONFIGS=(
    "phila-ft-v3:monolithic"
    "phila-ft-v3:dual"
)

# Test suites: name:path (empty path = builtin)
SUITES=(
    "builtin:"
    "independent:research/independent-scenarios.json"
    "overfitting:research/overfitting-scenarios.json"
)

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

# mono runs all rounds, dual runs DUAL_ROUNDS only
total_configs=$(( ${#SUITES[@]} * ROUNDS + ${#SUITES[@]} * DUAL_ROUNDS ))
echo "=== v3 Campaign: mono ${ROUNDS}r + dual ${DUAL_ROUNDS}r x ${#SUITES[@]} suites = $total_configs benchmarks ===" | tee -a "$LOGFILE"
echo "Started: $(date -Iseconds)" | tee -a "$LOGFILE"
echo "Output: $OUTDIR" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

completed=0

for round in $(seq 1 "$ROUNDS"); do
    echo "--- Round $round/$ROUNDS ($(date +%H:%M)) ---" | tee -a "$LOGFILE"

    for config in "${CONFIGS[@]}"; do
        model="${config%%:*}"
        gate="${config##*:}"

        # Skip dual config after DUAL_ROUNDS
        if [ "$gate" = "dual" ] && [ "$round" -gt "$DUAL_ROUNDS" ]; then
            echo "  SKIP $gate configs for round $round (dual limited to $DUAL_ROUNDS rounds)" | tee -a "$LOGFILE"
            continue
        fi

        for suite_entry in "${SUITES[@]}"; do
            suite_name="${suite_entry%%:*}"
            suite_path="${suite_entry##*:}"

            label="${suite_name}-${gate}-${model//[:.]/-}"
            outfile="${OUTDIR}/${label}-r${round}.json"

            # Skip if already completed (crash recovery)
            if [ -f "$outfile" ] && python3 -c "import json; json.load(open('$outfile'))" 2>/dev/null; then
                echo "  SKIP $label r$round (already complete)" | tee -a "$LOGFILE"
                completed=$((completed + 1))
                continue
            fi

            scenario_flag=""
            if [ -n "$suite_path" ]; then
                scenario_flag="--scenarios $suite_path"
            fi

            echo -n "  RUN  $label r$round ($((completed+1))/$total_configs)... " | tee -a "$LOGFILE"

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
                    if ! curl -sf "$OLLAMA_URL/api/tags" > /dev/null 2>&1; then
                        echo "Ollama down, waiting 30s..." | tee -a "$LOGFILE"
                        sleep 30
                    fi
                fi
            done

            if [ "$success" = true ]; then
                acc=$(python3 -c "import json; d=json.load(open('$outfile')); print(f\"{d['summary']['accuracy']}%\")" 2>/dev/null || echo "?")
                echo "DONE ($acc)" | tee -a "$LOGFILE"
                completed=$((completed + 1))
            else
                echo "FAILED after 3 attempts" | tee -a "$LOGFILE"
            fi
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
    parts = name.rsplit('-r', 1)
    if len(parts) != 2:
        continue
    config = parts[0]
    try:
        d = json.load(open(f))
        if config not in results:
            results[config] = {'acc': [], 'precision': [], 'recall': [], 'f1': []}
        results[config]['acc'].append(d['summary']['accuracy'])
        cm = d.get('confusionMatrix', {})
        if 'precision' in cm:
            results[config]['precision'].append(cm['precision'])
            results[config]['recall'].append(cm['recall'])
            results[config]['f1'].append(cm['f1'])
    except:
        pass

print(f\"{'Config':<55} {'Avg Acc':>8} {'Prec':>7} {'Recall':>7} {'F1':>7} {'Runs':>5}\")
print('-' * 95)
for config in sorted(results.keys()):
    r = results[config]
    avg = lambda lst: sum(lst)/len(lst) if lst else 0
    print(f'{config:<55} {avg(r[\"acc\"]):>7.1f}% {avg(r[\"precision\"]):>6.3f} {avg(r[\"recall\"]):>6.3f} {avg(r[\"f1\"]):>6.3f} {len(r[\"acc\"]):>5}')

# Overfitting detection: compare overfitting suite vs independent
print()
print('=== Overfitting Detection ===')
for gate in ['monolithic', 'dual']:
    ind_key = f'independent-{gate}-phila-ft-v3'
    ovf_key = f'overfitting-{gate}-phila-ft-v3'
    if ind_key in results and ovf_key in results:
        ind_acc = avg(results[ind_key]['acc'])
        ovf_acc = avg(results[ovf_key]['acc'])
        gap = ind_acc - ovf_acc
        flag = 'SUSPECT' if gap > 5 else 'OK'
        print(f'{gate}: independent={ind_acc:.1f}% overfitting={ovf_acc:.1f}% gap={gap:+.1f}pp [{flag}]')
" 2>&1 | tee -a "$LOGFILE"

rm -f "$LOCKFILE"
