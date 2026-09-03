# Professor Senate

A multi-agent system of **50 unique MIT / Harvard / Oxford-level professors**, each assigned a different LLM from your NVIDIA catalog, with autonomous 24/7 operation, mutual debate, machine-learning memory, and a draggable Obsidian-like UI. Everything they think, learn, and argue is journaled and logged to Supabase.

## What's inside

- **50 professors**, one-of-a-kind expertise (no duplicates): quantum computing, fusion plasma, comparative literature, Greek philosophy, marine geology, CRISPR synthetic biology, Roman history, Arabic philosophy, particle physics, etc. — drawn from MIT (17), Harvard (17), Oxford (16).
- **12 NVIDIA models** round-robined across the 50 agents: DeepSeek V4 Pro/Flash, GPT-OSS 20B, Gemma 4 31B, DiffusionGemma 26B (vision), Nemotron 3 Ultra/Super/Lightning, Muse Glimmer 30B, Kimi K3, Laguna-XS 2.1.
- **Obsidian-like UI**: drag each professor card anywhere on a graph-paper canvas. Click a card to see journals, logs, learnings, and chat directly with them.
- **Auto-routing**: a free-form prompt is scored against all 50 experts and dispatched to the top 1–3 most relevant professors, who answer in parallel.
- **24/7 autonomous loop**: when no user prompt is active, each professor (a) reads arXiv / Reddit / HackerNews items matching their expertise, (b) extracts a novel insight, (c) writes a journal entry, (d) persists a *learning* (ML state — confidence score, source, tags), and (e) periodically picks a random colleague and runs a 3-round debate with conclusion.
- **Supabase journaling**: every action — `thought`, `analysis`, `response`, `debate`, `learn`, `read`, `log` — is pushed to your Supabase project in near real time. You can query past activity any time.
- **ML memory**: each professor's `learnings` table grows over time; on every call their top 8 most recent insights are injected as context, so they get smarter and more domain-specific the longer they run.

## File layout

```
konsultan/
├── .env                          # Supabase keys + tuning knobs
├── package.json
├── public/
│   ├── index.html                # Obsidian-like UI
│   ├── styles.css
│   ├── app.js
│   └── supabase.js               # Live polling
├── src/server/
│   ├── index.js                  # Express API + boot
│   ├── supabase.js               # Service-role client
│   ├── llm.js                    # LLM router (12 models)
│   ├── professors.js             # 50-roster definition
│   ├── professor.js              # Agent class (memory, learning, debate, journal)
│   ├── senate.js                 # Orchestrator (routing, loop, debates)
│   ├── feed.js                   # arXiv / Reddit / HN scraper
│   ├── seed.js                   # Insert 50 professors into Supabase
│   ├── setup-db.js               # Print schema.sql
│   └── schema.sql                # Run in Supabase SQL editor
└── AGENTS.md
```

## Setup (Windows / PowerShell)

```powershell
cd C:\Users\Admin\Documents\pribadi\konsultan
npm install
```

### 1. Create the tables in Supabase

Open `src\server\schema.sql` and paste it into **Supabase → SQL Editor → New query → Run**.

### 2. Seed the 50 professors

```powershell
npm run seed
```

### 3. Start the server (boots the 24/7 loop and serves the UI)

```powershell
npm start
```

Open <http://localhost:3000> in your browser. You'll see 50 colored cards on a grid; drag any of them.

## How to use

- **Ask the Senate** (right pane): type a free-form question; it auto-routes to the most relevant professor(s).
- **Click a professor card**: opens the right sidebar with their journals, logs, and learnings, plus a "Ask directly" form.
- **Trigger Debate** (top bar): kicks off a random 3-round debate between two professors and writes the full transcript to the `debates` table.
- **Tick All**: runs one autonomous learning step for every professor right now (otherwise they tick on a rolling schedule).

## How the 24/7 loop works

For each professor, on each tick:
1. 60% chance → **learn**: fetch latest arXiv/Reddit/HN items matching their expertise, summarize the most novel insight, write a journal + a `learnings` row (with confidence).
2. 15% chance → **debate**: pick a random colleague, run 3 rounds of arguments + concessions, write a final conclusion, store full transcript in `debates`.
3. 25% chance → **reflect**: free-write an essay on an open question in their field.

Every action also emits a `logs` row so you can audit the full mental state of every professor while you're away.

## Supabase tables

| Table       | Purpose                                                       |
|-------------|---------------------------------------------------------------|
| `professors` | The 50 agent records (model, expertise, color, position).    |
| `journals`   | Every response, thought, analysis, debate turn.              |
| `logs`       | Every internal event (read, think, error).                   |
| `learnings`  | The ML state per professor (source URL, insight, confidence). |
| `debates`    | Debate records with structured turns + conclusion.           |
| `user_messages` | Your prompts (so you can replay them later).              |

## Tunable knobs (`.env`)

```
AUTO_TICK_MS=120000        # how long the full 50-prof cycle takes
DEBATE_PROBABILITY=0.15   # chance a tick becomes a debate
LEARN_PROBABILITY=0.6     # chance a tick becomes a feed-learning
PORT=3000
```

Lower `AUTO_TICK_MS` for a faster, more active swarm; raise it to save API quota.
