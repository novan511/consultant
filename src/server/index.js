// Express server: REST API + static frontend + Senate bootstrap.
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { buildRoster } from './professors.js';
import { Senate } from './senate.js';
import { supabase, ping } from './supabase.js';
import { initTelegram, stopTelegram } from './telegram.js';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// Serve Supabase config to frontend (anon key is safe to expose)
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  });
});

let senate = null;

app.get('/api/health', async (req, res) => {
  try {
    await ping();
    res.json({ ok: true, professors: senate?.roster.length || 0, running: !!senate?.running });
  } catch (e) { res.status(500).json({ ok: false, err: String(e) }); }
});

app.get('/api/professors', (req, res) => {
  if (!senate) return res.status(503).json({ error: 'Senate not ready' });
  res.json(senate.roster);
});

app.post('/api/ask', async (req, res) => {
  if (!senate) return res.status(503).json({ error: 'Senate not ready' });
  const { prompt, professor_id } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  // Direct ask: single professor, normal JSON.
  if (professor_id) {
    try {
      const p = senate.professors.get(professor_id);
      if (!p) return res.status(404).json({ error: 'professor not found' });
      const out = await p.ask(prompt, { temperature: 0.7, max_tokens: 800 });
      const j = await p.journal('response', { title: `Reply: ${prompt.slice(0, 60)}`, content: out.content, user_prompt: prompt });
      return res.json({ answers: [{ professor_id, professor_name: p.record.name, expertise: p.record.expertise, content: out.content, model: out.model, journal_id: j?.id }] });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  }

  // SSE streaming: route to 1 best professor (fastest response).
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Find best professor (cheap, no LLM).
  const scored = senate.roster.map(r => {
    const fields = [...(r.expertise || []), ...(r.subfields || [])].join(' ').toLowerCase();
    let s = 0;
    for (const t of prompt.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2)) {
      if (fields.includes(t)) s += 1;
    }
    return { r, s };
  }).sort((a, b) => b.s - a.s);
  const top = scored.filter(x => x.s > 0).slice(0, 1).map(x => x.r);
  if (top.length === 0) top.push(scored[0].r);

  // Persist user prompt.
  await supabase.from('user_messages').insert({ prompt, routed_to: top.map(t => t.id), response: null });

  let firstAnswer = false;

  // Fire all professors concurrently; stream each answer as it completes.
  const tasks = top.map(async (r) => {
    const prof = senate.professors.get(r.id);
    try {
      const { content, model } = await prof.ask(prompt, { temperature: 0.7, max_tokens: 800 });
      const journal = await prof.journal('response', {
        title: `Reply to user: ${prompt.slice(0, 60)}`, content, topic: prompt, user_prompt: prompt, metadata: { model }
      });
      const answer = { professor_id: r.id, professor_name: r.name, expertise: r.expertise, content, model, journal_id: journal?.id };
      const data = JSON.stringify(answer);
      res.write(`data: ${data}\n\n`);
      firstAnswer = true;
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: String(e), professor_id: r.id })}\n\n`);
    }
  });

  // Wait for all to finish, then signal done.
  await Promise.allSettled(tasks);
  res.write(`data: [DONE]\n\n`);
  res.end();
});

app.post('/api/professors/:id/tick', async (req, res) => {
  if (!senate) return res.status(503).json({ error: 'Senate not ready' });
  const p = senate.professors.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    const feed = await (await import('./feed.js')).getFeed();
    await senate.tickProfessor(p, feed);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/professors/tick-all', async (req, res) => {
  if (!senate) return res.status(503).json({ error: 'Senate not ready' });
  try {
    const out = await senate.tickAll();
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/professors/:id/position', async (req, res) => {
  const { x, y } = req.body || {};
  const { error } = await supabase.from('professors').update({ position_x: x, position_y: y }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/debates/trigger', async (req, res) => {
  if (!senate) return res.status(503).json({ error: 'Senate not ready' });
  const { a, b, topic } = req.body || {};
  try {
    if (a && b) {
      const pa = senate.professors.get(a), pb = senate.professors.get(b);
      const t = topic || `Is ${pa.record.expertise[0]} compatible with ${pb.record.expertise[0]}?`;
      const argA = await pa.argue(t, 'I am open. Give me your position.', pb.record.name);
      const argB = await pb.argue(t, argA, pa.record.name);
      const { data, error } = await supabase.from('debates').insert({
        topic: t, initiated_by: a, participants: [a, b],
        turns: [
          { professor_id: a, stance: pa.record.expertise[0], argument: argA, ts: new Date().toISOString() },
          { professor_id: b, stance: pb.record.expertise[0], argument: argB, ts: new Date().toISOString() }
        ]
      }).select().single();
      if (error) throw error;
      await pa.journal('debate', { title: `Debate: ${t.slice(0,60)}`, content: argA, topic: t, related_professors: [b] });
      await pb.journal('debate', { title: `Debate: ${t.slice(0,60)}`, content: argB, topic: t, related_professors: [a] });
      return res.json({ ok: true, debate: data });
    }
    // Random: pick any professor and call maybeDebate.
    const r = senate.roster[Math.floor(Math.random() * senate.roster.length)];
    await senate.maybeDebate(senate.professors.get(r.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/debates', async (req, res) => {
  const { data, error } = await supabase.from('debates').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/journals', async (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const prof  = req.query.professor_id;
  let q = supabase.from('journals').select('*').order('created_at', { ascending: false }).limit(limit);
  if (prof) q = q.eq('professor_id', prof);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/logs', async (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  const prof  = req.query.professor_id;
  let q = supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(limit);
  if (prof) q = q.eq('professor_id', prof);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/learnings', async (req, res) => {
  const prof = req.query.professor_id;
  let q = supabase.from('learnings').select('*').order('created_at', { ascending: false }).limit(50);
  if (prof) q = q.eq('professor_id', prof);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Full professor detail: status, last activity, recent journals, learnings, log count
app.get('/api/professors/:id/detail', async (req, res) => {
  if (!senate) return res.status(503).json({ error: 'Senate not ready' });
  const r = senate.roster.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const prof = senate.professors.get(r.id);
  const [journals, logs, learnings] = await Promise.all([
    supabase.from('journals').select('*').eq('professor_id', r.id).order('created_at', { ascending: false }).limit(5),
    supabase.from('logs').select('*').eq('professor_id', r.id).order('created_at', { ascending: false }).limit(10),
    supabase.from('learnings').select('*').eq('professor_id', r.id).order('created_at', { ascending: false }).limit(10)
  ]);
  res.json({
    ...r,
    status: r.status || 'idle',
    last_journal: journals.data?.[0] || null,
    last_log: logs.data?.[0] || null,
    recent_journals: journals.data || [],
    recent_logs: logs.data || [],
    recent_learnings: learnings.data || [],
    memory_size: prof?.learnings?.length || 0,
    working_memory_size: prof?.memory?.length || 0
  });
});

// Activity feed: latest journals from all professors
app.get('/api/activity', async (req, res) => {
  const limit = parseInt(req.query.limit || '20', 10);
  const { data, error } = await supabase.from('journals').select('*, professors(name, avatar_color, university)').order('created_at', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html')));
app.get('/professor/:id', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'public', 'professor.html')));

async function main() {
  console.log('Verifying Supabase...');
  try { 
    const result = await ping(); 
    console.log('Supabase ping result:', result);
  } catch (e) {
    console.error('Could not reach Supabase:', e.message);
  }
  console.log('Building roster...');
  const roster = buildRoster();
  console.log('Roster built:', roster.length);
  senate = new Senate(roster);
  console.log('Senate created, booting...');
  await senate.boot();
  console.log('Senate booted');

  // Start Telegram bridge (if token set).
  console.log('Starting Telegram...');
  await initTelegram(senate);
  console.log('Telegram initialized');

  // Graceful shutdown.
  process.on('SIGINT', () => { stopTelegram(); process.exit(0); });
  process.on('SIGTERM', () => { stopTelegram(); process.exit(0); });

  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`Professor Senate running on http://localhost:${port}`);
    console.log(`Open the UI in your browser. The 24/7 loop will start automatically.`);
  });

  // Start 24/7 autonomous loop.
  senate.startLoop().catch(e => console.error('Loop crashed:', e));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
