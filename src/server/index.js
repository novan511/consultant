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

// Trigger inter-professor discussion within a project (fire-and-forget)
app.post('/api/projects/:id/discuss', async (req, res) => {
  if (!senate) return res.status(503).json({ error: 'Senate not ready' });
  const { id } = req.params;
  const { topic } = req.body || {};
  const { data: proj } = await supabase.from('projects').select('*').eq('id', id).single();
  if (!proj) return res.status(404).json({ error: 'not found' });

  // Check if already in progress
  if (proj.metadata?.discussion_running) return res.json({ ok: true, status: 'already_running' });

  await supabase.from('projects').update({ metadata: { discussion_running: true } }).eq('id', id);

  // Fire background — don't await
  runDiscussion(id, topic, proj).catch(e => {
    console.error('[discussion] Background error:', e.message);
    supabase.from('projects').update({ metadata: { discussion_running: false } }).eq('id', id);
  });

  res.json({ ok: true, status: 'started' });
});

async function runDiscussion(projectId, topic, proj) {
  let profIds = proj.assigned_professors || [];
  if (profIds.length < 2) {
    const tokens = `${proj.title} ${proj.description}`.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3);
    const scored = senate.roster.map(r => {
      const fields = [...(r.expertise||[]), ...(r.subfields||[])].join(' ').toLowerCase();
      let s = 0; for (const t of tokens) if (fields.includes(t)) s++;
      return { r, s };
    }).sort((a, b) => b.s - a.s);
    profIds = scored.slice(0, 3).map(x => x.r.id);
    await supabase.from('projects').update({ assigned_professors: profIds }).eq('id', projectId);
  }
  const profs = profIds.map(pid => senate.professors.get(pid)).filter(Boolean);
  if (profs.length < 2) { await supabase.from('projects').update({ metadata: { discussion_running: false } }).eq('id', projectId); return; }

  const discussTopic = topic || `Given the project "${proj.title}" (${proj.description}), what is the most promising approach and what are the biggest risks?`;
  const { data: prevPhases } = await supabase.from('project_phases').select('professor_name,phase,content').eq('project_id', projectId).order('created_at', { ascending: false }).limit(3);
  const historyText = (prevPhases || []).map(p => `[${p.professor_name} → ${p.phase}]: ${(p.content||'').slice(0, 300)}`).join('\n');

  let prevArgument = `${discussTopic}\n\nRecent project work:\n${historyText}`;
  for (let round = 0; round < 3; round++) {
    for (const prof of profs) {
      const { content } = await prof.ask(
        `PROJECT DISCUSSION — Round ${round + 1}.\nTopic: ${discussTopic}\nProject: "${proj.title}"\nYour colleague previously said:\n"${prevArgument.slice(0, 500)}"\n\nRespond with your position (2-3 paragraphs). Agree, disagree, or build on what was said. Be specific.`,
        { temperature: 0.8, max_tokens: 600 }
      );
      await supabase.from('project_phases').insert({
        project_id: projectId, phase: 'discussion', professor_id: prof.id, professor_name: prof.record.name,
        action: `round ${round + 1} discussion`, content: content.trim(),
        metadata: { discussion_round: round + 1, topic: discussTopic }
      });
      prevArgument = content;
    }
  }

  const summarizer = profs.length > 2 ? profs[2] : profs[0];
  const { data: turns } = await supabase.from('project_phases').select('professor_name,content,metadata').eq('project_id', projectId).eq('phase', 'discussion').order('created_at', { ascending: false }).limit(6);
  const summaryInput = (turns || []).map(t => `${t.professor_name}: ${(t.content||'').slice(0, 200)}`).join('\n');
  const { content: summary } = await summarizer.ask(`Summarize this discussion about "${proj.title}". Points of agreement, disagreements, and key insights:\n${summaryInput}`, { temperature: 0.6, max_tokens: 400 });
  await supabase.from('project_phases').insert({
    project_id: projectId, phase: 'discussion', professor_id: summarizer.id, professor_name: summarizer.record.name,
    action: 'discussion summary', content: summary, metadata: { is_summary: true }
  });

  await supabase.from('projects').update({ metadata: { discussion_running: false }, updated_at: new Date().toISOString() }).eq('id', projectId);
  console.log(`[discussion] Completed for "${proj.title}"`);
}

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
    // === PART 1: Autonomous project creation from feed ===
    const { count } = await supabase.from('projects').select('*', { count: 'exact', head: true });
    if (!count || count < 8) {
      try {
        const { getFeed } = await import('./feed.js');
        const feed = await getFeed();
        if (feed.length) {
          // Pick a random professor and have them propose a project
          const proposer = senate.roster[Math.floor(Math.random() * senate.roster.length)];
          const prof = senate.professors.get(proposer.id);
          const recentFeed = feed.slice(0, 10).map(f => `- ${f.title}: ${(f.summary||'').slice(0, 200)}`).join('\n');
          const { content } = await prof.ask(
            `You are a ${proposer.expertise.join('/')} researcher. Based on these recent developments:\n${recentFeed}\n\nPropose ONE novel research project that could lead to a groundbreaking invention for humanity. Reply in this EXACT JSON format (no markdown):\n{"title":"...","description":"...","vision":"..."}`,
            { temperature: 0.9, max_tokens: 500 }
          );
          let parsed;
          try { parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || content); } catch { parsed = null; }
          if (parsed?.title) {
            const { data: existing } = await supabase.from('projects').select('id').eq('title', parsed.title).limit(1);
            if (!existing?.length) {
              await supabase.from('projects').insert({
                title: parsed.title, description: parsed.description || '', vision: parsed.vision || '',
                status: 'ideation', assigned_professors: [proposer.id],
                phase_summary: `Proposed by ${proposer.name}. Auto-created from ${feed[0]?.source || 'feed'}.`
              });
              console.log(`[project] Auto-created: "${parsed.title}" by ${proposer.name}`);
            }
          }
        }
      } catch (e) { console.error('[project] Creation error:', e.message); }
    }

    // === PART 2: Auto-advance existing projects ===
    const { data: activeProjects } = await supabase.from('projects').select('*').not('status', 'eq', 'published').order('updated_at', { ascending: true }).limit(3);
    for (const proj of (activeProjects || [])) {
      try {
        const currentIdx = PHASE_ORDER.indexOf(proj.status);
        const nextPhase = PHASE_ORDER[Math.min(currentIdx + 1, PHASE_ORDER.length - 1)];
        if (nextPhase === proj.status) continue;

        // Get existing phases + comments for context
        const { data: prevPhases } = await supabase.from('project_phases').select('professor_name,phase,content').eq('project_id', proj.id).order('created_at', { ascending: false }).limit(4);
        const { data: comments } = await supabase.from('project_comments').select('author,content').eq('project_id', proj.id);
        const historyText = (prevPhases || []).map(p => `[${p.professor_name} → ${p.phase}]: ${(p.content||'').slice(0, 400)}`).join('\n');
        const commentsText = (comments || []).map(c => `[${c.author}]: ${c.content}`).join('\n');

        // Assign professors
        let profIds = proj.assigned_professors || [];
        if (profIds.length === 0) {
          const tokens = `${proj.title} ${proj.description}`.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3);
          const scored = senate.roster.map(r => {
            const fields = [...(r.expertise||[]), ...(r.subfields||[])].join(' ').toLowerCase();
            let s = 0; for (const t of tokens) if (fields.includes(t)) s++;
            return { r, s };
          }).sort((a, b) => b.s - a.s);
          profIds = scored.slice(0, 3).map(x => x.r.id);
          await supabase.from('projects').update({ assigned_professors: profIds }).eq('id', proj.id);
        }

        const prompts = {
          ideation: `PROJECT IDEATION. "${proj.title}" — Vision: ${proj.vision}. Description: ${proj.description}. User feedback: ${commentsText || 'None'}. Brainstorm the novel invention, 3 scientific barriers.`,
          hypothesis: `HYPOTHESIS PHASE. "${proj.title}". History: ${historyText}. User feedback: ${commentsText}. Formulate 2-3 testable hypotheses with evidence needed and falsification criteria.`,
          research: `RESEARCH PHASE. "${proj.title}". History: ${historyText}. User feedback: ${commentsText}. Literature review: prior art, critical references, the exact gap this fills.`,
          debate: `DEBATE PHASE. "${proj.title}". History: ${historyText}. User feedback: ${commentsText}. Argue FOR and AGAINST feasibility. Strongest arguments each side. What must be true for this to work.`,
          experimentation: `EXPERIMENTATION PHASE. "${proj.title}". History: ${historyText}. User feedback: ${commentsText}. Design experiments/computational studies. Materials, methods, expected results, controls.`,
          refinement: `REFINEMENT PHASE. "${proj.title}". History: ${historyText}. User feedback: ${commentsText}. What needs refinement? Wrong assumptions? Revisions needed?`,
          results: `RESULTS PHASE. "${proj.title}". History: ${historyText}. User feedback: ${commentsText}. Synthesize all findings. Status of each hypothesis. What remains uncertain?`,
          published: `FINAL PUBLICATION. "${proj.title}". History: ${historyText}. User feedback: ${commentsText}. Write a comprehensive 500-word research summary: novel discovery, impact for humanity, limitations, future research directions.`
        };

        // Multiple professors contribute
        const contribs = profIds.slice(0, nextPhase === 'published' ? 3 : 2);
        for (const pid of contribs) {
          const prof = senate.professors.get(pid);
          if (!prof) continue;
          await supabase.from('projects').update({ active_professor: pid }).eq('id', proj.id);
          const { content } = await prof.ask(prompts[nextPhase] || `Continue "${proj.title}" in ${nextPhase} phase.`, { temperature: 0.8, max_tokens: 1000 });
          await supabase.from('project_phases').insert({
            project_id: proj.id, phase: nextPhase, professor_id: prof.id, professor_name: prof.record.name,
            action: `auto-advance to ${nextPhase}`, content, metadata: { auto: true }
          });
        }

        await supabase.from('projects').update({
          status: nextPhase, updated_at: new Date().toISOString(),
          phase_summary: `${nextPhase.toUpperCase()}: ${contribs.length} professor(s) contributed. ${currentIdx + 2}/${PHASE_ORDER.length} phases.`
        }).eq('id', proj.id);
        console.log(`[project] "${proj.title}" → ${nextPhase}`);

        // === PART 3: Generate PDF when published ===
        if (nextPhase === 'published') {
          await generateProjectPDF(proj.id);
        }
      } catch (e) { console.error('[project] Advance error:', e.message); }
    }
  } catch (e) { console.error('[project] Loop error:', e.message); }
  setTimeout(projectLoop, 180000); // every 3 min
}

