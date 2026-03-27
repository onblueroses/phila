#!/bin/bash
# Colab GPU setup for phila optimizer.
# Usage in Colab:
#   Cell 1: !bash test/colab-setup.sh
#   Cell 2: !node --experimental-strip-types test/continuous-optimize.ts --runs 5 --generations 100

set -euo pipefail

echo "=== Installing Node 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version

echo "=== Installing Ollama ==="
curl -fsSL https://ollama.com/install.sh | sh

echo "=== Starting Ollama server ==="
ollama serve &
sleep 3

echo "=== Pulling llama3.2 ==="
ollama pull llama3.2

echo "=== Installing npm dependencies ==="
npm install

echo "=== Ready ==="
echo "Run: node --experimental-strip-types test/continuous-optimize.ts --runs 5 --generations 100"
