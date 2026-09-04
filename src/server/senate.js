// Senate — orchestrates 50 professors: 24/7 loop, debate, ML learning.
import { Professor } from './professor.js';
import { getFeed, matchFeedToProfessor } from './feed.js';
import { supabase } from './supabase.js';
import { chat as llmChat } from './lib/llm-manager.js';
import { MODEL_IDS } from './llm.js';
import { log } from './lib/logger.js';
import {
  TICK_INTERVAL_MS, TICK_OVERHEAD_MS, PARALLEL_TICKERS,
  DEBATE_PROBABILITY, DEBATE_ROUNDS, LEARN_PROBABILITY,
  REFLECTION_TEMPERATURE, JUDGE_TEMPERATURE, ROUTING_TEMPERATURE
} from './lib/constants.js';

const DEBATE_PROB = DEBATE_PROBABILITY;
const LEARN_PROB = LEARN_PROBABILITY;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// Simple bounded worker pool: process up to N async jobs at once.
function pMap(items, mapper, concurrency) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await mapper(items[idx], idx);
    }
  });
  return Promise.all(workers).then(() => out);
}

export class Senate {
  constructor(roster) {
    this.roster = roster;
    this.professors = new Map(roster.map(r => [r.id, new Professor(r)]));
    this.running = false;
    this.activeDebates = new Map();
    // Precompute token vectors once for routing.
    this._vectors = new Map(roster.map(r => [r.id, this.professors.get(r.id).buildExpertiseVector()]));
  }

  async boot() {
    // Load memories with timeout so 1 slow query doesn't block everything.
    const loadAll = [...this.professors.values()].map(p =>
      withTimeout(p.loadMemory().catch(e => {
        console.warn(`[boot] Failed to load memory for ${p.id}: ${e.message}`);
      }), 8000)
    );
    await Promise.allSettled(loadAll);
    console.log(`[senate] Loaded memories for ${this.professors.size} professors`);

    // Persist boot log (non-blocking).
    supabase.from('logs').insert({
      level: 'info', category: 'system',
      message: `Senate booted with ${this.professors.size} professors`,
      details: { tickMs: TICK_INTERVAL_MS, parallel: PARALLEL_TICKERS }
    }).then(() => {}, (e) => console.warn(`[boot-log] ${e.message}`));
  }

  // Hybrid routing: keyword overlap + token-similarity. If still ambiguous,
  // optionally ask a small LLM to pick (controlled by EMBED_ROUTING).
  async routeUserPrompt(prompt) {
    const tokens = new Map();
    for (const t of prompt.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2)) {
      tokens.set(t, (tokens.get(t) || 0) + 1);
    }
    if (tokens.size === 0) tokens.set('general', 1);

    const scored = this.roster.map(r => {
      const fields = [...(r.expertise||[]), ...(r.subfields||[])].join(' ').toLowerCase();
      let kw = 0;
      for (const t of tokens.keys()) if (fields.includes(t)) kw += 1;
      const sim = Professor.tokenSim(tokens, this._vectors.get(r.id) || new Map());
      const score = kw * 2 + sim * 5;
      return { r, score, kw, sim };
    }).sort((a, b) => b.score - a.score);

    let top = scored.filter(x => x.score > 0).slice(0, 3).map(x => x.r);

    // LLM-as-router fallback when nothing matched well.
    if (top.length === 0 && process.env.EMBED_ROUTING !== 'false') {
      try {
        const list = scored.slice(0, 12).map(x =>
          `${x.r.id} | ${x.r.name} (${x.r.university}) | ${x.r.expertise.join(',')}`
        ).join('\n');
        const { content } = await llmChat(MODEL_IDS['gpt-oss-20b'], [
          { role: 'system', content: 'You are a router. Pick the 1-3 best professor IDs for the user question. Return ONLY a JSON array of IDs, nothing else.' },
          { role: 'user', content: `Professors:\n${list}\n\nQuestion: ${prompt}\n\nReturn JSON array of IDs.` }
        ], { temperature: ROUTING_TEMPERATURE, max_tokens: 200, useCache: false });
        const m = content.match(/\[[\s\S]*?\]/);
        const ids = m ? JSON.parse(m[0]) : [];
        top = ids.map(id => this.roster.find(r => r.id === id)).filter(Boolean).slice(0, 3);
      } catch (e) {
        await supabase.from('logs').insert({ level: 'warn', category: 'system', message: 'LLM routing failed', details: { err: String(e) } });
      }
    }
    if (top.length === 0) top = [scored[0].r];

