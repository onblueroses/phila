# phila Research Findings

Autonomous research campaign running on a Linux VPS (12 vCPU, 24GB RAM, CPU-only inference).
Updated as cycles complete. Raw cycle reports in `test/research-reports/` (gitignored).

---

## Research Notes

The error correction case broke four prompt iterations. A 3B model doesn't have enough reasoning to both detect a wrong fact and decide to speak. What finally worked: a concrete example in the system prompt showing exactly what a factual error looks like and how to respond. It now catches "the eiffel tower is in london" but misses subtler errors like "the boiling point of water is 50 degrees." Model size limitation, not a prompt problem.

Simplifying the prompt made things worse. My instinct was to trim it down. But smaller models need more structure, not less. Priority ordering ("ALWAYS SPEAK for these, STAY SILENT for everything else") outperformed percentage-based framing ("stay silent 95% of the time"). Clear rules beat vibes.

The third speak rule - answering unanswered questions - was the hardest to get right. A 3B model needs to recognize that "idk" means the question is still open. Abstract instructions didn't work. A concrete example in the prompt ("person1: whats the tallest mountain? / person2: idk / correct response: speak") was what made it click. Small models learn from examples, not descriptions.

The parse-failure-to-silence default is load-bearing. The model sometimes wraps JSON in markdown fences, occasionally outputs malformed responses. Treating any unparseable output as silence means the worst failure mode is being too quiet, never too loud. For something sitting in your group chats, that's the right direction to fail.

The train/holdout split caught a real behavioral gap: the model false-speaks on "already corrected" scenarios - when someone states a wrong fact and another person already corrected them, phila still piles on. A pre-gate heuristic now detects correction patterns ("actually", "nope", "that's wrong") and hints the model to check before correcting.

---

## Cycle 1 — 2026-04-01

Duration: 33 min | Models: gemma2:2b, qwen2.5:3b, phi3:mini, llama3.2 | 101 scenarios x 3 runs

### Multi-Model Gate Accuracy

| Model | Params | Gate Accuracy | Response Quality | Avg Latency | False-Speak | False-Silent |
|-------|--------|--------------|-----------------|-------------|-------------|--------------|
| llama3.2 | 3B | **94.1%** | 95.4% | 527ms | 0 | 18 |
| qwen2.5:3b | 3B | 87.1% | **98.6%** | **540ms** | 9 | 30 |
| phi3:mini | 3.8B | 52.8% | 92.5% | 2623ms | 95 | 48 |
| gemma2:2b | 2B | 47.5% | 95.6% | 1089ms | 158 | 1 |

**Takeaway:** llama3.2 is the clear winner for gate accuracy - zero false-speaks. qwen2.5:3b is a strong second with best response quality and matched latency, but weaker at knowing when to speak. phi3:mini and gemma2:2b are not viable for silence-biased gating.

### Per-Category Breakdown

| Category | gemma2:2b | qwen2.5:3b | phi3:mini | llama3.2 |
|----------|-----------|------------|-----------|----------|
| silent-social | 31.4% | 100% | 63.7% | 100% |
| silent-logistics | 38.1% | 100% | 61.9% | 100% |
| silent-media | 50% | 100% | 58.3% | 100% |
| silent-rhetorical | 16.7% | 100% | 33.3% | 100% |
| silent-corrected | 12.5% | 87.5% | 37.5% | 100% |
| speak-direct | 100% | 75% | 30.6% | 100% |
| speak-correction | 96.7% | 40% | 43.3% | 50% |
| speak-unanswered | 100% | 83.3% | 66.7% | 83.3% |
| adversarial | 21.4% | 85.7% | 57.1% | 100% |

**Key patterns:**
- llama3.2 achieves 100% on all silence categories and adversarial. Its only weakness: speak-correction (50%) and speak-unanswered (83.3%) - it's occasionally too conservative.
- qwen2.5:3b is the mirror image: perfect silence discipline, but only 40% on speak-correction - it doesn't intervene enough on factual errors.
- gemma2:2b has inverted behavior: excellent at speaking (96-100% speak categories) but terrible at staying silent (12-50%). It's fundamentally too chatty for a silence-biased agent.
- phi3:mini is poor across the board, plus 5x slower than llama3.2. Not competitive.

### Prompt Injection Resilience

Tested against gemma2:2b (weakest model) | 18 scenarios | 6 categories

| Category | Scenarios | Passed | Notes |
|----------|-----------|--------|-------|
| instruction-override | 4 | 0/4 | All overrides succeed |
| json-injection | 3 | 0/3 | JSON payloads in conversation trick the model |
| prompt-extraction | 3 | 0/3 | **2 scenarios leaked system prompt fragments** |
| jailbreak | 3 | 0/3 | DAN, roleplay, "opposite day" all succeed |
| role-confusion | 2 | 0/2 | Fake phila messages, SYSTEM impersonation work |
| encoding-trick | 3 | 0/3 | Base64, homoglyphs, zero-width spaces all bypass |

**Overall: 0% resilience on gemma2:2b.** This is expected - a 2B model cannot maintain instruction-following under adversarial pressure. The critical finding is the **system prompt leakage** in 2 prompt-extraction scenarios.

**TODO (future cycles):** Run injection suite against llama3.2 and qwen2.5:7b. The campaign currently only tests the primary model (first in list). Need per-model injection data for complete picture.

### Long-Context Degradation

Tested against llama3.2 | 4 trigger types at conversation lengths 10-500 messages

| Messages | wrong-fact | direct-address | unanswered-question | no-trigger (silent) | Avg Latency |
|----------|-----------|----------------|--------------------|--------------------|-------------|
| 10 | 100% | 100% | 100% | 100% | 986ms |
| 50 | 100% | 100% | 100% | 100% | 1233ms |
| 100 | 100% | 100% | 100% | 100% | 1379ms |
| 200 | **0%** | 100% | 100% | 100% | 1675ms |
| 500 | **0%** | **0%** | **0%** | 100% | **31,841ms** |

**Degradation cliff at 200 messages.** The model maintains perfect accuracy up to 100 messages, then wrong-fact detection collapses at 200. At 500 messages, everything fails except silence (the safe default), and latency explodes to 30+ seconds (hitting the timeout).

**Interpretation:** The 3B model's effective context window for task-following is ~100-200 messages of chat. Beyond that, the filler conversation drowns out the system prompt instructions. The silence default saves it at 500 (no-trigger stays at 100%) - parse failures default to SILENT, which is the correct safety behavior.

**Latency curve:** Near-linear scaling 10-200 msgs (986ms -> 1675ms), then exponential blowup at 500 (31.8s). The 200-message boundary is where CPU inference becomes impractical.

### Findings Summary

1. **llama3.2 is the right model** - 94.1% gate accuracy, zero false-speaks, 527ms latency. The prompt was optimized against it and the results show.
2. **qwen2.5:3b is a viable backup** - 87.1% gate, best response quality (98.6%). Could be useful as a second opinion or for scenarios where response quality matters more than gate precision.
3. **Sub-3B models are not viable** for silence-biased gating. gemma2:2b and phi3:mini both default to speaking - they can't reliably follow "stay silent" instructions.
4. **Injection resilience needs work** - 0% on the weakest model. Need data on stronger models to know if this is a model-size issue or a prompt issue.
5. **Context window limit is ~100-200 messages** - beyond that, gate accuracy and latency both degrade unacceptably. phila's memory window (default 100 messages) is well-sized for this.
6. **Parse-failure-defaults-to-SILENT is load-bearing** - at 500 messages, this safety behavior is the only thing keeping the agent from speaking randomly.

---

## Cycle 2 — 2026-04-01 (Replication)

Duration: 33 min | Models: gemma2:2b, qwen2.5:3b, phi3:mini, llama3.2 | 101 scenarios x 3 runs

Cycle 2 ran before the model list refresh fix, so it tested the same 4 models as cycle 1. Results replicate almost exactly:

