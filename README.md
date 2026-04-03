# phila

An iMessage group chat agent that stays silent.

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

**answers questions nobody else did:**
```
alex: whats the tallest mountain in the world
jordan: idk
                                        → phila: mount everest, 8849 meters
```

**responds when addressed directly:**
```
jordan: hey phila what year did we land on the moon
                                        → phila: 1969, apollo 11
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

**learns from feedback:**
```
jordan: phila shut up nobody asked
                        → speak bias: -0.05 (quieter in this group)

...later...

alex: thanks phila that was helpful
                        → speak bias: +0.02 (slightly more willing)
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

**Files**:
- `src/gate.ts` - The speak/silent decision engine. System prompt encodes when to speak vs. stay silent, with group-specific behavioral modifiers.
- `src/voice.ts` - Post-processing for personality constraints. Lowercases, caps sentences, strips AI-speak.
- `src/memory.ts` - SQLite persistence. Conversation history, group profiles, social learning feedback loop.
- `src/ollama.ts` - Thin wrapper around Ollama's chat API.
- `src/index.ts` - Watcher, message batcher, pipeline orchestration.

## evaluation

The speak gate is validated against 101 test scenarios across 9 categories and 4 difficulty tiers, with a strict train/holdout split (58 train, 43 holdout) to prevent overfitting. All final numbers come from the holdout set the model never trained against.

| Metric | llama3.2 (base) | phila-ft-v2 (fine-tuned) |
|--------|----------------|--------------------------|
| Gate accuracy (holdout, 43 scenarios) | 87.9% | **93.0%** |
| Gate accuracy (all 101 scenarios) | 94.1% | **95.8%** |
| Response quality | 0.951 | **0.965** |
| Composite score | 0.8487 | **0.8638** |
| Avg latency | 515ms | 544ms |

| Infrastructure | Value |
|----------------|-------|
| Test scenarios | 101 (58 train / 43 holdout) |
| Unit + integration tests | 132 |
| Optimizer generations | 660+ |
| Fine-tune training examples | 1,138 (across 4 targeted categories) |
| Fine-tune GPU | Vast.ai RTX 4090, QLoRA r=16, 429 steps |
| Optimal inference params | temperature 0.1, topP 0.52, numPredict 64 |

An automated optimizer runs mutations against the prompt and inference parameters, scoring each variant on gate accuracy, response quality, and latency. Each candidate is evaluated on train scenarios, then validated against a holdout set it never optimizes against. A paired t-test (p < 0.10) determines statistical significance. A reward-hacking detector watches for holdout degradation and reverts if the holdout drops more than 3% from its peak.

After 660+ generations, no prompt or parameter mutation beat the baseline with statistical significance. The buried-thread weakness (factual questions buried in active thread noise) was confirmed as a model capability limit, not fixable through prompting. That triggered the fine-tuning pipeline.

Response quality is scored on 5 dimensions: topic accuracy (0.35), casualness (0.25), AI-speak absence (0.20), length fit (0.10), and voice survival (0.10). Stratified k-fold cross-validation detects flaky scenarios across runs.

## social learning

Your work chat and your college friends chat have completely different norms. You know this intuitively. Phila learns it.

When someone says "thanks phila" or "good one," phila gets slightly more willing to speak in that group. When someone says "not now" or "shut up," that carries 2.5x the weight. People say "thanks" casually. They don't say "shut up" casually.

Over time each group chat develops its own version of phila. The one in your cooking group might speak up about recipes. The one in your sports chat might have learned to stay completely quiet during game threads.

All stored locally in SQLite. No cloud, no syncing. The learning stays on your machine, like the conversations it came from.

## privacy

Phila runs a local language model through Ollama. Messages never leave your device. No API calls to OpenAI, no cloud, no telemetry.

This thing sits in your most personal conversations, reading messages from your friends. Trust has to come from the architecture, not a privacy policy. Local inference is slower and less capable than cloud APIs. Worth it.

## the voice

When phila does speak, it texts like a person in a group chat:

- lowercase, always
- short - one or two sentences max
- no bullet points, no markdown, no formatting
- no "I'd be happy to help!" or "Great question!"
- can be wrong and says so: "actually not sure about that"
- first person, not third: "i think" not "based on my analysis"

The system prompt handles most of this. A post-processing layer enforces the constraints as a safety net - if the model slips into assistant-speak, it gets caught before sending.

## what i learned

Silence is easy. Talking at the right time is hard.

Running llama3.2 (3B) against the test scenarios, it nails every silence case on the first try - small talk, emotions, jokes, opinions, already-answered questions. Never over-talks. The struggle is the opposite: getting a model that's been told "your default is silence" to override that default when it sees a factual error.

The error correction case broke four prompt iterations. A 3B model doesn't have enough reasoning to both detect a wrong fact and decide to speak. What finally worked: a concrete example in the system prompt showing exactly what a factual error looks like and how to respond. It now catches "the eiffel tower is in london" but misses subtler errors like "the boiling point of water is 50 degrees." Model size limitation, not a prompt problem.

Simplifying the prompt made things worse. My instinct was to trim it down. But smaller models need more structure, not less. Priority ordering ("ALWAYS SPEAK for these, STAY SILENT for everything else") outperformed percentage-based framing ("stay silent 95% of the time"). Clear rules beat vibes.

The third speak rule - answering unanswered questions - was the hardest to get right. A 3B model needs to recognize that "idk" means the question is still open. Abstract instructions didn't work. A concrete example in the prompt ("person1: whats the tallest mountain? / person2: idk / correct response: speak") was what made it click. Small models learn from examples, not descriptions.

