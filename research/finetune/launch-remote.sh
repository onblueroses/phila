#!/usr/bin/env bash
# Runs on Vast.ai instance via single SSH call.
# Expects VAST_API_KEY and VAST_INSTANCE_ID in environment.
# Installs deps, runs finetune.py, writes done.json, self-destructs.
set -euo pipefail

HF_TOKEN="${HF_TOKEN:-}"

echo "=== Phila fine-tune launch ==="
echo "Instance: ${VAST_INSTANCE_ID}"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

# Quick CUDA sanity check before touching anything
python3 -c "
import ctypes, sys
cuda = ctypes.cdll.LoadLibrary('libcuda.so.1')
ret = cuda.cuInit(0)
if ret != 0:
    print(f'ERROR: cuInit failed with code {ret} (804=forward compat error = broken driver)', file=sys.stderr)
    sys.exit(1)
print('cuInit OK - CUDA driver is functional')
" || { echo 'ABORT: CUDA driver not functional on this machine. Try a different instance.'; exit 1; }

echo "=== Installing Unsloth and deps ==="
# V1 approach: pin torch first so pip dep resolution won't upgrade it.
# conda-installed torch is NOT visible to pip, so without a pin, unsloth's
# dependency (xformers 0.0.35, which requires torch>=2.10) would upgrade torch
# to PyPI torch 2.10.0+cu128, which fails on drivers with max CUDA 12.7 or lower.
#
# Try cu126 whl index first (CUDA 12.6, works on driver 565.77+).
# Fall back to PyPI torch (CUDA 12.8, requires driver 570+) if cu126 not available.
CUDA_VER=$(nvidia-smi --query-gpu=name --format=csv,noheader > /dev/null && \
    python3 -c "import ctypes; c=ctypes.cdll.LoadLibrary('libcuda.so.1'); v=ctypes.c_int(); c.cuDriverGetVersion(ctypes.byref(v)); print(v.value)" 2>/dev/null || echo 0)
echo "Driver max CUDA version code: $CUDA_VER"

if python3 -c "import sys; sys.exit(0 if int('${CUDA_VER}') >= 12080 else 1)" 2>/dev/null; then
    echo "Driver supports CUDA 12.8+ - using PyPI torch 2.10.0"
    pip install --quiet 'torch==2.10.0' 'torchvision>=0.25.0' 2>&1
elif python3 -c "import sys; sys.exit(0 if int('${CUDA_VER}') >= 12060 else 1)" 2>/dev/null; then
    echo "Driver supports CUDA 12.6-12.7 - trying cu126 torch"
    pip install --quiet 'torch==2.10.0' 'torchvision>=0.25.0' \
        --index-url https://download.pytorch.org/whl/cu126 2>&1 || \
    pip install --quiet 'torch==2.10.0' 'torchvision>=0.25.0' 2>&1
else
    echo "WARNING: Driver max CUDA <12.6 - training may fail; trying PyPI torch anyway"
    pip install --quiet 'torch==2.10.0' 'torchvision>=0.25.0' 2>&1
fi

pip install --quiet 'unsloth==2026.3.18' trl peft bitsandbytes accelerate datasets 2>&1

echo "=== Pre-installing llama.cpp deps and building (prevents interactive prompt during GGUF export) ==="
# unsloth's install_llama_cpp calls input() to approve apt packages - must run in foreground, not nohup
apt-get install -y libcurl4-openssl-dev libssl-dev cmake 2>&1 | tail -3
python3 -c "
import builtins, unsloth
builtins.input = lambda prompt='': (print('<auto-accept>', flush=True), '')[1]
from unsloth_zoo.llama_cpp import check_llama_cpp, install_llama_cpp
try:
    check_llama_cpp()
    print('llama.cpp already present')
except RuntimeError:
    print('Building llama.cpp (~3 min)...')
    install_llama_cpp()
    print('llama.cpp built OK')
" 2>&1

python3 -c "
import torch, sys
print('torch version:', torch.__version__)
if not torch.cuda.is_available():
    print('ERROR: CUDA not available - torch CUDA version incompatible with driver', file=sys.stderr)
    sys.exit(1)
print('GPU:', torch.cuda.get_device_name(0))
print('VRAM:', torch.cuda.get_device_properties(0).total_memory / 1e9, 'GB')
import unsloth
print('Unsloth version:', unsloth.__version__)
" || { echo 'ERROR: CUDA/GPU check failed - aborting training'; exit 1; }

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

echo "=== Normalizing training data filename ==="
# Prefer train-v3.jsonl over any pre-existing train.jsonl (older base data)
if [ -f /workspace/train-v3.jsonl ]; then
    mv -f /workspace/train-v3.jsonl /workspace/train.jsonl
    echo "Moved train-v3.jsonl -> train.jsonl ($(wc -l < /workspace/train.jsonl) lines)"
else
    echo "No train-v3.jsonl found, using existing train.jsonl if present"
fi
[ -f /workspace/train.jsonl ] || { echo "ERROR: /workspace/train.jsonl not found"; exit 1; }
echo "Training data: $(wc -l < /workspace/train.jsonl) examples"

echo "=== Setup complete, starting training (nohup) ==="

# Write the teardown wrapper - creds substituted by outer shell at write time
cat > /workspace/run-teardown.sh << EOF
#!/usr/bin/env bash
set -uo pipefail
cd /workspace

echo "Starting fine-tune: \$(date)" >> /workspace/run.log 2>&1
python3 /workspace/finetune.py \
    --data /workspace/train.jsonl \
    --out /workspace/phila-ft-v3 >> /workspace/run.log 2>&1
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