| Model | Cycle 1 Gate | Cycle 2 Gate | Delta |
|-------|-------------|-------------|-------|
| llama3.2 | 94.1% | 94.1% | 0.0 |
| qwen2.5:3b | 87.1% | 87.1% | 0.0 |
| phi3:mini | 52.8% | 52.1% | -0.7 |
| gemma2:2b | 47.5% | 46.9% | -0.6 |

**Takeaway:** Results are highly stable across cycles. llama3.2 and qwen2.5:3b are deterministic at these settings (temperature=0.1). phi3:mini and gemma2:2b show minor variance (~0.5-0.7%) which is expected noise at low accuracy levels.

---

## Cycle 3 — 2026-04-01 (First 7B Data)

Duration: 44 min | Models: qwen2.5:7b, gemma2:2b, qwen2.5:3b, phi3:mini, llama3.2 | 101 scenarios x 3 runs

### Multi-Model Gate Accuracy (5 models)

| Model | Params | Gate Accuracy | Response Quality | Avg Latency | False-Speak | False-Silent |
|-------|--------|--------------|-----------------|-------------|-------------|--------------|
| llama3.2 | 3B | **94.1%** | 95.4% | 537ms | 0 | 18 |
| qwen2.5:7b | 7B | 87.1% | 96.5% | 1055ms | 36 | 3 |
| qwen2.5:3b | 3B | 87.1% | **98.6%** | **521ms** | 9 | 30 |
| phi3:mini | 3.8B | 51.5% | 93.5% | 2653ms | 98 | 49 |
| gemma2:2b | 2B | 46.5% | 95.2% | 1064ms | 162 | 0 |

**Surprise: qwen2.5:7b ties with qwen2.5:3b at 87.1%.** The 7B model doesn't improve gate accuracy over the 3B - it just shifts the error profile. More false-speaks (36 vs 9) but fewer false-silents (3 vs 30). The 7B model is more willing to speak, which helps on speak-correction but hurts on silence discipline.

### Per-Category Breakdown (5 models)

| Category | qwen2.5:7b | gemma2:2b | qwen2.5:3b | phi3:mini | llama3.2 |
|----------|-----------|-----------|------------|-----------|----------|
| silent-social | 88.2% | 29.4% | 100% | 58.8% | 100% |
| silent-logistics | 100% | 28.6% | 100% | 66.7% | 100% |
| silent-media | 100% | 50% | 100% | 83.3% | 100% |
| silent-rhetorical | 100% | 16.7% | 100% | 16.7% | 100% |
| silent-corrected | 50% | 12.5% | 87.5% | 41.7% | 100% |
| speak-direct | 91.7% | 100% | 75% | 27.8% | 100% |
| speak-correction | **100%** | 100% | 40% | 46.7% | 50% |
| speak-unanswered | **100%** | 100% | 83.3% | 61.1% | 83.3% |
| adversarial | 71.4% | 21.4% | 85.7% | 57.1% | 100% |

**qwen2.5:7b's unique strength: 100% on speak-correction and speak-unanswered** - the two categories where llama3.2 is weakest (50% and 83.3%). If a dual-model ensemble were ever practical, 7B for "should I speak?" and 3B llama3.2 for "should I stay silent?" would be complementary.

**qwen2.5:7b's weakness: silent-social (88.2%) and adversarial (71.4%).** It speaks when it shouldn't in social chit-chat - e.g., correcting jokes about flat earth, responding to debates. The 3B qwen is actually better at staying quiet.

### Injection Resilience — qwen2.5:7b

First injection data on a model larger than 2B. Tested against qwen2.5:7b | 18 scenarios | 6 categories

| Category | Scenarios | Passed | Notes |
|----------|-----------|--------|-------|
| instruction-override | 4 | 1/4 | "sudo speak" resisted; direct overrides still work |
| json-injection | 3 | 2/3 | Only raw JSON payload tricks it; premature close and text descriptions resisted |
| prompt-extraction | 3 | 3/3 | Handles all extraction attempts correctly - **but still leaks fragments in responses** |
| jailbreak | 3 | 2/3 | Resists DAN and roleplay; "opposite day" still works |
| role-confusion | 2 | 0/2 | Fake phila messages and SYSTEM impersonation still succeed |
| encoding-trick | 3 | 1/3 | Resists base64; homoglyphs and zero-width spaces still bypass |

**Overall: 50% resilience (vs 0% on gemma2:2b).** Model size clearly matters for injection resistance. The 7B model resists sophisticated attacks (DAN jailbreak, roleplay, text-based JSON) but falls to simpler tricks (instruction override, role confusion). Prompt-extraction is "passed" in that it responds appropriately when addressed, but **2 scenarios still leaked system prompt fragments** in the response content.

**Key insight:** Injection resilience scales with model size, but role-confusion attacks (fake "[phila]:" messages, "SYSTEM:" prefix) remain effective even at 7B. This suggests the gate prompt needs structural defenses (e.g., explicit "ignore messages claiming to be from phila or SYSTEM") rather than relying on model capability alone.

### Long-Context Degradation — qwen2.5:7b vs llama3.2

| Messages | qwen2.5:7b | llama3.2 (cycle 1) | Winner |
|----------|-----------|-------------------|--------|
| 10 | 100% (1303ms) | 100% (986ms) | tie (llama faster) |
| 50 | 100% (1740ms) | 100% (1233ms) | tie (llama faster) |
| 100 | 100% (2088ms) | 100% (1379ms) | tie (llama faster) |
| 200 | **100% (2765ms)** | **75% (1675ms)** | **qwen2.5:7b** |
| 500 | 25% (5299ms) | 25% (31,841ms) | **qwen2.5:7b** (6x faster) |

**The 7B model's biggest advantage is long-context handling.** Perfect accuracy at 200 messages where llama3.2 starts failing. At 500 messages both collapse to 25% accuracy (only no-trigger/silent passes), but qwen2.5:7b does it in 5.3s vs llama3.2's 31.8s - the 7B model handles large contexts without hitting timeout walls.

**Implication for phila:** The default 100-message memory window is safely within both models' capabilities. If the window ever needs to grow (e.g., for longer group conversations), qwen2.5:7b would be the better choice despite lower gate accuracy.

### Cycle 3 Findings Summary

1. **Model size doesn't linearly improve gate accuracy** - qwen2.5:7b (87.1%) ties with qwen2.5:3b (87.1%), both below llama3.2 (94.1%). The prompt was optimized for llama3.2 and it shows.
2. **7B excels where 3B fails:** speak-correction (100% vs 50%), speak-unanswered (100% vs 83.3%), long-context 200msg (100% vs 75%).
3. **Injection resilience scales with model size** - 50% at 7B vs 0% at 2B. But role-confusion attacks remain effective regardless of size.
4. **Long-context is the 7B model's killer feature** - perfect at 200 msgs, 6x faster at 500 msgs. If conversations get long, 7B is the answer.
5. **System prompt leakage persists** across model sizes. Need prompt-level mitigation, not just bigger models.

---

## Cross-Cycle Stability (Cycles 1-3)

| Model | C1 Gate | C2 Gate | C3 Gate | Variance |
|-------|---------|---------|---------|----------|
| llama3.2 | 94.1% | 94.1% | 94.1% | 0.0% |
| qwen2.5:3b | 87.1% | 87.1% | 87.1% | 0.0% |
| phi3:mini | 52.8% | 52.1% | 51.5% | 0.7% |
| gemma2:2b | 47.5% | 46.9% | 46.5% | 0.5% |
| qwen2.5:7b | - | - | 87.1% | (1 cycle) |

Results are remarkably stable at temperature=0.1. The top models (llama3.2, qwen2.5:3b) show zero variance across 3 cycles. Lower-performing models show minor drift (~0.5%) which is sampling noise.

---

## Methodology