The parse-failure-to-silence default is load-bearing. The model sometimes wraps JSON in markdown fences, occasionally outputs malformed responses. Treating any unparseable output as silence means the worst failure mode is being too quiet, never too loud. For something sitting in your group chats, that's the right direction to fail.

The train/holdout split caught a real behavioral gap: the model false-speaks on "already corrected" scenarios - when someone states a wrong fact and another person already corrected them, phila still piles on. A pre-gate heuristic now detects correction patterns ("actually", "nope", "that's wrong") and hints the model to check before correcting.

The hardest failure was the buried-thread case: a factual question asked mid-conversation, then buried by off-topic messages that nobody answered. Phila should speak — but didn't. A dedicated probe across 4 models × 4 prompt variants × 30 generated scenarios returned 0% pass rate across every combination. No rephrasing moved the needle. The 3B models don't scan full conversation history when relevant signal is several messages back and recent context is unrelated noise.

Fine-tuning fixed it. QLoRA on a first dataset of 755 targeted examples pushed the buried-thread category from 0% to 100%. But the model regressed hard on three cases it previously handled correctly: standalone unanswered questions, unanswered history questions, and sarcastic wrong-fact detection — all dropping from 100% to 0%. It had specialised too hard in one direction.

The second fine-tune (`phila-ft-v2`) added 383 purpose-built examples across the three regressed categories (150 speak-unanswered, 153 silent-sarcasm, 80 near-miss), keeping the original 755 as the base — 1,138 total. Trained on an RTX 4090 via Vast.ai (429 steps, ~40 min). All four regression scenarios are now back to 100% across 10 runs. Holdout accuracy sits at 93.0%, up 5.1pp from the untuned baseline.

The iteration loop — benchmark, find regressions, build targeted data, retrain, re-benchmark — is the entire research pipeline in miniature. The fine-tuning infrastructure (`finetune.py`, `launch-remote.sh`, `monitor.sh`, `finetune-eval.ts`) was built to make that loop fast enough to actually run.

## setup

**Requirements**: macOS, [Ollama](https://ollama.com), Node.js 22.6+

```bash
# install ollama and pull the model
# fine-tuned v2 (recommended) — better across all categories
ollama pull llama3.2  # base model, or use phila-ft-v2 if you have it

# to use the fine-tuned model: build from the GGUF in test/research-reports/finetune-data/
# ollama create phila-ft-v2 -f test/research-reports/finetune-data/Modelfile-v2-deploy

# clone and install
git clone https://github.com/onblueroses/phila.git && cd phila
npm install

# grant Full Disk Access to your terminal
# system settings > privacy & security > full disk access

# run
npm start
```

**Configuration** (environment variables):

| Variable | Default | Description |
|----------|---------|-------------|
| `PHILA_MODEL` | `llama3.2` | Ollama model name |
| `PHILA_OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `PHILA_BATCH_WINDOW` | `3000` | ms to wait for message burst to settle |
| `PHILA_MEMORY_WINDOW` | `50` | number of recent messages to include as context |
| `PHILA_DB_PATH` | `phila.db` | SQLite database path |
| `PHILA_PRUNE_DAYS` | `7` | Auto-delete messages older than N days |

## research infrastructure

`test/research/` contains the full benchmark and optimization pipeline used to validate the gate:

- `overnight-campaign.sh` — orchestrates multi-round prompt optimization: adversarial scenario generation → mutation generation → tournament → report
- `tournament.ts` — single-elimination tournament with paired t-test (p < 0.10) significance gating
- `gen-adversarial.ts` — generates adversarial test scenarios via LLM, targeting known failure categories
- `gen-prompt-mutations.ts` — generates targeted prompt mutations based on failure patterns
- `model-compare.ts` — benchmarks multiple Ollama models against the baseline prompt
- `buried-thread-probe.ts` — targeted probe of the buried-thread weakness across models and prompt variants
- `gen-finetune-data.ts` — generates labeled training data (JSONL) for fine-tuning
- `FINDINGS.md` — cumulative research log with all benchmark results

`test/finetune-remote/` — QLoRA fine-tuning pipeline:

- `finetune.py` — Unsloth QLoRA training script (reads `train.jsonl`, exports GGUF via `save_pretrained_gguf`)
- `launch-remote.sh` — remote launch script: installs deps, runs training, self-destructs instance on completion
- `monitor.sh` — local polling monitor: waits for completion, downloads GGUF + Modelfile

`test/finetune-eval.ts` — three-analysis eval comparing fine-tuned vs baseline: holdout accuracy, composite scoring, and regression deep-dive.

`test/eval-shared.ts` — shared `evaluate()`, `pairedTTest()`, and reward-hacking detection used across all benchmark scripts.

## open questions

- How should phila handle being wrong? It can say "not sure about that," but it doesn't track its own accuracy or learn from corrections.
- What's the right memory window? 50 messages might be too few for slow chats and too many for rapid-fire ones.
- Should phila ever initiate? Right now it only reacts. "hey, you mentioned wanting to try that restaurant last week, they have a special tonight" - but that's a different trust equation entirely.
- Can the silence rate emerge from the feedback loop instead of being hardcoded? Let each group find its own tolerance.
- The adversarial category dipped 7pp after v2 fine-tuning. One specific scenario — wrong facts in messages where someone's name resembles "phila" — remains inconsistent. It requires the model to do two things at once: detect a factual error and not confuse the name with a direct address. Unclear if this is fixable with data or requires a larger model.
