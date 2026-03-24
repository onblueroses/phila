# phila

An iMessage group chat agent that stays silent.

---

## the problem with chatbots

Every AI agent built for messaging makes the same mistake: it talks too much. The moment you add a bot to a group chat, it becomes the loudest voice in the room. It responds to everything. It has opinions about everything. Within a day, someone mutes it.

This happens because agents are designed as servants. You ask, they answer. That model works fine in a 1:1 conversation where someone specifically wants help. But a group chat isn't a help desk. It's a social space with its own rhythm and unspoken rules about who speaks when and about what.

The question that interests me isn't "what can an agent do in a group chat?" It's "when should an agent shut up?"

## silence as a design choice

Phila is a group chat participant, not an assistant. Its default state is silence. It speaks roughly 5% of the time - and even that might be too much.

The core of phila is a "speak gate" - a decision engine that evaluates every batch of messages and almost always returns SILENT. It only speaks when it has something useful to add:

- A factual claim in the conversation is wrong, and phila knows the right answer
- Someone asked a question and nobody answered
- Someone is looking for something specific - a restaurant, a link, a fact
- A debate stalled and data (not opinions) could help
- Someone addressed phila directly

Everything else gets silence. Emotional conversations, jokes, banter, small talk, gossip, opinions, agreement - phila stays out of it. It never says "great question." It doesn't offer unsolicited advice or restate what someone already said.

This is harder than it sounds. Language models are trained to be helpful, which means they're trained to respond. Teaching one to not respond - to recognize that the most helpful thing it can do right now is nothing - is the actual design challenge.

## social learning

Different group chats have different norms. Your work chat tolerates different behavior from your college friends chat. A real person adjusts to each group's expectations. Phila does the same.

When someone says "thanks phila" or "good one," that's a positive signal. Phila becomes slightly more willing to speak up in similar contexts. When someone says "not now" or "shut up," that's a negative signal - and it carries 2.5x the weight of a positive one. The asymmetry is intentional: it's easier to learn silence than to learn when to talk.

Each group chat develops its own version of phila over time. The one in your cooking group might speak up more about recipes. The one in your sports chat might have learned to stay completely quiet during game threads.

This is all stored locally in SQLite. No cloud, no syncing. The learning stays on your machine, like the conversations it came from.

## privacy

Phila runs a local language model through Ollama. Your group chat messages never leave your device. There's no API call to OpenAI, no data sent to a cloud service, no telemetry.

For an agent that sits in your most personal conversations, reading messages from your friends, trust has to come from the architecture, not from a privacy policy. Local inference is slower and less capable than cloud APIs. That's a trade-off worth making.

## the voice

When phila does speak, it texts like a person in a group chat:

- lowercase, always
- short - one or two sentences max
- no bullet points, no markdown, no formatting
- no "I'd be happy to help!" or "Great question!"
- can be wrong and says so: "actually not sure about that"
- first person, not third: "i think" not "based on my analysis"

The system prompt handles most of this, but there's a post-processing layer that enforces the constraints as a safety net. If the model slips into assistant-speak, the voice engine catches it.

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

## setup

**Requirements**: macOS, [Ollama](https://ollama.com), Node.js 22.6+

```bash
# install ollama and pull a model
ollama pull llama3.2

# clone and install
git clone <repo-url> && cd phila
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

## what i learned

Silence is easy to get right. Talking at the right time is hard. Running llama3.2 (3B parameters) against eight test scenarios, the model nails every silence case on the first try - small talk, emotions, jokes, opinions, already-answered questions. It never over-talks. The real struggle is the opposite: getting a model that's been told "your default is silence" to override that default when it sees a factual error.

The factual error case broke four prompt iterations. A 3B model doesn't have enough reasoning to both detect a wrong fact and decide to speak. What finally worked was giving it a concrete example in the system prompt - showing it what a factual error looks like and exactly how to respond to it. The model can now consistently catch "the eiffel tower is in london" but still misses subtler errors like "the boiling point of water is 50 degrees." That's a model size limitation, not a prompt problem.

Simplifying the prompt made things worse. My instinct was to trim it down - fewer words, less ambiguity. But smaller models need more structure, not less. Priority ordering ("ALWAYS SPEAK for these, STAY SILENT for everything else") outperformed percentage-based framing ("stay silent 95% of the time"). The model needs clear rules, not vibes.

The parse-failure-to-silence default is load-bearing. The model sometimes wraps its JSON in markdown fences, occasionally outputs malformed responses, and is non-deterministic across runs. Treating any unparseable output as silence means the worst failure mode is being too quiet, never too loud. For a social agent, that's the right direction to fail.

The asymmetric feedback weights (negative at 2.5x positive) exist because people say "thanks" more casually than they say "shut up." Without the asymmetry, positive signals accumulate faster and the agent drifts toward talking more over time.

## open questions

- How should phila handle being wrong? Right now it can say "not sure about that," but it doesn't track its own accuracy or learn from corrections.
- What's the right memory window? 50 messages might be too few for slow-moving group chats and too many for rapid-fire ones. Could be adaptive.
- Should phila ever initiate? Currently it only reacts. There might be value in proactive contributions - "hey, you mentioned wanting to try that restaurant last week, they have a special tonight" - but that's a different trust equation.
- Can the silence rate be measured rather than configured? Instead of targeting 95%, let the natural feedback loop find each group's tolerance.
