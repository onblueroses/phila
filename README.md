# phila

A group chat agent whose default state is silence.

Every AI agent in group chats makes the same mistake: it talks too much. Phila is a group chat participant, not an assistant. It observes every message, decides whether to act, and stays silent 95% of the time. When it does speak, it verifies facts against external sources and recalls information from conversation memory. It adapts its behavior per-group based on social feedback - no configuration, no prompting, just learned norms.

**~2,000 lines** of TypeScript. **Local inference** via Ollama - messages never leave your device. **Custom QLoRA fine-tune** (5 iterations) on 4,780 gate-only examples. **95.2% holdout accuracy** on scenarios the model never trained against.

---

## results at a glance

| Version | Model | Holdout Acc | Independent Acc | What changed |
|---------|-------|------------|----------------|--------------|
| Baseline | llama3.2 (stock) | 83.7% | 67.0% | - |
| v1 | phila-ft | 97.6% | - | Buried-thread 0% -> 100% |
| v2 | phila-ft-v2 | 93.0% | 76.7% | v1 regressions fixed |
| v3 | phila-ft-v3 | 93.6% | 93.3% | Generalization gap closed (-19pp -> -0.3pp) |
| v5 | phila-ft-v5 | 94.6% | - | Already-corrected scenarios fixed |
| **v5 + prompt** | **phila-ft-v5 + restructured** | **95.2%** | - | **False speaks 15 -> 4, flat rule structure** |

From a stock 3B model at 67% on real-world-proxy scenarios to a fine-tuned + prompt-engineered system at 95.2% holdout. Five rounds of fine-tuning, each driven by failure analysis of the previous version. A 93-generation prompt optimizer. A 5-layer prompt benchmark. Cross-suite validation against 402 test scenarios across three independent suites.

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

## how it works

Phila runs a continuous observe-decide-act-learn loop:

```
               ┌─────────────────────────────────────────┐
               │            OBSERVE                       │
               │  iMessage watcher polls for new messages │
               │  batcher collects burst, waits 3s quiet  │
               └──────────────┬──────────────────────────┘
                              │
               ┌──────────────▼──────────────────────────┐
               │            DECIDE                        │
               │  speak gate: local LLM evaluates batch   │
               │  95.2% accuracy (custom fine-tuned 3B)   │
               └──────┬─────────────────┬────────────────┘
                      │                 │
               SILENT (95%)        SPEAK (5%)
                      │                 │
               ┌──────▼────┐    ┌───────▼───────────────┐
               │  RECALL   │    │       ACT              │
               │  semantic  │    │  verify claim against  │
               │  memory    │    │  external sources      │
               │  search    │    │  voice filter: enforce │
               │  (embed +  │    │  personality           │
               │  cosine)   │    │  send response         │
               └──────┬─────┘    └───────────────────────┘
                      │
               has relevant facts?
                yes → respond from memory
                 no → stay silent
                              │
               ┌──────────────▼──────────────────────────┐
               │            LEARN                         │
               │  extract facts → embed → store in SQLite │
               │  detect feedback → adjust speak bias     │
               │  prune old messages → summarize context  │
               └─────────────────────────────────────────┘
```

The gate evaluates every batch of messages and almost always returns SILENT. It only speaks when:

- A factual claim is wrong and nobody corrected it
- A factual question went unanswered
- Someone addressed phila directly

Everything else gets silence. Emotional conversations, jokes, banter, small talk, gossip, opinions - phila stays out of it. It never says "great question." It doesn't offer unsolicited advice.

This is harder than it sounds. Language models are trained to respond. Teaching one to not respond - to recognize that the best thing it can do right now is nothing - that's the design challenge.

### tool use

Phila uses two tools in its decision loop:

**Semantic memory recall.** When the gate says SILENT, phila checks whether someone is asking about something discussed earlier. It embeds the message using `nomic-embed-text`, computes cosine similarity against stored fact embeddings in SQLite, and if relevant facts are found, responds from memory. This catches questions like "where are we meeting?" or "who said they'd drive?" without hardcoded patterns - the similarity search generalizes to any recall query.

**Fact verification.** When the gate says SPEAK for a wrong-fact correction, phila verifies the claim against external sources (DuckDuckGo Instant Answer API, Wikipedia) before responding. If the search confirms the correction, it responds with confidence. If it contradicts the LLM's answer, it uses the verified information instead. If search returns nothing, it falls back to the LLM response. The verification never blocks for more than 3 seconds.

### the stack

TypeScript, `@photon-ai/imessage-kit`, Ollama, `better-sqlite3`

