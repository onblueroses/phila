#!/usr/bin/env bash
# Runs on Vast.ai instance via single SSH call.
# Expects VAST_API_KEY and VAST_INSTANCE_ID in environment.
# Installs deps, runs finetune.py, writes done.json, self-destructs.
set -euo pipefail

HF_TOKEN="${HF_TOKEN:-}"

echo "=== Phila fine-tune launch ==="
echo "Instance: ${VAST_INSTANCE_ID}"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

echo "=== Installing Unsloth and deps (minimal - pytorch image already has torch/triton) ==="
# No xformers extras - the pytorch:2.2.0 image already has torch+triton+cuda
pip install --quiet unsloth trl peft bitsandbytes accelerate datasets

echo "=== HuggingFace setup ==="
if [ -n "$HF_TOKEN" ]; then
    pip install --quiet huggingface_hub hf_transfer
    export HF_HUB_ENABLE_HF_TRANSFER=1
    huggingface-cli login --token "$HF_TOKEN" --add-to-git-credential
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

echo "=== Setup complete, starting training (nohup) ==="

# Write the teardown wrapper - creds substituted by outer shell at write time
cat > /workspace/run-teardown.sh << EOF
#!/usr/bin/env bash
set -uo pipefail
cd /workspace

echo "Starting fine-tune: \$(date)" >> /workspace/run.log 2>&1
python3 /workspace/finetune.py \
    --data /workspace/train.jsonl \
    --out /workspace/phila-ft >> /workspace/run.log 2>&1
EXIT_CODE=\$?

echo "Fine-tune exited with code \$EXIT_CODE: \$(date)" >> /workspace/run.log 2>&1

if [ \$EXIT_CODE -ne 0 ]; then
    echo '{"status":"failed","exit_code":'\$EXIT_CODE'}' > /workspace/done.json
fi

# Destroy instance (billing stops immediately)
curl -s -X DELETE "https://console.vast.ai/api/v0/instances/${VAST_INSTANCE_ID}/?api_key=${VAST_API_KEY}" \
    >> /workspace/run.log 2>&1 \
    || echo "WARNING: destroy failed - manual cleanup needed" >> /workspace/run.log 2>&1
EOF

chmod +x /workspace/run-teardown.sh
mkdir -p /workspace/checkpoints

nohup bash /workspace/run-teardown.sh </dev/null >> /workspace/run.log 2>&1 &
echo "Training PID: $! - SSH session done, training running in background"
echo "Monitor: vastai copy C.${VAST_INSTANCE_ID}:/workspace/done.json ./"
