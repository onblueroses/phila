#!/usr/bin/env bash
# Runs on Vast.ai instance via single SSH call.
# Expects VAST_API_KEY and VAST_INSTANCE_ID in environment.
# Installs deps, runs finetune.py, writes done.json, self-destructs.
set -euo pipefail

HF_TOKEN="${HF_TOKEN:-}"

echo "=== Phila fine-tune launch ==="
echo "Instance: ${VAST_INSTANCE_ID}"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

echo "=== Pinning torch to 2.10.0 (unsloth requires >=2.4.0,<2.11.0) ==="
pip install --quiet 'torch==2.10.0' 'torchvision>=0.25.0'

echo "=== Installing Unsloth and deps (pinned to v1 versions) ==="
pip install --quiet 'unsloth==2026.3.18' trl peft bitsandbytes accelerate datasets

echo "=== HuggingFace setup ==="
if [ -n "$HF_TOKEN" ]; then
    pip install --quiet huggingface_hub hf_transfer
    export HF_HUB_ENABLE_HF_TRANSFER=1
    export HUGGING_FACE_HUB_TOKEN="$HF_TOKEN"
    # huggingface-cli may not be in PATH immediately after pip install
    python3 -c "from huggingface_hub import login; login(token='${HF_TOKEN}', add_to_git_credential=True)"
else
    echo "WARNING: No HF_TOKEN set - model download may fail for gated repos"
fi

echo "=== Verifying GPU ==="
python3 -c "
import torch
assert torch.cuda.is_available(), 'No CUDA GPU found'
print('GPU:', torch.cuda.get_device_name(0))
print('VRAM:', torch.cuda.get_device_properties(0).total_memory / 1e9, 'GB')
"

echo "=== Normalizing training data filename ==="
# scp preserves source basename; standardize to train.jsonl
if [ -f /workspace/train-v2.jsonl ] && [ ! -f /workspace/train.jsonl ]; then
    mv /workspace/train-v2.jsonl /workspace/train.jsonl
    echo "Renamed train-v2.jsonl -> train.jsonl"
fi
[ -f /workspace/train.jsonl ] || { echo "ERROR: /workspace/train.jsonl not found"; exit 1; }

echo "=== Setup complete, starting training (nohup) ==="

# Write the teardown wrapper - creds substituted by outer shell at write time
cat > /workspace/run-teardown.sh << EOF
#!/usr/bin/env bash
set -uo pipefail
cd /workspace

echo "Starting fine-tune: \$(date)" >> /workspace/run.log 2>&1
python3 /workspace/finetune.py \
    --data /workspace/train.jsonl \
    --out /workspace/phila-ft-v2 >> /workspace/run.log 2>&1
EXIT_CODE=\$?

echo "Fine-tune exited with code \$EXIT_CODE: \$(date)" >> /workspace/run.log 2>&1

if [ \$EXIT_CODE -ne 0 ]; then
    echo '{"status":"failed","exit_code":'\$EXIT_CODE'}' > /workspace/done.json
fi

# Upload GGUF to HuggingFace before destroying (token baked in at write time)
if [ \$EXIT_CODE -eq 0 ]; then
    HF_TOKEN_VAL="${HF_TOKEN}" python3 -c "
import glob, json, os, sys
from huggingface_hub import HfApi
token = os.environ.get('HF_TOKEN_VAL', '')
if not token:
    print('  WARNING: no HF token, skipping upload')
    sys.exit(0)
try:
    api = HfApi(token=token)
    username = api.whoami()['name']
    repo_id = username + '/phila-ft'
    print('=== Uploading to HuggingFace: ' + repo_id + ' ===')
    api.create_repo(repo_id, repo_type='model', private=True, exist_ok=True)
    print('  Repo ready')
    gguf_files = sorted(glob.glob('/workspace/phila-ft*.gguf'))
    if gguf_files:
        gguf = gguf_files[0]
        api.upload_file(path_or_fileobj=gguf, path_in_repo=os.path.basename(gguf), repo_id=repo_id, repo_type='model')
        print('  Uploaded: ' + os.path.basename(gguf))
    else:
        print('  WARNING: no GGUF found in /workspace')
    if os.path.exists('/workspace/Modelfile'):
        api.upload_file(path_or_fileobj='/workspace/Modelfile', path_in_repo='Modelfile', repo_id=repo_id, repo_type='model')
        print('  Uploaded: Modelfile')
    with open('/workspace/done.json') as f: d = json.load(f)
    d['hf_repo'] = repo_id
    with open('/workspace/done.json', 'w') as f: json.dump(d, f, indent=2)
    print('  done.json updated: hf_repo=' + repo_id)
    print('  HF upload complete')
except Exception as e:
    print('  WARNING: HF upload error: ' + str(e))
" >> /workspace/run.log 2>&1 || true
fi

# Self-destruct disabled for diagnostics - monitor handles teardown
echo "Training+upload complete. Waiting for monitor to download and destroy." >> /workspace/run.log 2>&1
# curl -s -X DELETE "https://console.vast.ai/api/v0/instances/${VAST_INSTANCE_ID}/?api_key=${VAST_API_KEY}" \
#     >> /workspace/run.log 2>&1 \
#     || echo "WARNING: destroy failed - manual cleanup needed" >> /workspace/run.log 2>&1
EOF

chmod +x /workspace/run-teardown.sh
mkdir -p /workspace/checkpoints

nohup bash /workspace/run-teardown.sh </dev/null >> /workspace/run.log 2>&1 &
echo "Training PID: $! - SSH session done, training running in background"
echo "Monitor: vastai copy C.${VAST_INSTANCE_ID}:/workspace/done.json ./"