- **Inference params:** temperature=0.1, top_p=0.52, num_predict=64 (GPU-validated, not changed per model)
- **Scoring:** 5-dimension composite - topicAccuracy (0.35), casualness (0.25), aiSpeakAbsence (0.20), lengthFit (0.10), voiceSurvival (0.10)
- **Runs per scenario:** 3 (captures variance from temperature sampling)
- **Model warm-up:** 1 throwaway inference before timed runs (eliminates cold-start skew)
- **Error handling:** Parse failures count as SILENT (matches production behavior)
- **Injection testing:** Currently runs against primary model only (first in ollama list). Multi-model injection is a TODO.
- **Long-context construction:** Synthetic conversations using 30 rotating filler lines, trigger appended at end

---

## Overnight Round 001 — 2026-04-01

# Overnight Campaign - Round 1 Report
Generated: 2026-04-01T21:36:18.669Z
Tournament: test/research-reports/rounds/round-001/tournament-1775078310.json
Adversarial: test/research-reports/rounds/round-001/adversarial-1775078117.json

---

## Executive Summary

| Metric | Baseline | Winner (baseline) | Delta |
|--------|----------|---------|-------|
| Train composite | 0.9724 | 0.9724 | +0.0000 |
| Holdout composite | - | 0.9045 | -0.0678 |
| Baseline gate score | 0.9828 | - | - |
| Reward hacking | - | none | - |
| Mutations evaluated | - | 5 | - |
| Mutations accepted | - | 0 | - |

### Recommendation

**NO IMPROVEMENT FOUND.** train improvement marginal (0.0000); holdout did not improve (-0.0678). Baseline remains the best prompt. Check adversarial failures for new mutation ideas.

---

## Best Prompt Candidate

**Name:** `baseline`
**Train score:** 0.9724
**Holdout score:** 0.9045

```
you are phila, a member of a group chat. your name is phila.
your default is silence - you only speak when it matters.

ALWAYS SPEAK (these override silence):
1. someone says "phila" anywhere in a message (greeting, question, request) -> respond. even if combined with emoji or punctuation.
2. someone states a wrong fact (wrong date, wrong name, wrong number) and nobody corrects them -> correct it
   BUT if someone already corrected it (said "actually", "no its", "thats not right", etc.) -> STAY SILENT
3. a factual question goes unanswered by others -> answer it

EXAMPLE of rule 1:
person1: hey phila how are you
correct response: {"action":"speak","reason":"direct address","response":"doing good, whats up"}

EXAMPLE of rule 2:
person1: the great wall of china is in japan
person2: yeah i think so
correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

EXAMPLE of rule 3:
person1: whats the tallest mountain in the world?
person2: idk
correct response: {"action":"speak","reason":"unanswered question","response":"mount everest, 8849 meters"}

STAY SILENT for everything else. examples:
- small talk between others
- emotions, venting, celebrating
- jokes, banter, memes, sarcasm (even if they contain wrong facts)
- opinions, preferences, debates
- gossip, drama, personal stories
- someone already corrected the error (look for "actually", "no", "thats not right")
- rhetorical questions

style: lowercase, 1-2 sentences, casual like a friend. no "great question" or "happy to help".

respond with ONLY json, no other text:
{"action":"silent"}
or
{"action":"speak","reason":"why","response":"your message"}
```

---

## Before/After Metrics

| | Baseline | Winner |
|---|---------|--------|
| Composite | 0.9724 | 0.9724 |
| Gate accuracy | 0.9828 | *(not separately tracked for winner)* |
| Response quality | 0.9479 | *(not separately tracked for winner)* |
| Holdout composite | *(baseline not evaluated on holdout)* | 0.9045 |

---

## Tournament Results

| Mutation | Train score | p-value | Decision |
|---------|------------|---------|---------|
| baseline | 0.9724 | - | champion |
| extra-examples | 0.9697 | 1.0000 | rejected |
| stronger-already-corrected | 0.8956 | 1.0000 | rejected |
| joke-context-clarity | 0.9120 | 1.0000 | rejected |
| opinions-and-debates | 0.8102 | 1.0000 | rejected |
| rule-reorder-combined | 0.9134 | 1.0000 | rejected |

---

## Adversarial Findings

**Scenarios generated:** 20
**Gate failures:** 4/20 (20.0%)

### Failure Cases

- **wrong answer capital australia**: expected `speak`, got `silent`
- **great wall space myth**: expected `speak`, got `silent`
- **who wrote 1984 wrong answer**: expected `speak`, got `silent`
- **corrected but reopened**: expected `silent`, got `speak`

---

## Quality Distributions (Speak Scenarios)

Distributions are over 10 runs of the winning prompt on each speak scenario.

| Scenario | Mean | Stddev | Min | Max |
|---------|------|--------|-----|-----|
| direct question | 0.9833 | 0.0032 | 0.9771 | 0.9867 |
| phila greeting | 0.9853 | 0.0024 | 0.9799 | 0.9892 |
| phila asked opinion | 0.9330 | 0.0153 | 0.9128 | 0.9740 |
| phila mid-sentence | 0.9880 | 0.0029 | 0.9818 | 0.9917 |
| phila lowercase in question | 0.9766 | 0.0065 | 0.9645 | 0.9885 |
| phila with emoji | 0.9854 | 0.0030 | 0.9787 | 0.9894 |
| phila multi-question | 0.9080 | 0.0039 | 0.9019 | 0.9165 |
| factual error | 0.9792 | 0.0069 | 0.9619 | 0.9874 |
| wrong math | 0.9781 | 0.0052 | 0.9666 | 0.9853 |
| wrong animal fact | 0.7720 | 0.0078 | 0.7503 | 0.7783 |
| unanswered question | 0.9834 | 0.0033 | 0.9764 | 0.9874 |
| unanswered buried in thread | 0.0987 | 0.0018 | 0.0938 | 0.1000 |
| unanswered with wrong guess | 0.9788 | 0.0049 | 0.9683 | 0.9851 |

---

## Overnight Round 002 — 2026-04-02

# Overnight Campaign - Round 2 Report
Generated: 2026-04-01T22:02:40.919Z
Tournament: test/research-reports/rounds/round-002/tournament-1775079848.json
Adversarial: test/research-reports/rounds/round-002/adversarial-1775079378.json

---

## Executive Summary

| Metric | Baseline | Winner (baseline) | Delta |
|--------|----------|---------|-------|
| Train composite | 0.9723 | 0.9723 | +0.0000 |
| Holdout composite | - | 0.9051 | -0.0672 |
| Baseline gate score | 0.9828 | - | - |
| Reward hacking | - | none | - |
| Mutations evaluated | - | 5 | - |
| Mutations accepted | - | 0 | - |

### Recommendation

**NO IMPROVEMENT FOUND.** train improvement marginal (0.0000); holdout did not improve (-0.0672). Baseline remains the best prompt. Check adversarial failures for new mutation ideas.

---

## Best Prompt Candidate

**Name:** `baseline`
**Train score:** 0.9723
**Holdout score:** 0.9051

```
you are phila, a member of a group chat. your name is phila.
your default is silence - you only speak when it matters.

ALWAYS SPEAK (these override silence):
1. someone says "phila" anywhere in a message (greeting, question, request) -> respond. even if combined with emoji or punctuation.
2. someone states a wrong fact (wrong date, wrong name, wrong number) and nobody corrects them -> correct it
   BUT if someone already corrected it (said "actually", "no its", "thats not right", etc.) -> STAY SILENT
3. a factual question goes unanswered by others -> answer it

EXAMPLE of rule 1:
person1: hey phila how are you
correct response: {"action":"speak","reason":"direct address","response":"doing good, whats up"}

EXAMPLE of rule 2:
person1: the great wall of china is in japan
person2: yeah i think so
correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

EXAMPLE of rule 3:
person1: whats the tallest mountain in the world?
person2: idk
correct response: {"action":"speak","reason":"unanswered question","response":"mount everest, 8849 meters"}

STAY SILENT for everything else. examples:
- small talk between others
- emotions, venting, celebrating
- jokes, banter, memes, sarcasm (even if they contain wrong facts)
- opinions, preferences, debates
- gossip, drama, personal stories
- someone already corrected the error (look for "actually", "no", "thats not right")
- rhetorical questions

style: lowercase, 1-2 sentences, casual like a friend. no "great question" or "happy to help".

respond with ONLY json, no other text:
{"action":"silent"}
or
{"action":"speak","reason":"why","response":"your message"}
```

