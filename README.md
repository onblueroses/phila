# phila

An iMessage group chat agent that stays silent.

---

## the problem with chatbots

Every AI agent I've seen in group chats makes the same mistake: it talks too much. You add a bot, it becomes the loudest one in the room. Responds to everything. Has opinions about everything. Someone mutes it within a day.

Agents are designed as servants - you ask, they answer. That works in a 1:1 conversation. A group chat is different. It has its own rhythm, unspoken rules about who talks when. Nobody asked for a personal assistant to join the friend group.

The question I keep coming back to: when should an agent shut up?

## silence as a design choice

Phila is a group chat participant, not an assistant. Its default state is silence. It speaks roughly 5% of the time - and even that might be too much.

The core is a "speak gate" - it evaluates every batch of messages and almost always returns SILENT. It only speaks when it has something genuinely useful:

- A factual claim in the conversation is wrong, and phila knows the right answer
- Someone asked a question and nobody answered
- Someone is looking for something specific - a restaurant, a link, a fact
- A debate stalled and data (not opinions) could help
- Someone addressed phila directly

Everything else gets silence. Emotional conversations, jokes, banter, small talk, gossip, opinions, agreement - phila stays out of it. It never says "great question." It doesn't offer unsolicited advice or restate what someone already said.

This is harder than it sounds. Language models are trained to respond. Teaching one to not respond - to recognize that the best thing it can do right now is nothing - that's the design challenge.

## social learning

Your work chat and your college friends chat have completely different norms. You know this intuitively. Phila learns it.

When someone says "thanks phila" or "good one," phila gets slightly more willing to speak in that group. When someone says "not now" or "shut up," that carries 2.5x the weight. People say "thanks" casually. They don't say "shut up" casually.

Over time each group chat develops its own version of phila. The one in your cooking group might speak up about recipes. The one in your sports chat might have learned to stay completely quiet during game threads.

All stored locally in SQLite. No cloud, no syncing. The learning stays on your machine, like the conversations it came from.

## privacy

Phila runs a local language model through Ollama. Messages never leave your device. No API calls to OpenAI, no cloud, no telemetry.

This thing sits in your most personal conversations, reading messages from your friends. Trust can't come from a privacy policy. It has to come from the architecture. Local inference is slower and less capable than cloud APIs. Worth it.

## the voice

When phila does speak, it texts like a person in a group chat:

- lowercase, always
- short - one or two sentences max
- no bullet points, no markdown, no formatting
- no "I'd be happy to help!" or "Great question!"
- can be wrong and says so: "actually not sure about that"
- first person, not third: "i think" not "based on my analysis"

The system prompt handles most of this. A post-processing layer enforces the constraints as a safety net - if the model slips into assistant-speak, it gets caught before sending.

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

Silence is easy. Talking at the right time is hard.

Running llama3.2 (3B) against eight test scenarios, it nails every silence case on the first try - small talk, emotions, jokes, opinions, already-answered questions. Never over-talks. The struggle is the opposite: getting a model that's been told "your default is silence" to override that default when it sees a factual error.

The error correction case broke four prompt iterations. A 3B model doesn't have enough reasoning to both detect a wrong fact and decide to speak. What finally worked: a concrete example in the system prompt showing exactly what a factual error looks like and how to respond. It now catches "the eiffel tower is in london" but misses subtler errors like "the boiling point of water is 50 degrees." Model size limitation, not a prompt problem.

Simplifying the prompt made things worse. My instinct was to trim it down. But smaller models need more structure, not less. Priority ordering ("ALWAYS SPEAK for these, STAY SILENT for everything else") outperformed percentage-based framing ("stay silent 95% of the time"). Clear rules beat vibes.

The parse-failure-to-silence default is load-bearing. The model sometimes wraps JSON in markdown fences, occasionally outputs malformed responses. Treating any unparseable output as silence means the worst failure mode is being too quiet, never too loud. For something sitting in your group chats, that's the right direction to fail.

## open questions

- How should phila handle being wrong? It can say "not sure about that," but it doesn't track its own accuracy or learn from corrections.
- What's the right memory window? 50 messages might be too few for slow chats and too many for rapid-fire ones.
- Should phila ever initiate? Right now it only reacts. "hey, you mentioned wanting to try that restaurant last week, they have a special tonight" - but that's a different trust equation entirely.
- Can the silence rate emerge from the feedback loop instead of being hardcoded? Let each group find its own tolerance.