| Infrastructure | Value |
|----------------|-------|
| Test scenarios | 146 original + 174 independent + 82 adversarial |
| Unit + integration tests | 224 |
| Architecture iterations | 8 (3 hierarchical, 4 dual-pass, 1 monolithic winner) |
| Optimizer generations | 750+ |
| Fine-tune versions | 5 (v1-v5), 4,780 gate-only examples (v5) |
| Fine-tune GPU | Vast.ai RTX 4090, QLoRA r=16 a=32 |
| Fine-tuned model | [onblueroses/phila-ft-v5-GGUF](https://huggingface.co/onblueroses/phila-ft-v5-GGUF) |
| Optimal inference params | temperature 0.1, topP 0.52, numPredict 64 |

## social learning

Your work chat and your college friends chat have completely different norms. You know this intuitively. Phila learns it - without configuration, without prompting, without being told.

When someone says "thanks phila" or "good one," phila gets slightly more willing to speak in that group. When someone says "not now" or "shut up," that carries 2.5x the weight. This asymmetry is deliberate: people say "thanks" casually, they don't say "shut up" casually.

```
jordan: phila shut up nobody asked
                        → speak bias: -0.05 (quieter in this group)

...later...

alex: thanks phila that was helpful
                        → speak bias: +0.02 (slightly more willing)
```

Over time each group chat develops its own version of phila. The one in your cooking group might speak up about recipes. The one in your sports chat might have learned to stay completely quiet during game threads.

Beyond bias adjustment, phila extracts and stores factual information from conversations (logistics, commitments, preferences) and builds summarized group notes from pruned message history. Each group accumulates its own context that informs future decisions.

All stored locally in SQLite. No cloud, no syncing. The learning stays on your machine, like the conversations it came from.

## privacy

Phila runs a local language model through Ollama. Messages never leave your device. No API calls to OpenAI, no cloud, no telemetry. The only external calls are fact verification lookups against DuckDuckGo and Wikipedia when phila detects a wrong-fact claim - and even those queries contain only the factual claim itself, never the conversation or participants.

Trust comes from the architecture, not a privacy policy.

## building the gate

<details>
<summary>Building the gate</summary>

### the capability wall

The hardest failure was the buried-thread case: someone asks a factual question, five people change the subject, nobody answers. Phila should speak - but didn't.

We validated the speak gate against 146 test scenarios across 9 categories, with a strict train/holdout split. An automated optimizer mutated the prompt and inference parameters over 750+ generations, with statistical significance gating (p < 0.10) and a reward-hacking detector that rolls back anything improving train accuracy while degrading holdout by more than 3%.

Nothing beat the baseline. A dedicated probe across 4 models, 4 prompt variants, and 30 generated scenarios returned 0% pass rate on buried-thread across every combination. No rephrasing moved the needle.

The 3B models don't scan full conversation history when relevant signal is several messages back and recent context is unrelated noise. This is a model capability limitation, not a prompt problem.

### fine-tuning

Fine-tuning fixed it.

QLoRA on a first dataset of 755 targeted examples pushed the buried-thread category from 0% to 100%. But the model regressed hard on three cases it previously handled correctly: standalone unanswered questions, unanswered history questions, and sarcastic wrong-fact detection - all dropping from 100% to 0%. It had specialized too hard in one direction.

The second fine-tune (v2) added 383 examples targeting exactly those three failures on top of the original 755. 1,138 total. All four regression scenarios came back to 100%.

But v2 had a problem: it only reached 80.9% on an independent test suite of 174 scenarios generated by Claude Opus from category definitions alone. The 11pp gap between hand-crafted and independent suites meant the model was learning our specific test patterns, not the general skill.

**v3 fixed the root cause.** We rebuilt the training data from scratch: 3,799 gate-only examples with a 59.3% speak ratio, using Opus-generated scenarios that match the independent suite's distribution. The generalization gap vanished.

| Metric | llama3.2 (base) | phila-ft-v2 | **phila-ft-v3** |
|--------|----------------|-------------|-----------------|
| Original suite accuracy | 86.3% | 90.3% | **93.6%** |
| Independent suite accuracy | 67.0% | 76.7% | **93.3%** |
| Generalization gap | -19.3pp | -13.6pp | **-0.3pp** |
| Recall | 0.446 | 0.612 | **0.890** |
| Precision | 0.983 | 0.984 | **0.994** |

**v5 targeted the last known limitation**: "already corrected" scenarios where someone states a wrong fact but another person already corrected it. Added 70 targeted examples to v3's proven dataset. Then a 93-generation prompt optimizer found the optimal example count (7 worked examples), and research into system prompt patterns from major AI labs led to restructuring the rules as flat NEVER SPEAK / ALWAYS SPEAK blocks instead of nested conditionals.

| Metric | v3 (production baseline) | **v5 + restructured prompt** |
|--------|------------------------|------------------------------|
| Holdout accuracy | 93.6% | **95.2%** |
| Holdout 95% CI | - | **[90.1%, 99.0%]** |
| Precision | 0.957 | **0.983** |
| Recall | 0.865 | **0.912** |
| F1 | 0.909 | **0.946** |
| False speaks | - | **4** |
| "Already corrected" pass rate | flaky | **100%** |

### cross-suite validation (15 runs per config)

| Configuration | Original suite | Independent suite | Generalization gap |
|---------------|---------------|-------------------|-------------------|
| Monolithic (base) | 86.3% | 67.0% | -19.3pp |
| Monolithic ft-v2 | 90.3% | 76.7% | -13.6pp |
| Dual-pass ft-v2 | 91.9% | 80.9% | -11.0pp |
| **Monolithic ft-v3** | **93.6%** | **93.3%** | **-0.3pp** |

The independent suite uses 174 scenarios generated by Claude Opus from category definitions alone - no examples from the original test set. v3 closed the generalization gap almost entirely by training on data that matches the independent distribution.

### what i learned

Silence is easy. Talking at the right time is hard.

Running llama3.2 against the test scenarios, it nails every silence case on the first try - small talk, emotions, jokes, opinions, already-answered questions. Never over-talks. The struggle is the opposite: getting a model that's been told "your default is silence" to override that default when it sees a factual error.

Simplifying the prompt made things worse. Smaller models need more structure, not less. Priority ordering ("ALWAYS SPEAK for these, STAY SILENT for everything else") outperformed percentage-based framing ("stay silent 95% of the time"). Clear rules beat vibes. And the parse-failure-to-silence default is load-bearing - when the model outputs malformed JSON, treating it as silence means the worst failure mode is being too quiet, never too loud.

**Decomposition doesn't work at 3B.** I tried splitting the monolithic gate into stages: a fast classifier ("is this social or does it need attention?") followed by a specialized handler. Three iterations, benchmarked each one. The classifier at numPredict=4 collapsed to 26% recall - it defaulted to "social" when uncertain. A binary filter with the full monolithic prompt as fallback got to 78% accuracy but still lost 16pp vs the monolithic gate. At 3B scale, classification and reasoning are coupled in one pass. Splitting that into separate stages breaks the interconnection the small model relies on.

**Your test suite is lying to you.** The 91.9% accuracy on our hand-crafted test scenarios dropped to 80.8% on an independent suite of 174 scenarios generated by a different model from category definitions alone. An 11pp gap. The hand-crafted scenarios were easier because they came from the same distribution as the gate prompt and fine-tuning data. Cross-suite validation should be standard for any agent eval - single-source test sets overstate real-world performance.

**Small models need examples, not descriptions.** Abstract instructions ("correct wrong facts") fail. Concrete worked examples in the system prompt are what make 3B models work. We tested 5 layers (3 to 11 examples) - 7 is the sweet spot. Below 7, false speaks are high. Above 7, the model goes too silent.

**Flat rules beat nested conditionals.** "Rule 2: correct wrong facts BUT if already corrected STAY SILENT" confused the model. Splitting into "NEVER SPEAK: already corrected" and "ALWAYS SPEAK: wrong fact uncorrected" fixed the longest-standing failure mode.

Full research log and methodology: [FINDINGS.md](FINDINGS.md)

</details>

## setup

**Requirements**: macOS, [Ollama](https://ollama.com), Node.js 22.6+

```bash
# install ollama and pull models
ollama pull llama3.2          # base gate model
ollama pull nomic-embed-text  # embedding model for memory recall

# to use the fine-tuned model (95% gate accuracy vs 84% base):
# download from https://huggingface.co/onblueroses/phila-ft-v5-GGUF
# then: ollama create phila-ft-v5 -f Modelfile

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
| `PHILA_EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model for memory recall |
| `PHILA_OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `PHILA_BATCH_WINDOW` | `3000` | ms to wait for message burst to settle |
| `PHILA_MEMORY_WINDOW` | `50` | number of recent messages to include as context |
| `PHILA_DB_PATH` | `phila.db` | SQLite database path |
| `PHILA_PRUNE_DAYS` | `7` | Auto-delete messages older than N days |
| `PHILA_GATE` | `monolithic` | Gate mode: `monolithic` (single pass), `dual` (monolithic + semantic memory recall) |

</details>

## research infrastructure

`research/` contains the full benchmark and optimization pipeline: adversarial scenario generation, single-elimination tournaments with paired t-tests, multi-model benchmarking, prompt injection resilience testing, context window degradation analysis, and an independent scenario generator. `research/finetune/` has the QLoRA fine-tuning pipeline (Unsloth + Vast.ai). `research/v3-finetune/` has the v3 dataset generation pipeline - corpus transformers, synthetic generators, and a merge/dedup/split tool. Full results and methodology in [FINDINGS.md](FINDINGS.md).

## future directions

- **Proactive recall.** "Hey, you mentioned wanting to try that restaurant last week, they have a special tonight" - initiating from stored context rather than waiting for a trigger. Different trust equation, different gate entirely.
- **Implicit context extraction.** "I can't eat that" doesn't always get extracted as a dietary restriction. The extraction prompt captures explicit facts well but misses implications.
- **Multi-language support.** The gate prompt and training data are English-only. Code-switching in multilingual group chats is a known failure mode (82-scenario adversarial suite confirms this).
- **Larger context windows.** Gate accuracy degrades past 200 messages (tested up to 500). Longer group conversations would benefit from summarization or sliding-window approaches.