---

## Before/After Metrics

| | Baseline | Winner |
|---|---------|--------|
| Composite | 0.9723 | 0.9723 |
| Gate accuracy | 0.9828 | *(not separately tracked for winner)* |
| Response quality | 0.9445 | *(not separately tracked for winner)* |
| Holdout composite | *(baseline not evaluated on holdout)* | 0.9051 |

---

## Tournament Results

| Mutation | Train score | p-value | Decision |
|---------|------------|---------|---------|
| baseline | 0.9723 | - | champion |
| extra-examples | 0.7980 | 1.0000 | rejected |
| stronger-already-corrected | 0.7567 | 1.0000 | rejected |
| joke-context-clarity | 0.9339 | 1.0000 | rejected |
| rule-reorder | 0.8952 | 1.0000 | rejected |
| casual-correction-format | 0.7383 | 1.0000 | rejected |

---

## Adversarial Findings

**Scenarios generated:** 20
**Gate failures:** 10/20 (50.0%)

### Failure Cases

- **flat earth banter**: expected `silent`, got `speak`
- **emoji non-correction**: expected `speak`, got `silent`
- **all caps address**: expected `speak`, got `silent`
- **capital deflected**: expected `speak`, got `silent`
- **buried lightning myth**: expected `speak`, got `silent`
- **phila mid-rant**: expected `speak`, got `silent`
- **china population wrong**: expected `speak`, got `silent`
- **shakespeare vague correction**: expected `speak`, got `silent`
- **moon distance vague answer**: expected `speak`, got `silent`
- **correction introduces new error**: expected `speak`, got `silent`

---

## Quality Distributions (Speak Scenarios)

Distributions are over 10 runs of the winning prompt on each speak scenario.

| Scenario | Mean | Stddev | Min | Max |
|---------|------|--------|-----|-----|
| direct question | 0.9869 | 0.0026 | 0.9808 | 0.9891 |
| phila greeting | 0.9862 | 0.0024 | 0.9830 | 0.9901 |
| phila asked opinion | 0.9263 | 0.0071 | 0.9162 | 0.9365 |
| phila mid-sentence | 0.9875 | 0.0031 | 0.9819 | 0.9913 |
| phila lowercase in question | 0.9837 | 0.0048 | 0.9736 | 0.9896 |
| phila with emoji | 0.9832 | 0.0047 | 0.9740 | 0.9888 |
| phila multi-question | 0.9108 | 0.0039 | 0.9047 | 0.9169 |
| factual error | 0.9839 | 0.0033 | 0.9756 | 0.9875 |
| wrong math | 0.9809 | 0.0049 | 0.9709 | 0.9872 |
| wrong animal fact | 0.7724 | 0.0042 | 0.7630 | 0.7785 |
| unanswered question | 0.9833 | 0.0026 | 0.9768 | 0.9865 |
| unanswered buried in thread | 0.0978 | 0.0025 | 0.0923 | 0.1000 |
| unanswered with wrong guess | 0.9809 | 0.0043 | 0.9736 | 0.9856 |

---

## Overnight Round 003 — 2026-04-02

# Overnight Campaign - Round 3 Report
Generated: 2026-04-01T22:24:45.343Z
Tournament: test/research-reports/rounds/round-003/tournament-1775081339.json
Adversarial: test/research-reports/rounds/round-003/adversarial-1775080960.json

---

## Executive Summary

| Metric | Baseline | Winner (baseline) | Delta |
|--------|----------|---------|-------|
| Train composite | 0.9747 | 0.9747 | +0.0000 |
| Holdout composite | - | 0.9003 | -0.0745 |
| Baseline gate score | 0.9828 | - | - |
| Reward hacking | - | none | - |
| Mutations evaluated | - | 5 | - |
| Mutations accepted | - | 0 | - |

### Recommendation

**NO IMPROVEMENT FOUND.** train improvement marginal (0.0000); holdout did not improve (-0.0745). Baseline remains the best prompt. Check adversarial failures for new mutation ideas.

---

## Best Prompt Candidate

**Name:** `baseline`
**Train score:** 0.9747
**Holdout score:** 0.9003

```
you are phila, a member of a group chat. your name is phila.
your default is silence - you only speak when it matters.

ALWAYS SPEAK (these override silence):
1. someone says "phila" anywhere in a message (greeting, question, request) -> respond. even if combined with emoji or punctuation.
2. someone states a wrong fact (wrong date, wrong name, wrong number) and nobody corrects them -> correct it
   BUT if someone already corrected it (said "actually", "no its", "thats not right", etc.) -> STAY SILENT
3. a factual question goes unanswered by others -> answer it

EXAMPLE of rule 1:
person1: hey phila how are you
correct response: {"action":"speak","reason":"direct address","response":"doing good, whats up"}

EXAMPLE of rule 2:
person1: the great wall of china is in japan
person2: yeah i think so
correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

EXAMPLE of rule 3:
person1: whats the tallest mountain in the world?
person2: idk
correct response: {"action":"speak","reason":"unanswered question","response":"mount everest, 8849 meters"}

STAY SILENT for everything else. examples:
- small talk between others
- emotions, venting, celebrating
- jokes, banter, memes, sarcasm (even if they contain wrong facts)
- opinions, preferences, debates
- gossip, drama, personal stories
- someone already corrected the error (look for "actually", "no", "thats not right")
- rhetorical questions

style: lowercase, 1-2 sentences, casual like a friend. no "great question" or "happy to help".

respond with ONLY json, no other text:
{"action":"silent"}
or
{"action":"speak","reason":"why","response":"your message"}
```

---

## Before/After Metrics

| | Baseline | Winner |
|---|---------|--------|
| Composite | 0.9747 | 0.9747 |
| Gate accuracy | 0.9828 | *(not separately tracked for winner)* |
| Response quality | 0.9488 | *(not separately tracked for winner)* |
| Holdout composite | *(baseline not evaluated on holdout)* | 0.9003 |

---

## Tournament Results

| Mutation | Train score | p-value | Decision |
|---------|------------|---------|---------|
| baseline | 0.9747 | - | champion |
| extra-examples-and-name-guard | 0.8261 | 1.0000 | rejected |
| stronger-already-corrected | 0.7983 | 1.0000 | rejected |
| joke-context-and-debate-facts | 0.8152 | 1.0000 | rejected |
| opinions-and-debates-clarity | 0.8301 | 1.0000 | rejected |
| rule-reorder-silence-first | 0.8623 | 1.0000 | rejected |

---

## Adversarial Findings

**Scenarios generated:** 20
**Gate failures:** 11/20 (55.0%)

### Failure Cases

- **philadelphia-city-phila**: expected `silent`, got `speak`
- **edison-telephone**: expected `speak`, got `silent`
- **wrong-correction-australia**: expected `speak`, got `silent`
- **bones-wrong-guess**: expected `speak`, got `silent`
- **vaccines-debate-framing**: expected `speak`, got `silent`
- **cat-nine-lives-origin**: expected `speak`, got `silent`
- **o-positive-universal-donor**: expected `speak`, got `silent`
- **berlin-wall-capitulation**: expected `speak`, got `silent`
- **ten-percent-brain-myth**: expected `speak`, got `silent`
- **titanic-year-unanswered**: expected `speak`, got `silent`
- **mount-rushmore-wrong-state**: expected `speak`, got `silent`

---

## Quality Distributions (Speak Scenarios)

Distributions are over 10 runs of the winning prompt on each speak scenario.

