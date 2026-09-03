// Senate — orchestrates 50 professors: 24/7 loop, debate, ML learning.
import { Professor } from './professor.js';
import { getFeed, matchFeedToProfessor } from './feed.js';
import { supabase } from './supabase.js';
import { chat, MODEL_IDS } from './llm.js';

const AUTO_TICK_MS        = parseInt(process.env.AUTO_TICK_MS        || '120000', 10);
const DEBATE_PROB         = parseFloat(process.env.DEBATE_PROBABILITY || '0.15');
const LEARN_PROB          = parseFloat(process.env.LEARN_PROBABILITY  || '0.6');
const PARALLEL_TICKERS    = parseInt(process.env.PARALLEL_TICKERS     || '4', 10);
const EMBED_ROUTING       = (process.env.EMBED_ROUTING || 'true').toLowerCase() !== 'false';

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
      withTimeout(p.loadMemory().catch(() => {}), 8000)
    );
    await Promise.allSettled(loadAll);
    console.log(`[senate] Loaded memories for ${this.professors.size} professors`);

    // Persist boot log (non-blocking).
    supabase.from('logs').insert({
      level: 'info', category: 'system',
      message: `Senate booted with ${this.professors.size} professors`,
      details: { tickMs: AUTO_TICK_MS, parallel: PARALLEL_TICKERS }
    }).then(() => {}, () => {});
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
    if (top.length === 0 && EMBED_ROUTING) {
      try {
        const list = scored.slice(0, 12).map(x =>
          `${x.r.id} | ${x.r.name} (${x.r.university}) | ${x.r.expertise.join(',')}`
        ).join('\n');
        const { content } = await chat(MODEL_IDS['gpt-oss-20b'], [
          { role: 'system', content: 'You are a router. Pick the 1-3 best professor IDs for the user question. Return ONLY a JSON array of IDs, nothing else.' },
          { role: 'user', content: `Professors:\n${list}\n\nQuestion: ${prompt}\n\nReturn JSON array of IDs.` }
        ], { temperature: 0.2, max_tokens: 200 });
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
      const { content } = await prof.ask(prompt, { temperature: 1.1, max_tokens: 1500 });
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
    for (let i = 0; i < 3; i++) {
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
      await supabase.rpc('bump_applied_count', { p_id: opProf.id }).then(() => {}, () => {});

      prevStance = reply;
    }

    const { content: conclusion } = await prof.ask(
      `Summarize the debate on: ${topic}\nIn one paragraph (120 words), state where the two of you converged and what remains unresolved.`,
      { temperature: 0.6, max_tokens: 600 }
    );
    await supabase.from('debates').update({
      status: 'concluded', conclusion, updated_at: new Date().toISOString()
    }).eq('id', debate.id);
    this.activeDebates.delete(debate.id);

    await prof.log('info', 'debate', `debate concluded`);
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
      details: { parallel: PARALLEL_TICKERS }
    });

    // Initial burst: tick all professors immediately on first cycle.
    console.log('[senate] Initial burst — ticking all 50 professors…');
    const feed = await getFeed();
    const shuffled = [...this.roster].sort(() => Math.random() - 0.5);
    await pMap(shuffled, async (r) => {
      if (!this.running) return;
      const prof = this.professors.get(r.id);
      prof.record.status = 'working';
      await supabase.from('professors').update({ status: 'working' }).eq('id', r.id);
      try { await this.tickProfessor(prof, feed); } catch (e) { await prof.log('error', 'system', 'tick failed', { err: String(e) }); }
    }, PARALLEL_TICKERS);
    console.log('[senate] Initial burst complete. Entering main loop…');

    while (this.running) {
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
        await supabase.from('logs').insert({
          level: 'info', category: 'system', message: 'cycle complete', details: { processed: done }
        });
        await new Promise(res => setTimeout(res, AUTO_TICK_MS));
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