async function generateProjectPDF(projectId) {
  try {
    const PDFDocument = (await import('pdfkit')).default;
    const { data: proj } = await supabase.from('projects').select('*').eq('id', projectId).single();
    if (!proj) return;
    const { data: phases } = await supabase.from('project_phases').select('*').eq('project_id', projectId).order('created_at', { ascending: true });
    const { data: comments } = await supabase.from('project_comments').select('*').eq('project_id', projectId);

    const chunks = [];
    const doc = new PDFDocument({ margin: 50 });
    doc.on('data', c => chunks.push(c));

    // Title page
    doc.fontSize(24).font('Helvetica-Bold').text('RESEARCH REPORT', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(18).font('Helvetica-Bold').text(proj.title, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(11).font('Helvetica').fillColor('#666').text(`Professor Senate — Autonomous Research Division`, { align: 'center' });
    doc.moveDown(0.2);
    doc.text(`Status: ${proj.status.toUpperCase()} | Phases: ${phases?.length || 0} | Generated: ${new Date().toISOString().slice(0, 10)}`, { align: 'center' });
    doc.moveDown(1);
    doc.fillColor('#000');

    // Vision
    doc.fontSize(13).font('Helvetica-Bold').text('Vision');
    doc.moveDown(0.2);
    doc.fontSize(11).font('Helvetica').text(proj.vision || 'N/A');
    doc.moveDown(0.5);

    // Description
    doc.fontSize(13).font('Helvetica-Bold').text('Description');
    doc.moveDown(0.2);
    doc.fontSize(11).font('Helvetica').text(proj.description || 'N/A');
    doc.moveDown(1);

    // Timeline of phases
    doc.fontSize(13).font('Helvetica-Bold').text('Research Timeline');
    doc.moveDown(0.3);
    for (const ph of (phases || [])) {
      if (doc.y > 700) doc.addPage();
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#666').text(`[${ph.phase.toUpperCase()}] ${ph.professor_name} — ${new Date(ph.created_at).toLocaleDateString()}`);
      doc.moveDown(0.1);
      doc.fontSize(10).font('Helvetica').fillColor('#000').text(ph.content || 'No content');
      doc.moveDown(0.5);
    }

    // User comments
    if (comments?.length) {
      if (doc.y > 600) doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').text('User Comments & Feedback');
      doc.moveDown(0.3);
      for (const c of comments) {
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#066').text(`${c.author}:`);
        doc.fontSize(10).font('Helvetica').fillColor('#000').text(c.content);
        doc.moveDown(0.3);
      }
    }

    doc.end();
    return new Promise(resolve => {
      doc.on('end', async () => {
        const buffer = Buffer.concat(chunks);
        const path = `research-${projectId}.pdf`;
        const { error } = await supabase.storage.from('research-pdfs').upload(path, buffer, { contentType: 'application/pdf', upsert: true });
        if (error) console.log('[pdf] Storage upload note:', error.message);
        // Also save URL in project
        const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/research-pdfs/${path}`;
        await supabase.from('projects').update({ metadata: { pdf_url: url } }).eq('id', projectId);
        console.log(`[pdf] Generated: ${proj.title}`);
        resolve();
      });
    });
  } catch (e) { console.error('[pdf] Error:', e.message); }
}

// Add download endpoint
app.get('/api/projects/:id/pdf', async (req, res) => {
  const { data: proj } = await supabase.from('projects').select('*').eq('id', req.params.id).single();
  if (!proj?.metadata?.pdf_url) {
    // Generate on-the-fly
    await generateProjectPDF(req.params.id);
    const { data: p2 } = await supabase.from('projects').select('*').eq('id', req.params.id).single();
    if (p2?.metadata?.pdf_url) return res.redirect(p2.metadata.pdf_url);
    return res.status(404).json({ error: 'PDF not ready yet' });
  }
  res.redirect(proj.metadata.pdf_url);
});

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
