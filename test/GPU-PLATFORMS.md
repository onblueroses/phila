# GPU Platforms for phila Optimization

## Primary: Kaggle (T4 GPU)

- **Quota**: 30h/week GPU, dual T4 available
- **Status**: Working pipeline via `build-kaggle-script.py`
- **Workflow**: `python3 test/build-kaggle-script.py` -> `cd test/kaggle-kernel && kaggle kernels push`
- **Session limit**: 9h per kernel run, checkpoint system handles restarts
- **Pros**: Free, existing pipeline works, automatic checkpointing
- **Cons**: No SSH, output-only, 9h session cap, cold start (~3min for Node + Ollama)

## Evaluated: Modal

- **Quota**: $30/month free credits (new accounts)
- **GPU**: A10G ($1.10/h), T4 ($0.59/h), A100 ($3.25/h)
- **Status**: Not implemented - design stub at `test/modal-runner.md`
- **Pros**: SSH access, persistent volumes, Python-native, faster cold start
- **Cons**: Credits expire, Python deployment wrapper needed, more complex setup
- **Verdict**: Stretch goal - implement if Kaggle quota becomes limiting

## Evaluated: Google Colab

- **Quota**: ~12h/day GPU (T4), throttled after heavy use
- **Pros**: Familiar, notebook UI, easy debugging
- **Cons**: No CLI push, manual interaction needed, unreliable GPU allocation
- **Verdict**: Skip - manual interaction conflicts with autonomous optimization

## Evaluated: Lightning AI

- **Quota**: 22h/month GPU
- **Pros**: Good DX, persistent studios
- **Cons**: 22h/month too little for continuous optimization
- **Verdict**: Skip - insufficient quota

## Recommendation

Use Kaggle as the primary platform. The existing pipeline handles the 9h session limit via checkpointing. 30h/week is sufficient for ~100+ generations per week with 101 scenarios. If more compute is needed, implement the Modal runner as a secondary platform.
