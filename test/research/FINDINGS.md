# phila Research Findings

Autonomous research campaign running on Hetzner VPS (12 vCPU, 24GB RAM, CPU-only inference).
Updated as cycles complete. Raw cycle reports in `test/research-reports/` (gitignored).

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
Tournament: /home/onblueroses/phila/test/research-reports/rounds/round-001/tournament-1775078310.json
Adversarial: /home/onblueroses/phila/test/research-reports/rounds/round-001/adversarial-1775078117.json

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
Tournament: /home/onblueroses/phila/test/research-reports/rounds/round-002/tournament-1775079848.json
Adversarial: /home/onblueroses/phila/test/research-reports/rounds/round-002/adversarial-1775079378.json

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
Tournament: /home/onblueroses/phila/test/research-reports/rounds/round-003/tournament-1775081339.json
Adversarial: /home/onblueroses/phila/test/research-reports/rounds/round-003/adversarial-1775080960.json

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
Tournament: /home/onblueroses/phila/test/research-reports/rounds/round-004/tournament-1775082668.json
Adversarial: /home/onblueroses/phila/test/research-reports/rounds/round-004/adversarial-1775082285.json

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