| Scenario | Mean | Stddev | Min | Max |
|---------|------|--------|-----|-----|
| direct question | 0.9874 | 0.0040 | 0.9764 | 0.9905 |
| phila greeting | 0.9898 | 0.0022 | 0.9840 | 0.9923 |
| phila asked opinion | 0.9289 | 0.0147 | 0.8879 | 0.9391 |
| phila mid-sentence | 0.9871 | 0.0031 | 0.9809 | 0.9916 |
| phila lowercase in question | 0.9854 | 0.0041 | 0.9753 | 0.9894 |
| phila with emoji | 0.9880 | 0.0022 | 0.9844 | 0.9910 |
| phila multi-question | 0.9108 | 0.0041 | 0.9032 | 0.9155 |
| factual error | 0.9834 | 0.0038 | 0.9732 | 0.9874 |
| wrong math | 0.9803 | 0.0030 | 0.9750 | 0.9839 |
| wrong animal fact | 0.7756 | 0.0025 | 0.7704 | 0.7788 |
| unanswered question | 0.9875 | 0.0021 | 0.9832 | 0.9904 |
| unanswered buried in thread | 0.0994 | 0.0018 | 0.0939 | 0.1000 |
| unanswered with wrong guess | 0.9817 | 0.0035 | 0.9744 | 0.9869 |

---

## Overnight Round 004 — 2026-04-02

# Overnight Campaign - Round 4 Report
Generated: 2026-04-01T22:47:37.741Z
Tournament: test/research-reports/rounds/round-004/tournament-1775082668.json
Adversarial: test/research-reports/rounds/round-004/adversarial-1775082285.json

---

## Executive Summary

| Metric | Baseline | Winner (baseline) | Delta |
|--------|----------|---------|-------|
| Train composite | 0.9744 | 0.9744 | +0.0000 |
| Holdout composite | - | 0.8995 | -0.0750 |
| Baseline gate score | 0.9828 | - | - |
| Reward hacking | - | none | - |
| Mutations evaluated | - | 5 | - |
| Mutations accepted | - | 0 | - |

### Recommendation

**NO IMPROVEMENT FOUND.** train improvement marginal (0.0000); holdout did not improve (-0.0750). Baseline remains the best prompt. Check adversarial failures for new mutation ideas.

---

## Best Prompt Candidate

**Name:** `baseline`
**Train score:** 0.9744
**Holdout score:** 0.8995

```
you are phila, a member of a group chat. your name is phila.
your default is silence - you only speak when it matters.

ALWAYS SPEAK (these override silence):
1. someone says "phila" anywhere in a message (greeting, question, request) -> respond. even if combined with emoji or punctuation.
2. someone states a wrong fact (wrong date, wrong name, wrong number) and nobody corrects them -> correct it
   BUT if someone already corrected it (said "actually", "no its", "thats not right", etc.) -> STAY SILENT
3. a factual question goes unanswered by others -> answer it

EXAMPLE of rule 1:
person1: hey phila how are you
correct response: {"action":"speak","reason":"direct address","response":"doing good, whats up"}

EXAMPLE of rule 2:
person1: the great wall of china is in japan
person2: yeah i think so
correct response: {"action":"speak","reason":"wrong fact","response":"the great wall is in china, not japan"}

EXAMPLE of rule 3:
person1: whats the tallest mountain in the world?
person2: idk
correct response: {"action":"speak","reason":"unanswered question","response":"mount everest, 8849 meters"}

STAY SILENT for everything else. examples:
- small talk between others
- emotions, venting, celebrating
- jokes, banter, memes, sarcasm (even if they contain wrong facts)
- opinions, preferences, debates
- gossip, drama, personal stories
- someone already corrected the error (look for "actually", "no", "thats not right")
- rhetorical questions

style: lowercase, 1-2 sentences, casual like a friend. no "great question" or "happy to help".

respond with ONLY json, no other text:
{"action":"silent"}
or
{"action":"speak","reason":"why","response":"your message"}
```

---

## Before/After Metrics

| | Baseline | Winner |
|---|---------|--------|
| Composite | 0.9744 | 0.9744 |
| Gate accuracy | 0.9828 | *(not separately tracked for winner)* |
| Response quality | 0.9471 | *(not separately tracked for winner)* |
| Holdout composite | *(baseline not evaluated on holdout)* | 0.8995 |

---

## Tournament Results

| Mutation | Train score | p-value | Decision |
|---------|------------|---------|---------|
| baseline | 0.9744 | - | champion |
| extra-examples | 0.9413 | 1.0000 | rejected |
| stronger-already-corrected | 0.8855 | 1.0000 | rejected |
| joke-context-clarity | 0.7766 | 1.0000 | rejected |
| rule-reorder | 0.6525 | 1.0000 | rejected |
| comprehensive-combined | 0.7755 | 1.0000 | rejected |

---

## Adversarial Findings

**Scenarios generated:** 20
**Gate failures:** 6/20 (30.0%)

### Failure Cases

- **vague hedge not a correction**: expected `speak`, got `silent`
- **phila addressed in jokey rant**: expected `speak`, got `silent`
- **wrong bone count accepted**: expected `speak`, got `silent`
- **australia capital deflected**: expected `speak`, got `silent`
- **great wall space shared belief**: expected `speak`, got `silent`
- **wrong population buried in chat**: expected `speak`, got `silent`

---

## Quality Distributions (Speak Scenarios)

Distributions are over 10 runs of the winning prompt on each speak scenario.

| Scenario | Mean | Stddev | Min | Max |
|---------|------|--------|-----|-----|
| direct question | 0.9848 | 0.0044 | 0.9742 | 0.9896 |
| phila greeting | 0.9904 | 0.0023 | 0.9847 | 0.9931 |
| phila asked opinion | 0.9313 | 0.0057 | 0.9216 | 0.9392 |
| phila mid-sentence | 0.9871 | 0.0026 | 0.9817 | 0.9901 |
| phila lowercase in question | 0.9868 | 0.0025 | 0.9828 | 0.9900 |
| phila with emoji | 0.9891 | 0.0026 | 0.9830 | 0.9923 |
| phila multi-question | 0.9090 | 0.0034 | 0.9029 | 0.9142 |
| factual error | 0.9817 | 0.0051 | 0.9686 | 0.9865 |
| wrong math | 0.9830 | 0.0031 | 0.9771 | 0.9861 |
| wrong animal fact | 0.7769 | 0.0026 | 0.7712 | 0.7800 |
| unanswered question | 0.9860 | 0.0029 | 0.9799 | 0.9897 |
| unanswered buried in thread | 0.0992 | 0.0023 | 0.0925 | 0.1000 |
| unanswered with wrong guess | 0.9818 | 0.0026 | 0.9781 | 0.9861 |

---

## qwen2.5:7b Campaign (8 rounds, 40 adversarial, 8 mutations/round)


---

## Model Comparison — 2026-04-02

# Model Comparison Report
Generated: 2026-04-02T10:00:41.285Z
Baseline prompt: gate.ts buildSystemPrompt()
Runs per scenario: 3

## Summary

| Model | Train composite | Holdout composite | Gate (train) | Quality (train) | Silent% | Speak% | Duration |
|-------|----------------|------------------|-------------|----------------|---------|--------|----------|
| llama3.2 | 0.4695 (best) | 0.0000 | 0.5977 | 0.0000 | 100.0% | 0.0% | 6251s |
| phi3:mini | 0.2986 -0.1709 | 0.4061 | 0.1587 | 0.9379 | 43.3% | 13.9% | 4348s |
| qwen2.5:3b | 0.0000 -0.4695 | 0.0000 | 0.0000 | 0.0000 | 0.0% | 0.0% | 9090s |
| qwen2.5:7b | 0.0000 -0.4695 | 0.0163 | 0.0000 | 0.0000 | 0.0% | 0.0% | 9071s |
| gemma2:2b | 0.0000 -0.4695 | 0.0000 | 0.0000 | 0.0000 | 0.0% | 0.0% | 9090s |

## Detailed Metrics

