# phila

A group chat agent whose default state is silence.

It runs a local 3B language model, evaluates every message, and stays silent 95% of the time. When 660 prompt mutations couldn't fix its hardest failure mode, we trained a custom model. It works.

**~650 lines** of TypeScript. **Local inference** via Ollama - messages never leave your device. **Custom QLoRA fine-tune** on 1,138 targeted examples. **93% gate accuracy** on a holdout set the model never trained against.

---

## phila in action

**stays silent through normal conversation:**
```
alex: anyone watching the game tonight
jordan: yeah coming over at 7
alex: nice bring chips
jordan: 🫡
                                        → phila: (silent)
```

**speaks up when someone's wrong:**
```
alex: the great wall of china is in japan right
jordan: yeah i think so
                                        → phila: the great wall is in china, not japan
```

**stays out of opinions and emotions:**
```
alex: i think the new star wars movies are terrible
jordan: worst take of all time
alex: fight me
jordan: the originals aren't even that good
alex: blocked
                                        → phila: (silent)
```

## the problem

Every AI agent I've seen in group chats makes the same mistake: it talks too much. You add a bot, it becomes the loudest one in the room. Someone mutes it within a day.

Agents are designed as servants - you ask, they answer. That works in 1:1. A group chat is different. It has its own rhythm, unspoken rules about who talks when. Nobody asked for a personal assistant to join the friend group.

Phila is a group chat participant, not an assistant. Its default state is silence. It speaks roughly 5% of the time - and even that might be too much.

The core is a "speak gate" - it evaluates every batch of messages and almost always returns SILENT. It only speaks when it has something useful to add:

- A factual claim is wrong and nobody corrected it
- A factual question went unanswered
- Someone addressed phila directly

Everything else gets silence. Emotional conversations, jokes, banter, small talk, gossip, opinions, agreement - phila stays out of it. It never says "great question." It doesn't offer unsolicited advice or restate what someone already said.

This is harder than it sounds. Language models are trained to respond. Teaching one to not respond - to recognize that the best thing it can do right now is nothing - that's the design challenge.

## the capability wall

The hardest failure was the buried-thread case: someone asks a factual question, five people change the subject, nobody answers. Phila should speak - but didn't.

We validated the speak gate against 101 test scenarios across 9 categories, with a strict train/holdout split (58 train, 43 holdout). An automated optimizer mutated the prompt and inference parameters over 660+ generations, with statistical significance gating (p < 0.10) and a reward-hacking detector that rolls back anything improving train accuracy while degrading holdout by more than 3%.

Nothing beat the baseline. A dedicated probe across 4 models, 4 prompt variants, and 30 generated scenarios returned 0% pass rate on buried-thread across every combination. No rephrasing moved the needle.

The 3B models don't scan full conversation history when relevant signal is several messages back and recent context is unrelated noise. This is a model capability limitation, not a prompt problem.

## training a custom model

Fine-tuning fixed it.

QLoRA on a first dataset of 755 targeted examples pushed the buried-thread category from 0% to 100%. But the model regressed hard on three cases it previously handled correctly: standalone unanswered questions, unanswered history questions, and sarcastic wrong-fact detection - all dropping from 100% to 0%. It had specialized too hard in one direction.

The second fine-tune added 383 examples targeting exactly those three failures - 150 speak-unanswered, 153 silent-sarcasm, 80 near-miss - on top of the original 755. 1,138 total. RTX 4090, QLoRA r=16, 429 steps, roughly 40 minutes. All four regression scenarios came back to 100% across 10 runs.

| Metric | llama3.2 (base) | phila-ft-v2 (fine-tuned) |
|--------|----------------|--------------------------|
| Gate accuracy (holdout, 43 scenarios) | 87.9% | **93.0%** |
| Gate accuracy (all 101 scenarios) | 94.1% | **95.8%** |
| Response quality | 0.951 | **0.965** |
| Composite score | 0.8487 | **0.8638** |
| Avg latency | 515ms | 544ms |

The whole loop - benchmark, find regressions, build targeted data, retrain, re-benchmark - is what the research pipeline was designed for.

## how it works

```
group chat message arrives
        |
        v
    [batcher] -- collects burst messages, waits 3s for quiet
        |
        v
    [memory] -- stores message, loads conversation window
        |
        v
    [gate] -- local LLM: SILENT or SPEAK?
        |
   SILENT (95%)         SPEAK (5%)
     |                     |
   (nothing)          [voice] -- enforce personality
                           |
                      [send reply]
```

