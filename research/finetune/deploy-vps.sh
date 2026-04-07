#!/usr/bin/env bash
# Deploy a new GGUF to VPS Ollama and start overnight evaluation campaign.
# Expects: HF_TOKEN, MODEL_NAME (e.g. phila-ft-v4.1), HF_REPO (e.g. onblueroses/phila-ft)
# Run from local machine - SSHes into VPS.
set -euo pipefail

MODEL_NAME="${MODEL_NAME:?Need MODEL_NAME e.g. phila-ft-v4.1}"
HF_REPO="${HF_REPO:-onblueroses/phila-ft}"
GGUF_NAME="${GGUF_NAME:?Need GGUF_NAME e.g. phila-ft-v4.1-unsloth.Q4_K_M.gguf}"
HF_TOKEN="${HF_TOKEN:-$(cat ~/.config/huggingface/token 2>/dev/null)}"
VPS="root@100.121.215.2"
MODELFILE_SRC="$(dirname "$0")/Modelfile-v5"
CAMPAIGN_LOG="/root/phila/${MODEL_NAME}-campaign.log"

echo "=== Deploy phila VPS: ${MODEL_NAME} ==="

echo "--- Copying Modelfile to VPS ---"
scp -o StrictHostKeyChecking=no "$MODELFILE_SRC" "${VPS}:/root/phila/Modelfile-v5"

echo "--- Downloading GGUF from HuggingFace on VPS (~2GB) ---"
ssh -o StrictHostKeyChecking=no "$VPS" "
set -e
HF_TOKEN='${HF_TOKEN}'
HF_REPO='${HF_REPO}'
GGUF_NAME='${GGUF_NAME}'
DEST_DIR='/root/phila'

echo 'Downloading from HuggingFace...'
python3 -c \"
from huggingface_hub import hf_hub_download
import os
token = '${HF_TOKEN}'
path = hf_hub_download(
    repo_id='${HF_REPO}',
    filename='${GGUF_NAME}',
    repo_type='model',
    token=token,
    local_dir='/root/phila',
)
print('Downloaded:', path)
size = os.path.getsize(path) / 1e6
print(f'Size: {size:.0f} MB')
if size < 500:
    raise RuntimeError(f'GGUF too small ({size:.0f} MB) - download may be incomplete')
\"

echo 'Creating Ollama model: ${MODEL_NAME}'
cd /root/phila
ollama create ${MODEL_NAME} -f Modelfile-v5
echo 'Ollama model created'

# Sanity check
ollama list | grep ${MODEL_NAME} && echo 'Model verified in ollama list'
"

echo "--- Starting overnight evaluation campaign on VPS ---"
ssh -o StrictHostKeyChecking=no "$VPS" "
cd /root/phila
MODEL='${MODEL_NAME}'
LOG='${CAMPAIGN_LOG}'

echo \"=== Overnight campaign: \$MODEL === \$(date)\" > \"\$LOG\"

# Phase 1: Benchmark (3 runs)
echo '--- Phase 1: benchmark ---' | tee -a \"\$LOG\"
node --experimental-strip-types test/benchmark.ts --model \"\$MODEL\" --runs 3 >> \"\$LOG\" 2>&1
echo 'Benchmark done' | tee -a \"\$LOG\"

# Phase 2: Fine-tune eval
echo '--- Phase 2: finetune-eval ---' | tee -a \"\$LOG\"
node --experimental-strip-types test/finetune-eval.ts --model \"\$MODEL\" >> \"\$LOG\" 2>&1 || echo 'finetune-eval exited non-zero' | tee -a \"\$LOG\"
echo 'Finetune-eval done' | tee -a \"\$LOG\"

# Phase 3: Continuous optimize (overnight, ~100 iterations)
echo '--- Phase 3: continuous-optimize ---' | tee -a \"\$LOG\"
nohup node --experimental-strip-types test/continuous-optimize.ts --model \"\$MODEL\" --runs 3 --generations 500 >> \"\$LOG\" 2>&1 &
echo \"Continuous optimize PID: \$! - running in background\" | tee -a \"\$LOG\"
echo 'Campaign launched. Monitor: tail -f ${CAMPAIGN_LOG} (on VPS)'
"

echo "=== Deploy complete. Campaign running on VPS ==="
echo "Monitor: ssh root@100.121.215.2 'tail -f ${CAMPAIGN_LOG}'"
