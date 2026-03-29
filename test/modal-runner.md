# Modal Runner Design Stub

## Overview

Modal deployment for phila's optimizer as a secondary GPU platform when Kaggle quota is insufficient.

## Architecture

```
local: modal deploy test/modal_runner.py
       modal run test/modal_runner.py --generations 50

Modal:
  Image: debian + Node 22 + Ollama + phila source files
  GPU: T4 (cheapest, sufficient for llama3.2 3B)
  Volume: /data/phila-checkpoints (persistent across runs)
```

## Implementation Plan

1. `test/modal_runner.py` - Modal app definition
   - `@app.cls(gpu="T4", image=image, volumes={"/data": vol})`
   - Method: `run_optimizer(generations, runs, checkpoint_path)`
   - Copies checkpoint to/from persistent volume

2. Image build:
   - Node 22 via nodesource
   - Ollama install + model pull (cached in image)
   - phila source files embedded (same as Kaggle approach)

3. CLI wrapper:
   - `modal run test/modal_runner.py` with args forwarded to continuous-optimize.ts
   - Downloads checkpoint.json on completion

## Cost Estimate

T4 at $0.59/h. With 101 scenarios x 3 runs x ~1s/inference:
- ~5 min per generation
- 50 generations = ~4h = ~$2.40
- $30 credits = ~600 generations/month

## Prerequisites

- `pip install modal`
- `modal token new` (one-time auth)
- Modal account with free credits