**Stack**: TypeScript, `@photon-ai/imessage-kit`, Ollama, `better-sqlite3`

What went into it:

| Infrastructure | Value |
|----------------|-------|
| Test scenarios | 101 (58 train / 43 holdout) |
| Unit + integration tests | 132 |
| Optimizer generations | 660+ |
| Fine-tune training examples | 1,138 (across 4 targeted categories) |
| Fine-tune GPU | Vast.ai RTX 4090, QLoRA r=16, 429 steps |
| Fine-tuned model | [onblueroses/phila-ft-v2-GGUF](https://huggingface.co/onblueroses/phila-ft-v2-GGUF) |
| Optimal inference params | temperature 0.1, topP 0.52, numPredict 64 |

## social learning

Your work chat and your college friends chat have completely different norms. You know this intuitively. Phila learns it.

When someone says "thanks phila" or "good one," phila gets slightly more willing to speak in that group. When someone says "not now" or "shut up," that carries 2.5x the weight. People say "thanks" casually. They don't say "shut up" casually.

```
jordan: phila shut up nobody asked
                        → speak bias: -0.05 (quieter in this group)

...later...

alex: thanks phila that was helpful
                        → speak bias: +0.02 (slightly more willing)
```

Over time each group chat develops its own version of phila. The one in your cooking group might speak up about recipes. The one in your sports chat might have learned to stay completely quiet during game threads.

All stored locally in SQLite. No cloud, no syncing. The learning stays on your machine, like the conversations it came from.

## privacy

Phila runs a local language model through Ollama. Messages never leave your device. No API calls to OpenAI, no cloud, no telemetry. Trust comes from the architecture, not a privacy policy.

## what i learned

Silence is easy. Talking at the right time is hard.

Running llama3.2 against the test scenarios, it nails every silence case on the first try - small talk, emotions, jokes, opinions, already-answered questions. Never over-talks. The struggle is the opposite: getting a model that's been told "your default is silence" to override that default when it sees a factual error.

Simplifying the prompt made things worse. Smaller models need more structure, not less. Priority ordering ("ALWAYS SPEAK for these, STAY SILENT for everything else") outperformed percentage-based framing ("stay silent 95% of the time"). Clear rules beat vibes. And the parse-failure-to-silence default is load-bearing - when the model outputs malformed JSON, treating it as silence means the worst failure mode is being too quiet, never too loud.

Full research log and methodology: [FINDINGS.md](FINDINGS.md)

## setup

**Requirements**: macOS, [Ollama](https://ollama.com), Node.js 22.6+

```bash
# install ollama and pull the model
ollama pull llama3.2  # base model works out of the box

# to use the fine-tuned model (93% gate accuracy vs 88% base):
# download from https://huggingface.co/onblueroses/phila-ft-v2-GGUF
# then: ollama create phila-ft-v2 -f Modelfile

# clone and install
git clone https://github.com/onblueroses/phila.git && cd phila
npm install

# grant Full Disk Access to your terminal
# system settings > privacy & security > full disk access

# run
npm start
```

<details>
<summary>Configuration (environment variables)</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `PHILA_MODEL` | `llama3.2` | Ollama model name |
| `PHILA_OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `PHILA_BATCH_WINDOW` | `3000` | ms to wait for message burst to settle |
| `PHILA_MEMORY_WINDOW` | `50` | number of recent messages to include as context |
| `PHILA_DB_PATH` | `phila.db` | SQLite database path |
| `PHILA_PRUNE_DAYS` | `7` | Auto-delete messages older than N days |

</details>

## research infrastructure

`research/` contains the full benchmark and optimization pipeline: adversarial scenario generation, single-elimination tournaments with paired t-tests, multi-model benchmarking, prompt injection resilience testing, and context window degradation analysis. `research/finetune/` has the QLoRA fine-tuning pipeline (Unsloth + Vast.ai). Full results and methodology in [FINDINGS.md](FINDINGS.md).

## open questions

- Should phila ever initiate? "Hey, you mentioned wanting to try that restaurant last week, they have a special tonight" - but that's a different trust equation entirely.
- The adversarial category dipped 7pp after v2 fine-tuning. One scenario - wrong facts where someone's name resembles "phila" - remains inconsistent. Unclear if fixable with data or requires a larger model.

More in [FINDINGS.md](FINDINGS.md).