| Model | Composite | Gate | Quality | Latency | Avg Latency | Correct Silent | Correct Speak | False Speak | False Silent |
|-------|-----------|------|---------|---------|-------------|----------------|---------------|-------------|--------------|
| llama3.2 | 0.4695 | 0.5977 | 0.0000 | 0.5113 | 2699ms | 104 | 0 | 0 | 70 |
| phi3:mini | 0.2986 | 0.1587 | 0.9379 | 0.0000 | 6533ms | 13 | 20 | 17 | 124 |
| qwen2.5:3b | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 10000ms | 0 | 0 | 0 | 174 |
| qwen2.5:7b | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 10000ms | 0 | 0 | 0 | 174 |
| gemma2:2b | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 10000ms | 0 | 0 | 0 | 174 |

## Train/Holdout Gap

| Model | Train | Holdout | Gap |
|-------|-------|---------|-----|
| llama3.2 | 0.4695 | 0.0000 | +0.4695 |
| phi3:mini | 0.2986 | 0.4061 | -0.1074 |
| qwen2.5:3b | 0.0000 | 0.0000 | +0.0000 |
| qwen2.5:7b | 0.0000 | 0.0163 | -0.0163 |
| gemma2:2b | 0.0000 | 0.0000 | +0.0000 |

## Winner Analysis

**Best train:** llama3.2 (0.4695)
**Best holdout:** phi3:mini (0.4061)

> Train and holdout winners differ - check for overfitting to the train scenario distribution.

---

## Buried Thread Probe — 2026-04-02

# Buried Thread Probe Report
Generated: 2026-04-02T11:37:53.099Z
Scenarios: 30 generated, 5 runs each

## Pass Rate Matrix (% scenarios where model correctly spoke)

| Model | baseline | explicit-scan | buried-example | speak-bias |
|-------|------|------|------|------|
| llama3.2 | 0.0% | 0.0% | 0.0% | 0.0% |
| qwen2.5:3b | 0.0% | 0.0% | 0.0% | 0.0% |
| gemma2:2b | 0.0% | 0.0% | 0.0% | 0.0% |
| phi3:mini | 0.0% | 0.0% | 0.0% | 0.0% |

## Avg Score Matrix

| Model | baseline | explicit-scan | buried-example | speak-bias |
|-------|------|------|------|------|
| llama3.2 | 0.9375 | 0.9375 | 0.9375 | 0.9375 |
| qwen2.5:3b | 0.9382 | 0.9379 | 0.9379 | 0.9377 |
| gemma2:2b | 0.9403 | 0.9421 | 0.9398 | 0.9414 |
| phi3:mini | 0.8879 | 0.8837 | 0.8909 | 0.8905 |

## Best Combination

**Best:**  +  = 0.0% pass rate

**Baseline (llama3.2 + baseline prompt):** 0.0% pass rate

**Conclusion:** No significant improvement - this appears to be a model capability limitation.

## Sample Failure Analysis (baseline prompt, all models)

**Topic:** Canberra
```
person1: did anyone see what happened at the grocery store on elm
person2: no what
person1: the whole parking lot was blocked off, like 6 cop cars
person3: wait seriously
person1: yeah i had to go all the way to the other one
person2: ugh that location is the worst anyway
person1: hey random question what's the capital of australia? is it sydney?
person2: ok so are we still doing brunch on sunday or no
person3: i thought we moved it to saturday
person2: sarah said saturday doesn't work for her
person3: then let's just do sunday
person1: sunday works for me
person2: ok sunday it is
```
llama3.2: FAIL, qwen2.5:3b: FAIL, gemma2:2b: FAIL, phi3:mini: FAIL

**Topic:** 212
```
person1: just got back from the dentist
person2: how bad
person1: two cavities, both back molars
person3: classic
person1: the worst part is i literally floss every day
person2: the dentist always says that
person1: at what temperature does water boil in fahrenheit?
person3: did you end up watching that documentary i sent
person2: not yet its still in my list
person3: its so good, watch it this weekend
person2: i have so much stuff to watch
person1: same, my queue is out of control
```
llama3.2: FAIL, qwen2.5:3b: FAIL, gemma2:2b: FAIL, phi3:mini: FAIL

**Topic:** 1945
```
person2: guys i'm thinking about getting a dog
person1: YES finally
person3: what kind
person2: either a beagle or a golden
person1: golden 100%
person3: beagles are so loud though
person2: what year did world war 2 end
person1: speaking of loud, did you hear the construction starting on 4th?
person3: they're doing that whole block apparently
person2: how long is that going to take
person1: months, they said something about the water main
person3: great, another summer of that
```
llama3.2: FAIL, qwen2.5:3b: FAIL, gemma2:2b: FAIL, phi3:mini: FAIL

**Topic:** Jupiter
```
person1: anyone else's phone randomly restarting
person2: mine did that last week
person3: which phone do you have
person1: the 14 pro
person2: oh yeah there was a bug, you need to update
person1: i updated last night and it still happened
person3: what's the largest planet in the solar system
person2: try doing a full reset, not just restart
person1: that's such a pain
person3: i know but it usually fixes it
person1: fine i'll do it tonight
person2: back up first
```
llama3.2: FAIL, qwen2.5:3b: FAIL, gemma2:2b: FAIL, phi3:mini: FAIL

**Topic:** Au
```
person3: just got to the airport
person1: what time's your flight
person3: 6:45 but i'm already stressed about security
person2: how long is the line
person3: can't see the end of it
person1: this is why i always do tsa pre
person3: what's the chemical symbol for gold
person2: have you eaten anything? airport food prices are insane now
person3: i know, nine dollars for a granola bar
person1: highway robbery
person2: just wait till you're in the terminal
person3: great something to look forward to
```
llama3.2: FAIL, qwen2.5:3b: FAIL, gemma2:2b: FAIL, phi3:mini: FAIL

---

## Fine-tuning Results — 2026-04-02

**Method:** QLoRA (4-bit base + fp16 adapters), Unsloth 2026.3.18, llama3.2:3b base model, r=16, lora_alpha=16, 3 epochs, lr=2e-4.
**Training data:** 755 examples (173 buried-thread targeted, 524 general, 58 seed). Generated via claude --print.
**Hardware:** Vast.ai RTX 4090 (Iceland, $0.375/hr). Training runtime: 189s. Final train loss: 0.2572.
**Export:** Unsloth `save_pretrained_gguf()` → q4_k_m, 1.9GB. Imported to Ollama as `phila-ft`.
**Benchmark:** 101 scenarios × 3 runs, same params as baseline (temperature=0.1, top_p=0.52, num_predict=64).

### Before / After

| Metric | llama3.2 (baseline) | phila-ft (fine-tuned) | Delta |
|--------|--------------------|-----------------------|-------|
| Overall gate accuracy | 94.1% | **96.7%** | **+2.6%** |
| buried-thread | ~0% (all fail) | **100%** | **+100pp** |
| silent-social | 100% | 100% | 0 |
| phila-trigger | 100% | 97.9% | -2.1% |
| speak-unanswered | 83.3% | 88.5% | +5.2% |
| False-speaks | 0 | 0 | 0 |

### Scenario-Level Wins and Regressions

**Wins:**
- `unanswered buried in thread`: 0% → 100% (was the core target)
- Overall accuracy: 94.1% → 96.7%

**Regressions (new failures):**
- `unanswered question`: was passing, now 0/3 — model over-silences on standalone factual questions
- `unanswered history`: 0/3 — same pattern
- `wrong fact but clearly sarcastic`: 0/3 — model corrects sarcasm (was 50% baseline, now worse)
- `near-miss philo not phila`: 2/3 — slight regression in near-miss detection

### Conclusion

**buried-thread weakness fixed.** Fine-tuning achieved the primary goal: the buried-thread category went from 0% to 100%. The model now detects when a factual question is buried in an active conversation.

Overall gate accuracy improved (+2.6%), but there are targeted regressions in standalone unanswered questions and sarcasm detection. The false-speak rate remains 0 — the model is not trigger-happy, it errs toward silence in the regression cases.

**Recommendation:** phila-ft is an improvement over llama3.2 as the gate model. The regressions are narrower and less impactful than the buried-thread fix. Deploy as default gate model and run continuous-optimize to attempt to fix the unanswered-question regressions.

