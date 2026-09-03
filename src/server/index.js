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
app.get('/projects', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'public', 'projects.html')));
app.get('/projects/:id', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'public', 'project-detail.html')));

// ---- PROJECTS API ----
const PHASE_ORDER = ['ideation','hypothesis','research','debate','experimentation','refinement','results','published'];

app.get('/api/projects', async (req, res) => {
  const { data, error } = await supabase.from('projects').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/projects', async (req, res) => {
  const { title, description, vision, assigned_professors } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const { data, error } = await supabase.from('projects').insert({
    title, description: description || '', vision: vision || '',
    status: 'ideation', assigned_professors: assigned_professors || [],
    phase_summary: 'Project created. Awaiting ideation phase.'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/projects/:id', async (req, res) => {
  const [proj, phases, comments] = await Promise.all([
    supabase.from('projects').select('*').eq('id', req.params.id).single(),
    supabase.from('project_phases').select('*').eq('project_id', req.params.id).order('created_at', { ascending: true }),
    supabase.from('project_comments').select('*').eq('project_id', req.params.id).order('created_at', { ascending: true })
  ]);
  if (proj.error) return res.status(404).json({ error: 'not found' });
  res.json({ ...proj.data, phases: phases.data || [], comments: comments.data || [] });
});

app.post('/api/projects/:id/comment', async (req, res) => {
  const { author, content } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  const { data, error } = await supabase.from('project_comments').insert({
    project_id: req.params.id, author: author || 'user', content
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/projects/:id/advance', async (req, res) => {
  if (!senate) return res.status(503).json({ error: 'Senate not ready' });
  const { id } = req.params;
  const { data: proj } = await supabase.from('projects').select('*').eq('id', id).single();
  if (!proj) return res.status(404).json({ error: 'not found' });

  const currentIdx = PHASE_ORDER.indexOf(proj.status);
  const nextPhase = PHASE_ORDER[Math.min(currentIdx + 1, PHASE_ORDER.length - 1)];

  // Get user comments for context
  const { data: comments } = await supabase.from('project_comments').select('*').eq('project_id', id).order('created_at', { ascending: true });
  const recentPhases = (proj.phases || []).slice(-5);

  // Pick professors to work on this phase
  let profIds = proj.assigned_professors || [];
  if (profIds.length === 0) {
    // Auto-assign based on project description
    const tokens = `${proj.title} ${proj.description}`.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3);
    const scored = senate.roster.map(r => {
      const fields = [...(r.expertise||[]), ...(r.subfields||[])].join(' ').toLowerCase();
      let s = 0;
      for (const t of tokens) if (fields.includes(t)) s++;
      return { r, s };
    }).sort((a, b) => b.s - a.s);
    profIds = scored.slice(0, 3).map(x => x.r.id);
    await supabase.from('projects').update({ assigned_professors: profIds }).eq('id', id);
  }

  const profs = profIds.map(pid => senate.professors.get(pid)).filter(Boolean);
  if (profs.length === 0) return res.status(500).json({ error: 'no professors available' });

  // Build context
  const userCommentsText = (comments || []).map(c => `[${c.author}]: ${c.content}`).join('\n');
  const historyText = (recentPhases || []).map(p => `[${p.professor_name} → ${p.phase}]: ${(p.content||'').slice(0, 300)}`).join('\n');

  const phasePrompts = {
    ideation: `PROJECT IDEATION PHASE.\nProject: "${proj.title}"\nVision: ${proj.vision}\nDescription: ${proj.description}\nUser feedback: ${userCommentsText || 'None yet.'}\n\nBrainstorm: What is the novel invention/idea? What makes it unprecedented? What are the 3 biggest scientific barriers? Be specific and bold.`,
    hypothesis: `HYPOTHESIS PHASE.\nProject: "${proj.title}"\nPrevious phase: ${historyText}\nUser feedback: ${userCommentsText}\n\nFormulate 2-3 testable hypotheses. For each: state the hypothesis, required evidence, and how to falsify it. Cite relevant science.`,
    research: `RESEARCH PHASE.\nProject: "${proj.title}"\nPrevious: ${historyText}\nUser feedback: ${userCommentsText}\n\nConduct a literature review. What prior art exists? What references are critical? Map the state of the art and identify the exact gap this project fills.`,
    debate: `DEBATE PHASE.\nProject: "${proj.title}"\nPrevious: ${historyText}\nUser feedback: ${userCommentsText}\n\nArgue FOR and AGAINST the feasibility. What are the strongest arguments on each side? What would need to be true for this to work? Be rigorous.`,
    experimentation: `EXPERIMENTATION PHASE.\nProject: "${proj.title}"\nPrevious: ${historyText}\nUser feedback: ${userCommentsText}\n\nDesign the experiment or computational study. What materials, methods, datasets are needed? What are expected results? What controls are necessary?`,
    refinement: `REFINEMENT PHASE.\nProject: "${proj.title}"\nPrevious: ${historyText}\nUser feedback: ${userCommentsText}\n\nBased on all prior work, what needs refinement? Address user feedback. What assumptions were wrong? What should be revised?`,
    results: `RESULTS PHASE.\nProject: "${proj.title}"\nPrevious: ${historyText}\nUser feedback: ${userCommentsText}\n\nSynthesize all findings into a coherent result. What did we learn? What is the status of each hypothesis? What remains uncertain? What are the next steps?`,
    published: `PUBLICATION PHASE.\nProject: "${proj.title}"\nPrevious: ${historyText}\nUser feedback: ${userCommentsText}\n\nWrite the final summary. State the invention/discovery clearly. What is novel? What is the impact for humanity? What are limitations? What should future research pursue?`
  };

  const prompt = phasePrompts[nextPhase] || `Continue work on "${proj.title}" in the ${nextPhase} phase.`;

  await supabase.from('projects').update({ status: nextPhase, active_professor: profs[0].id, updated_at: new Date().toISOString() }).eq('id', id);

  // Each professor contributes
  const results = [];
  for (const prof of profs) {
    try {
      await supabase.from('projects').update({ active_professor: prof.id }).eq('id', id);
      const { content } = await prof.ask(prompt, { temperature: 0.8, max_tokens: 1200 });
      const phase = await supabase.from('project_phases').insert({
        project_id: id,
        phase: nextPhase,
        professor_id: prof.id,
        professor_name: prof.record.name,
        action: `contributed to ${nextPhase} phase`,
        content,
        metadata: { model: prof.modelId, phase_idx: currentIdx + 1 }
      }).select().single();
      results.push({ professor: prof.record.name, phase: nextPhase, content });
    } catch (e) {
      await prof.log('error', 'project', `project phase failed: ${e.message}`);
    }
  }

  await supabase.from('projects').update({
    phase_summary: `${nextPhase.toUpperCase()}: ${results.length} professor(s) contributed. ${currentIdx + 1}/${PHASE_ORDER.length} phases complete.`,
    updated_at: new Date().toISOString()
  }).eq('id', id);

  res.json({ ok: true, phase: nextPhase, results });
});

// Start auto-advance loop for projects (every 5 min, advance 1 project if idle)
async function projectLoop() {
  if (!senate || !senate.running) { setTimeout(projectLoop, 30000); return; }
  try {
    const { data: projects } = await supabase.from('projects').select('*').not('status', 'eq', 'published').order('updated_at', { ascending: true }).limit(1);
    if (projects?.length) {
      const proj = projects[0];
      console.log(`[project] Auto-advancing: ${proj.title} → next phase`);
      // Simulate the advance internally
      const currentIdx = PHASE_ORDER.indexOf(proj.status);
      const nextPhase = PHASE_ORDER[Math.min(currentIdx + 1, PHASE_ORDER.length - 1)];
      if (nextPhase !== proj.status) {
        // Pick a random assigned prof or auto-assign
        let profIds = proj.assigned_professors || [];
        if (profIds.length === 0) {
          const tokens = `${proj.title} ${proj.description}`.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3);
          const scored = senate.roster.map(r => {
            const fields = [...(r.expertise||[]), ...(r.subfields||[])].join(' ').toLowerCase();
            let s = 0; for (const t of tokens) if (fields.includes(t)) s++;
            return { r, s };
          }).sort((a, b) => b.s - a.s);
          profIds = scored.slice(0, 2).map(x => x.r.id);
          await supabase.from('projects').update({ assigned_professors: profIds }).eq('id', proj.id);
        }
        const prof = senate.professors.get(profIds[0]);
        if (prof) {
          const { content } = await prof.ask(`You are contributing to the ${nextPhase} phase of project "${proj.title}". Vision: ${proj.vision}. Description: ${proj.description}. Produce a concise contribution.`, { temperature: 0.8, max_tokens: 800 });
          await supabase.from('project_phases').insert({ project_id: proj.id, phase: nextPhase, professor_id: prof.id, professor_name: prof.record.name, action: `auto-advance to ${nextPhase}`, content, metadata: { auto: true } });
          await supabase.from('projects').update({ status: nextPhase, active_professor: prof.id, updated_at: new Date().toISOString(), phase_summary: `Auto-advanced to ${nextPhase} by ${prof.record.name}` }).eq('id', proj.id);
        }
      }
    }
  } catch (e) { console.error('[project] Loop error:', e.message); }
  setTimeout(projectLoop, 300000); // every 5 min
}

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
  projectLoop();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
