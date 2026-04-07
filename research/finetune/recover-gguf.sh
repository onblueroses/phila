#!/usr/bin/env bash
# Recovery: merge LoRA adapter + base model, export GGUF, upload to HuggingFace.
# Run on a Vast.ai instance with HF_TOKEN set.
# Usage: bash recover-gguf.sh
set -euo pipefail

HF_TOKEN="${HF_TOKEN:-}"
LORA_REPO="onblueroses/phila-ft-lora"
BASE_MODEL="meta-llama/Llama-3.2-3B-Instruct"
HF_DEST_REPO="onblueroses/phila-ft"
GGUF_NAME="phila-ft-v5-unsloth.Q4_K_M.gguf"
OUT_DIR="/workspace/phila-ft-v5"

echo "=== phila-ft-v5 GGUF recovery ==="
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

echo "=== Installing deps ==="
# Pin torch 2.10.0+cu126 + matching torchvision first, then unsloth
pip install --quiet 'torch==2.10.0' 'torchvision==0.25.0' \
    --index-url https://download.pytorch.org/whl/cu126 2>&1 | tail -2
pip install --quiet 'unsloth==2026.3.18' bitsandbytes huggingface_hub hf_transfer 2>&1 | tail -2
export HF_HUB_ENABLE_HF_TRANSFER=1

if [ -n "$HF_TOKEN" ]; then
    python3 -c "from huggingface_hub import login; login(token='${HF_TOKEN}', add_to_git_credential=True)"
else
    echo "ERROR: HF_TOKEN not set - cannot download gated model"
    exit 1
fi

apt-get install -y cmake g++ libcurl4-openssl-dev libssl-dev 2>&1 | tail -3
python3 -c "
import builtins, unsloth
builtins.input = lambda prompt='': (print('<auto-accept>', flush=True), '')[1]
from unsloth_zoo.llama_cpp import check_llama_cpp, install_llama_cpp
try:
    check_llama_cpp()
    print('llama.cpp already present')
except RuntimeError:
    print('Building llama.cpp...')
    install_llama_cpp()
    print('llama.cpp built OK')
" 2>&1

echo "=== Merging LoRA + base model ==="
python3 << 'PYEOF'
import sys, os
from unsloth import FastLanguageModel
import torch

print("Loading base model + LoRA adapter...")
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="onblueroses/phila-ft-lora",
    max_seq_length=2048,
    dtype=None,
    load_in_4bit=True,
)

print("Exporting GGUF (Q4_K_M)...")
model.save_pretrained_gguf(
    "/workspace/phila-ft-v5",
    tokenizer,
    quantization_method="q4_k_m",
)
print("GGUF export complete")

import glob
gguf_files = glob.glob("/workspace/phila-ft-v5*.gguf") + glob.glob("/workspace/phila-ft-v5*_gguf/*.gguf")
print("GGUF files:", gguf_files)
PYEOF

echo "=== Locating and renaming GGUF ==="
python3 << PYEOF
import glob, os, shutil

candidates = sorted(
    glob.glob('/workspace/phila-ft-v5*.gguf') +
    glob.glob('/workspace/phila-ft-v5*_gguf/*.gguf')
)
if not candidates:
    print("ERROR: no GGUF found", flush=True)
    exit(1)

src = candidates[0]
dst = '/workspace/${GGUF_NAME}'
if src != dst:
    shutil.copy2(src, dst)
    print(f"Copied {src} -> {dst}")
else:
    print(f"GGUF already at {dst}")

size_mb = os.path.getsize(dst) / 1e6
print(f"GGUF size: {size_mb:.0f} MB")
if size_mb < 500:
    print("ERROR: GGUF too small, export failed")
    exit(1)
PYEOF

echo "=== Uploading to HuggingFace: ${HF_DEST_REPO} ==="
python3 << PYEOF
import os
from huggingface_hub import HfApi

token = os.environ.get('HF_TOKEN', '')
api = HfApi(token=token)
repo_id = '${HF_DEST_REPO}'
gguf_path = '/workspace/${GGUF_NAME}'

api.create_repo(repo_id, repo_type='model', private=True, exist_ok=True)
print(f"  Repo ready: {repo_id}")

api.upload_file(
    path_or_fileobj=gguf_path,
    path_in_repo='${GGUF_NAME}',
    repo_id=repo_id,
    repo_type='model',
)
print(f"  Uploaded: ${GGUF_NAME}")

# Upload Modelfile if present
if os.path.isfile('/workspace/Modelfile-v5'):
    api.upload_file(
        path_or_fileobj='/workspace/Modelfile-v5',
        path_in_repo='Modelfile-v5',
        repo_id=repo_id,
        repo_type='model',
    )
    print("  Uploaded: Modelfile-v5")

import json
done = {'status': 'ok', 'gguf': '${GGUF_NAME}', 'hf_repo': repo_id}
with open('/workspace/done.json', 'w') as f:
    json.dump(done, f, indent=2)
print("  done.json written")
print("  HF upload complete")
PYEOF

echo "=== Recovery complete ==="
cat /workspace/done.json