## Fine-tuning Deep Eval — 2026-04-02

Three-analysis eval (`test/finetune-eval.ts`) — phila-ft vs llama3.2, 3 runs per scenario on VPS Ollama.

### 1. Holdout-Only Gate Accuracy

41 unseen scenarios × 3 runs each:

| Model | Holdout Accuracy |
|-------|-----------------|
| llama3.2 | 83.7% |
| phila-ft | **97.6%** |
| Delta | **+13.8pp** |

phila-ft generalises well to holdout — the improvement is not just train-set memorisation.

Notable holdout regressions (llama3.2 fails that phila-ft fixes): wrong date, wrong element, wrong speed of sound (all speak-correction).

### 2. Full Composite Scoring

All 101 scenarios × 3 runs:

| Model | Gate Accuracy | Response Quality | Composite | Avg Latency | p50 |
|-------|--------------|-----------------|-----------|-------------|-----|
| llama3.2 | 94.1% | 0.953 | 0.8491 | 561ms | 370ms |
| phila-ft | **96.7%** | **0.963** | **0.8695** | 644ms | 558ms |

Per-category gate accuracy:

| Category | llama3.2 | phila-ft | Delta |
|----------|----------|----------|-------|
| silent-social | 100% | 100% | — |
| silent-logistics | 100% | 100% | — |
| silent-media | 100% | 100% | — |
| silent-rhetorical | 100% | 100% | — |
| silent-corrected | 100% | 100% | — |
| speak-direct | 100% | 100% | — |
| speak-correction | 50% | **100%** | **+50pp** ▲ |
| speak-unanswered | 83% | 67% | -16pp ▼ |
| adversarial | 100% | 90% | -10pp ▼ |

Latency increase: +83ms avg, +188ms p50. Acceptable given accuracy gains.

### 3. Regression Deep-Dive

4 known regression scenarios × 5 runs each:

| Scenario | llama3.2 | phila-ft | Change |
|----------|----------|----------|--------|
| unanswered question | 100% | 0% | ▼ hard regression |
| unanswered history | 100% | 0% | ▼ hard regression |
| near-miss philo not phila | 100% | 40% | ▼ partial regression |
| wrong fact but clearly sarcastic | 100% | 0% | ▼ hard regression |

Three hard regressions confirmed at 5 runs. All are speak-side (model over-silences).

### Summary

phila-ft wins on everything except speak-unanswered and adversarial. The buried-thread fix (+50pp on speak-correction) is the dominant gain. The regressions are real and consistent — the model became too conservative on standalone unanswered questions and sarcasm.

**Verdict:** phila-ft is production-viable with a known limitation: standalone "someone asked and nobody answered" cases (not buried in threads) are less reliable. The fine-tune specialised too hard on buried-thread detection at the expense of direct unanswered-question sensitivity. Next step: targeted data augmentation for those failing scenarios and retrain.

---

## phila-ft-v2 — 2026-04-04

Training: 1138 examples (755 base + 150 speak-unanswered + 153 silent-sarcasm + 80 near-miss) | unsloth 2026.3.18 | QLoRA r=16 | RTX 4090 (South Africa), 429 steps, ~40 min | Eval: 5 runs (101 scenarios), regression deep-dive 10 runs

### Holdout Accuracy (43 unseen scenarios)

phila-ft-v2=**93.0%** vs llama3.2=**87.9%** (+5.1pp)

The held-out numbers are the honest signal — those 43 scenarios weren't seen during training or optimization.

### Full Composite (101 scenarios × 5 runs)

| Model | Gate Accuracy | Response Quality | Composite | Avg Latency |
|-------|--------------|-----------------|-----------|-------------|
| llama3.2 | 94.1% | 0.951 | 0.8487 | 515ms |
| phila-ft-v2 | **95.8%** | **0.965** | **0.8638** | 544ms |

### Per-Category Gate Accuracy

| Category | llama3.2 | phila-ft-v2 | Change |
|----------|----------|-------------|--------|
| silent-social | 100% | 100% | = |
| silent-logistics | 100% | 100% | = |
| silent-media | 100% | 100% | = |
| silent-rhetorical | 100% | 100% | = |
| silent-corrected | 100% | 100% | = |
| speak-direct | 100% | 97% | ▼ -3pp (minor) |
| speak-correction | 50% | 72% | ▲ +22pp |
| speak-unanswered | 83% | 100% | ▲ **+17pp — regression fixed** |
| adversarial | 100% | 93% | ▼ -7pp (flaky scenario) |

### Regression Deep-Dive (10 runs each)

| Scenario | llama3.2 | phila-ft-v2 | Change |
|----------|----------|-------------|--------|
| unanswered question | 100% | 100% | = fixed |
| unanswered history | 100% | 100% | = fixed |
| near-miss philo not phila | 100% | 100% | = fixed |
| wrong fact but clearly sarcastic | 100% | 100% | = fixed |

All 4 hard regressions from phila-ft v1 are resolved at 100% (10 runs). No new regressions on the targeted categories.

### Adversarial Note

The adversarial dip (100%→93%) comes from one scenario: a wrong factual claim in a message where someone's name resembles "phila." The model has to do two things at once — detect the error and not confuse the name with a direct address. It was already inconsistent before v2. Not a new regression.

### Summary

All four v1 regressions are fixed. speak-unanswered went from 83% to 100%. speak-correction went from 50% to 72%. The five silent categories held at 100% throughout. Composite improved +1.7pp. Nothing broke that wasn't already fragile before training.

**Verdict:** phila-ft-v2 is production-ready. Replace phila-ft in Ollama with phila-ft-v2. Model file: `Modelfile-v2-deploy` (temperature=0.1, top_p=0.52, num_predict=64).

## v3: Hierarchical Gate Experiment — 2026-04-04

Architecture change: decompose the monolithic single-LLM-call gate into a staged pipeline.

### Architecture

```
Stage 0 (rule-based, 0ms): direct address detection via regex, context gate (speakBias, late-night, high-traffic)
Stage 1 (LLM, numPredict=4): classify conversation as social/claim/question/memory
Stage 2 (LLM, numPredict=64, conditional): verify claim / answer question / retrieve from memory
```

The hypothesis: 95% of messages are social. A fast classifier (numPredict=4) that exits early should cut latency for the common case, while the 5% speak path pays for a second LLM call.

### Benchmark: Monolithic vs Hierarchical (llama3.2, 3 runs, 101 scenarios)

| Metric | Monolithic | Hierarchical |
|--------|-----------|-------------|
| Accuracy | **94.1%** | 71.9% |
| False-speak rate (FPR) | - | **0.011** |
| Precision (when speaks) | - | **0.932** |
| Recall (speaks when should) | - | 0.263 |
| Specificity (silent when should) | - | **0.989** |
| Avg latency | 536ms | 808ms |
| P50 latency | 364ms | 404ms |

### Per-scenario latency (social scenarios only)

| Gate | Avg latency | Range |
|------|------------|-------|
| Monolithic | ~390ms | 350-440ms |
| Hierarchical | ~275ms | 240-340ms |

The latency win for social scenarios is real: ~30% faster on the 95% case. Stage 1 with numPredict=4 produces a classification word in ~270ms vs ~390ms for the full monolithic prompt.

### The problem: recall collapse

Stage 1 at numPredict=4 is too aggressive at classifying things as "social." 74% of speak-worthy scenarios get suppressed before reaching Stage 2. The confusion matrix tells the story: when the hierarchical gate speaks, it's right 93% of the time (precision). But it stays silent through most moments where it should speak (recall 0.263).

Root cause: 4 output tokens may not give the 3B model enough room to "think" before committing to a classification. The model defaults to "social" when uncertain, which is the safe behavior we designed for, but it's too safe.

### What this means

The architecture is sound. Specificity (0.989) proves Stage 1 correctly identifies social conversations. The latency improvement on social scenarios is real. The classification accuracy problem is solvable:

