// Route: /api/professors/*
import { Router } from 'express';
import { supabase } from '../supabase.js';
import { getFeed } from '../feed.js';
import ctx from '../lib/context.js';

export default function professorRoutes() {
  const r = Router();

  r.get('/api/professors', (req, res) => {
    if (!ctx.senate) return res.status(503).json({ error: 'Senate not ready' });
    res.json(ctx.senate.roster);
  });

  r.get('/api/professors/:id/detail', async (req, res) => {
    if (!ctx.senate) return res.status(503).json({ error: 'Senate not ready' });
    const record = ctx.senate.roster.find(x => x.id === req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const prof = ctx.senate.professors.get(record.id);
    const [journals, logs, learnings] = await Promise.all([
      supabase.from('journals').select('*').eq('professor_id', record.id).order('created_at', { ascending: false }).limit(5),
      supabase.from('logs').select('*').eq('professor_id', record.id).order('created_at', { ascending: false }).limit(10),
      supabase.from('learnings').select('*').eq('professor_id', record.id).order('created_at', { ascending: false }).limit(10)
    ]);
    res.json({
      ...record,
      status: record.status || 'idle',
      last_journal: journals.data?.[0] || null,
      last_log: logs.data?.[0] || null,
      recent_journals: journals.data || [],
      recent_logs: logs.data || [],
      recent_learnings: learnings.data || [],
      memory_size: prof?.learnings?.length || 0,
      working_memory_size: prof?.memory?.length || 0
    });
  });

  r.post('/api/professors/:id/tick', async (req, res) => {
    if (!ctx.senate) return res.status(503).json({ error: 'Senate not ready' });
    const p = ctx.senate.professors.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    try {
      const feed = await getFeed();
      await ctx.senate.tickProfessor(p, feed);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  r.post('/api/professors/tick-all', async (req, res) => {
    if (!ctx.senate) return res.status(503).json({ error: 'Senate not ready' });
    try {
      const out = await ctx.senate.tickAll();
      res.json({ ok: true, ...out });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  r.post('/api/professors/:id/position', async (req, res) => {
    const { x, y } = req.body || {};
    const { error } = await supabase.from('professors').update({ position_x: x, position_y: y }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  return r;
}