    await supabase.from('user_messages').insert({
      prompt, routed_to: top.map(t => t.id), response: null
    });

    // Run in parallel with per-prof mutex.
    const answers = await pMap(top, async (r) => {
      const prof = this.professors.get(r.id);
      const { content, model } = await prof.ask(prompt, { temperature: 0.7, max_tokens: 1800 });
      const journal = await prof.journal('response', {
        title: `Reply to user: ${prompt.slice(0, 60)}`,
        content, topic: prompt, user_prompt: prompt,
        metadata: { model }
      });
      return {
        professor_id: r.id,
        professor_name: r.name,
        expertise: r.expertise,
        content, model,
        journal_id: journal?.id
      };
    }, Math.min(top.length, 3));
    return answers;
  }

  async tickProfessor(prof, feed) {
    const r = Math.random();
    if (r < DEBATE_PROB) {
      await this.maybeDebate(prof);
      return;
    }
    if (r < DEBATE_PROB + LEARN_PROB) {
      const matches = matchFeedToProfessor(prof.record, feed);
      const item = matches[0] || feed[Math.floor(Math.random() * feed.length)];
      if (item) {
        await prof.log('info', 'reading', `reading ${item.source}: ${item.title}`);
        await prof.autonomousThink({ ...item, topic: prof.record.expertise[0] });
      }
    } else {
      const prompt = `Pick a current open question in ${prof.record.expertise.join('/')} and produce a short essay (300-500 words) with a novel angle.`;
      const { content } = await prof.ask(prompt, { temperature: REFLECTION_TEMPERATURE, max_tokens: 1500 });
      await prof.journal('thought', {
        title: `Reflection — ${new Date().toISOString().slice(0, 10)}`,
        content, topic: 'self-reflection'
      });
      await prof.log('info', 'thinking', 'autonomous reflection produced');
    }

    const vec = Object.fromEntries(prof.buildExpertiseVector());
    prof.record.status = 'reviewing';
    await supabase.from('professors').update({
      status: 'reviewing',
      last_active: new Date().toISOString()
    }).eq('id', prof.id);
  }

  async maybeDebate(prof) {
    const others = this.roster.filter(r => r.id !== prof.id);
    const opponent = others[Math.floor(Math.random() * others.length)];
    if (!opponent) return;
    const opProf = this.professors.get(opponent.id);

    const topic = `Is ${prof.record.expertise[0]} fundamentally limited by current approaches in ${opponent.expertise[0]}?`;
    await prof.log('info', 'debate', `initiates debate with ${opponent.name}: ${topic}`);

    const { data: debate } = await supabase.from('debates').insert({
      topic, initiated_by: prof.id,
      participants: [prof.id, opponent.id], turns: []
    }).select().single();
    if (!debate) return;
    this.activeDebates.set(debate.id, { topic, turns: [] });

    let prevStance = 'I am open. Give me your position.';
    for (let i = 0; i < DEBATE_ROUNDS; i++) {
      const arg = await prof.argue(topic, prevStance, opponent.name);
      await prof.journal('debate', {
        title: `Debate R${i + 1}: ${topic.slice(0, 60)}`,
        content: arg, topic,
        related_professors: [opponent.id],
        metadata: { debate_id: debate.id, round: i + 1 }
      });
      const turn = { professor_id: prof.id, stance: prof.record.expertise[0], argument: arg, ts: new Date().toISOString() };
      this.activeDebates.get(debate.id).turns.push(turn);
      await supabase.from('debates').update({
        turns: this.activeDebates.get(debate.id).turns, updated_at: new Date().toISOString()
      }).eq('id', debate.id);

      const reply = await opProf.argue(topic, arg, prof.name);
      await opProf.journal('debate', {
        title: `Debate R${i + 1} reply: ${topic.slice(0, 60)}`,
        content: reply, topic,
        related_professors: [prof.id],
        metadata: { debate_id: debate.id, round: i + 1 }
      });
      const turn2 = { professor_id: opponent.id, stance: opponent.expertise[0], argument: reply, ts: new Date().toISOString() };
      this.activeDebates.get(debate.id).turns.push(turn2);
      await supabase.from('debates').update({
        turns: this.activeDebates.get(debate.id).turns, updated_at: new Date().toISOString()
      }).eq('id', debate.id);

      // Increment applied_count for any learning referenced (cheap heuristic: all of this prof's recent).
      await supabase.rpc('bump_applied_count', { p_id: opProf.id }).catch(e => {
        console.warn(`[debate] bump_applied_count failed for ${opProf.id}: ${e.message}`);
      });

      prevStance = reply;
    }

    // Write final conclusion with scoring
    const { content: conclusion } = await prof.ask(
      `DEBATE CONCLUSION for: ${topic}
You debated with ${opponent.name}. Here is the full transcript:
${this.activeDebates.get(debate.id)?.turns?.map(t => `[${t.professor_id}]: ${t.argument}`).join('\n\n') || 'N/A'}

Write a 120-word conclusion that:
1. States where you and your opponent converged (consensus points).
2. States what remains genuinely unresolved.
3. Identifies the single strongest argument from each side.
4. Suggests what evidence would resolve the disagreement.`,
      { temperature: 0.6, max_tokens: 600 }
    );

    // JUDGE: Score the debate
    const scores = await this.judgeDebate(debate.id, topic, prof, opProf);

    await supabase.from('debates').update({
      status: 'concluded',
      conclusion,
      scores,
      consensus_points: scores.consensus_points,
      winner: scores.winner,
      updated_at: new Date().toISOString()
    }).eq('id', debate.id);
    this.activeDebates.delete(debate.id);

    await prof.log('info', 'debate', `debate concluded`);
  }

  async judgeDebate(debateId, topic, profA, profB) {
    // Pick a third professor as judge (different from debaters, different expertise)
    const candidates = this.roster.filter(r =>
      r.id !== profA.id && r.id !== profB.id &&
      !profA.record.expertise.some(e => r.expertise.some(re => re.toLowerCase().includes(e.toLowerCase())))
    );
    const judge = candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : this.roster.find(r => r.id !== profA.id && r.id !== profB.id) || this.roster[0];
    const judgeProf = this.professors.get(judge.id);

    const { data: debateData } = await supabase.from('debates').select('turns').eq('id', debateId).single();
    const turns = debateData?.turns || [];

    const turnsText = turns.map((t, i) => `Round ${Math.floor(i/2)+1} — ${t.professor_id === profA.id ? profA.record.name : profB.record.name}:
${t.argument}`).join('\n\n');

    const { content: judgeResponse } = await judgeProf.ask(
      `You are ${judgeProf.record.name}, ${judgeProf.record.title} at ${judgeProf.record.university}.
You are judging a debate between ${profA.record.name} (${profA.record.expertise[0]}) and ${profB.record.name} (${profB.record.expertise[0]}).

Topic: ${topic}

DEBATE TRANSCRIPT:
${turnsText}

Score this debate in this exact JSON format (no markdown):
{
  "winner": "${profA.id}" or "${profB.id}" or "tie",
  "winner_name": "<name>",
  "scores": {
    "professor_a": {
      "logic": <1-10>,
      "evidence": <1-10>,
      "persuasiveness": <1-10>,
      "addressing_counterarguments": <1-10>,
      "staying_in_domain": <1-10>,
      "total": <average>
    },
    "professor_b": {
      "logic": <1-10>,
      "evidence": <1-10>,
      "persuasiveness": <1-10>,
      "addressing_counterarguments": <1-10>,
      "staying_in_domain": <1-10>,
      "total": <average>
    }
  },
  "consensus_points": ["<point 1>", "<point 2>"],
  "unresolved_points": ["<point 1>", "<point 2>"],
  "strongest_argument_a": "<what was A's best moment>",
  "strongest_argument_b": "<what was B's best moment>",
  "judge_commentary": "<2-3 sentences on your judging rationale>"
}`,
      { temperature: JUDGE_TEMPERATURE, max_tokens: 800 }
    );

    let scores;
    try {
      const m = judgeResponse.match(/\{[\s\S]*\}/);
      scores = m ? JSON.parse(m[0]) : { winner: 'tie', judge_commentary: judgeResponse };
    } catch {
      scores = { winner: 'tie', judge_commentary: judgeResponse.slice(0, 500) };
    }

    // Log the judge's scoring
    await supabase.from('logs').insert({
      level: 'info', category: 'debate_judge',
      message: `Judge ${judgeProf.record.name} scored debate: winner=${scores.winner}`,
      details: {
        debate_id: debateId,
        judge_id: judge.id,
        scores: scores.scores,
        consensus_points: scores.consensus_points
      }
    });

    return scores;
  }

  // Bulk tick — used by /api/professors/tick-all. Bounded concurrency.
  async tickAll() {
    const feed = await getFeed();
    let processed = 0;
    await pMap(this.roster, async (r) => {
      const prof = this.professors.get(r.id);
      prof.record.status = 'working';
      await supabase.from('professors').update({ status: 'working' }).eq('id', r.id);
      try { await this.tickProfessor(prof, feed); } catch (e) {
        await prof.log('error', 'system', 'tick failed', { err: String(e) });
      }
      processed++;
    }, PARALLEL_TICKERS);
    return { processed, total: this.roster.length };
  }

  async startLoop() {
    if (this.running) return;
    this.running = true;
    await supabase.from('logs').insert({
      level: 'info', category: 'system', message: '24/7 autonomous loop started',
      details: { parallel: PARALLEL_TICKERS, tick_interval_ms: TICK_INTERVAL_MS }
    });

    // Initial burst: tick all professors immediately on first cycle.
    console.log('[senate] Initial burst — ticking all 50 professors...');
    const feed = await getFeed();
    const shuffled = [...this.roster].sort(() => Math.random() - 0.5);
    await pMap(shuffled, async (r) => {
      if (!this.running) return;
      const prof = this.professors.get(r.id);
      prof.record.status = 'working';
      await supabase.from('professors').update({ status: 'working' }).eq('id', r.id);
      try { await this.tickProfessor(prof, feed); } catch (e) { await prof.log('error', 'system', 'tick failed', { err: String(e) }); }
    }, PARALLEL_TICKERS);
    console.log('[senate] Initial burst complete. Entering main loop...');

    // Main loop — NEVER overlaps. Waits for cycle to finish + interval before next.
    while (this.running) {
      const cycleStart = Date.now();
      try {
        const feed = await getFeed();
        await supabase.from('logs').insert({
          level: 'debug', category: 'system', message: `feed size ${feed.length}`
        });
        const shuffled = [...this.roster].sort(() => Math.random() - 0.5);
        let done = 0;
        await pMap(shuffled, async (r) => {
          if (!this.running) return;
          const prof = this.professors.get(r.id);
          prof.record.status = 'working';
          await supabase.from('professors').update({ status: 'working' }).eq('id', r.id);
          try { await this.tickProfessor(prof, feed); done++; }
          catch (e) { await prof.log('error', 'system', 'tick failed', { err: String(e) }); }
        }, PARALLEL_TICKERS);
        const cycleDuration = Date.now() - cycleStart;
        await supabase.from('logs').insert({
          level: 'info', category: 'system', message: 'cycle complete',
          details: { processed: done, duration_ms: cycleDuration }
        });
        // Wait for remaining interval (cycle time is subtracted)
        const waitTime = Math.max(TICK_INTERVAL_MS - cycleDuration + TICK_OVERHEAD_MS, TICK_OVERHEAD_MS);
        log('info', 'loop', `Cycle took ${Math.round(cycleDuration/1000)}s, next in ${Math.round(waitTime/1000)}s`);
        await new Promise(res => setTimeout(res, waitTime));
      } catch (e) {
        try {
          await supabase.from('logs').insert({
            level: 'error', category: 'system', message: 'loop iteration failed', details: { err: String(e) }
          });
        } catch (_) {}
        await new Promise(res => setTimeout(res, 30000));
      }
    }
  }

  stopLoop() { this.running = false; }
}