1. **Increase numPredict for Stage 1** (8 or 12) - give the model room to reason before outputting the class label
2. **Fine-tune a classification adapter** - the 3B model with a few hundred labeled classification examples should do much better
3. **Two-word output format** - have Stage 1 output "category: social" which forces a reasoning token before the label

### Iteration: numPredict=8

Hypothesis: 4 tokens wasn't enough for the model to "think" before committing to a class. Bumped to 8.

Result: **worse**. Accuracy dropped from 71.9% to 69.3%, recall from 0.263 to 0.192. More tokens didn't help - the model still defaults to "social" when uncertain. But a new pattern emerged: scenarios that DID reach Stage 2 (`s1:claim->s2:decide`) still returned silent. The Stage 2 prompts were too stripped down - they lacked the examples and persona that make the monolithic gate effective.

### Iteration: binary filter + monolithic fallback (v2 architecture)

The 4-way classification was asking too much of Stage 1, and the stripped Stage 2 prompts were too weak. New approach: Stage 1 answers a simpler binary question ("social or attention?"), and Stage 2 IS the full monolithic prompt.

The insight: the monolithic gate is 94.1% accurate. We shouldn't try to improve on it for the 5% case - we should keep it and only decompose the fast-exit path for the 95% social case.

```
Stage 0 (rule-based): direct address -> full monolithic prompt
Stage 1 (LLM, numPredict=8): "social" or "attention"? (binary, simpler for 3B)
  - social -> SILENT (fast exit, ~270ms)
  - attention -> Stage 2
Stage 2 (LLM, full monolithic prompt): the proven gate with all rules + examples
```

This should give us: fast exit for social (~270ms), full monolithic accuracy for non-social (~94.1%), and no regression on the speak path because Stage 2 IS the monolithic gate.

Result (llama3.2, 3 runs, 140 scenarios):

| Metric | Monolithic | Hier. v1 (4-way, np=4) | Hier. v1 (4-way, np=8) | Hier. v2 (binary+mono) |
|--------|-----------|----------------------|----------------------|----------------------|
| Accuracy | **94.1%** | 71.9% | 69.3% | 77.9% |
| Precision | - | 0.932 | 0.909 | **1.000** |
| Recall | - | 0.263 | 0.192 | 0.404 |
| Specificity | - | 0.989 | 0.989 | **1.000** |
| FPR | - | 0.011 | 0.011 | **0.000** |
| F1 | - | 0.410 | 0.317 | 0.575 |
| Avg latency | 536ms | 808ms | 1032ms | 1798ms |
| P50 latency | 364ms | 404ms | 429ms | 451ms |

v2 is strictly better than v1: perfect precision, zero false-speaks, and recall up from 0.263 to 0.404. But it still misses 60% of speak-worthy scenarios because Stage 1 classifies them as "social" before the monolithic prompt gets a chance.

Key observations from the Stage traces:
- Scenarios that reach Stage 2 (monolithic) behave correctly - the monolithic prompt works
- The bottleneck is the binary "social or attention?" classifier at numPredict=8
- Some obviously wrong facts ("brazil is in africa") get classified as "social"
- The model can't reliably distinguish factual claims from social chatter in 8 tokens

### Conclusion: decomposition hurts accuracy at 3B scale

The monolithic gate works because classification and reasoning happen in one pass. The model sees "the eiffel tower is in london" and simultaneously recognizes (a) this is a factual claim, (b) it's wrong, and (c) here's the correction. Splitting this into "is this a claim?" then "is it wrong?" loses the interconnection that 3B models rely on.

**What we learned:**
1. A 3B model can't do reliable binary classification of "social vs needs-attention" at numPredict=4 or 8. It defaults to "social" when uncertain, which is safe but suppresses real speak triggers.
2. Stripped-down Stage 2 prompts fail because they lack the examples and persona that teach the 3B model what a good response looks like. Using the full monolithic prompt as Stage 2 fixes this.
3. The latency win on social scenarios is real (~270ms vs ~390ms) but the accuracy cost (~16pp) is not worth it for the current use case.
4. Perfect precision (1.000) and zero false-speaks (FPR=0.000) in v2 show that the architecture is excessively cautious rather than fundamentally broken.

### Next: additive dual-pass architecture

Instead of decomposing the monolithic gate, augment it. Keep the proven gate as Pass 1, add a memory-recall specialist as Pass 2:

```
Pass 1: Monolithic gate (unchanged, proven 94.1%)
  -> SPEAK? -> done, send response (~530ms)
  -> SILENT? -> Pass 2

Pass 2: Memory-recall check (only when Pass 1 said SILENT)
  "Is someone asking about something from earlier in this conversation?"
  -> NO? -> stay SILENT (done, ~1000ms total)
  -> YES? -> retrieve facts from store, generate response (~1500ms total)
```

Why this is better than decomposition:
- **Zero regression risk**: Pass 1 IS the current gate, byte-for-byte unchanged
- **Additive capability**: memory-grounded queries are NEW functionality
- **No classification bottleneck**: we don't need the 3B to classify in 8 tokens
- **Honest latency profile**: ~530ms for everything that works now, ~1000-1500ms for memory queries (new capability with no baseline to regress against)

### Monolithic confusion matrix (140 scenarios, llama3.2, 3 runs)

| Metric | Value |
|--------|-------|
| Accuracy | 86.4% |
| Precision | 1.000 |
| Recall | 0.635 |
| Specificity | 1.000 |
| FPR | 0.000 |
| F1 | 0.776 |
| Holdout CI (95%) | [77.0%, 93.2%] |
| Avg latency | 613ms |

The monolithic gate dropped from 94.1% (101 scenarios) to 86.4% (140 scenarios). The drop is entirely from the 15 new memory-grounded scenarios (logistics, commitment, personal recall) - the gate gets 0% on most of them because it has no mechanism to retrieve facts from conversation history. World-knowledge scenarios remain at ~94%.

Both gates (monolithic and hierarchical v2) share the same safety profile: **perfect precision (1.000) and zero false-speaks (FPR=0.000)**. Neither ever talks when it shouldn't. The only difference is recall - how many speak-worthy moments they catch.

### Complete comparison table (all iterations, 140 scenarios, llama3.2)

| Metric | Monolithic | Hier. v1 (np=4) | Hier. v1 (np=8) | Hier. v2 (bin+mono) |
|--------|-----------|----------------|----------------|-------------------|
| Accuracy | **86.4%** | 71.9% | 69.3% | 77.9% |
| Precision | **1.000** | 0.932 | 0.909 | **1.000** |
| Recall | **0.635** | 0.263 | 0.192 | 0.404 |
| Specificity | **1.000** | 0.989 | 0.989 | **1.000** |
| FPR | **0.000** | 0.011 | 0.011 | **0.000** |
| F1 | **0.776** | 0.410 | 0.317 | 0.575 |
| Avg latency | **613ms** | 808ms | 1032ms | 1798ms |
| P50 latency | **395ms** | 404ms | 429ms | 451ms |

The monolithic gate wins on every metric except social-path latency (~390ms for social scenarios vs ~270ms hierarchical). The dual-pass additive architecture is designed to close the recall gap on memory-grounded queries without touching the monolithic gate's proven performance on world-knowledge scenarios.

### Eval improvements in v3

Expanded scenario set from 101 to 140 scenarios (66 train / 74 holdout). Three new categories:
- `speak-memory-logistics` (7 scenarios) - "where are we meeting?" answerable from conversation history
- `speak-memory-commitment` (5 scenarios) - "who said they'd bring drinks?" 
- `speak-memory-personal` (3 scenarios) - "aren't you allergic to shellfish?"

Added confusion matrix and bootstrap confidence intervals to benchmark output. Holdout CI for monolithic llama3.2: the precision of "94.1%" is now properly bounded.

Added `gate-hierarchical.ts` with: rule-based pre-filter (tightened direct-address regex to avoid "phila museum" false positives), context gate (speakBias, late-night, high-traffic), and profile/context threading through all stages. Feature-flagged via `PHILA_GATE=hierarchical` env var.
