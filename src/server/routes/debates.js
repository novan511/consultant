// Route: /api/debates/*
import { Router } from 'express';
import { supabase } from '../supabase.js';
import ctx from '../lib/context.js';

export default function debateRoutes() {
  const r = Router();

  r.post('/api/debates/trigger', async (req, res) => {
    if (!ctx.senate) return res.status(503).json({ error: 'Senate not ready' });
    const { a, b, topic } = req.body || {};
    try {
      if (a && b) {
        const pa = ctx.senate.professors.get(a), pb = ctx.senate.professors.get(b);
        if (!pa || !pb) return res.status(404).json({ error: 'professor(s) not found' });
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
        await pa.journal('debate', { title: `Debate: ${t.slice(0, 60)}`, content: argA, topic: t, related_professors: [b] });
        await pb.journal('debate', { title: `Debate: ${t.slice(0, 60)}`, content: argB, topic: t, related_professors: [a] });
        return res.json({ ok: true, debate: data });
      }
      const pick = ctx.senate.roster[Math.floor(Math.random() * ctx.senate.roster.length)];
      await ctx.senate.maybeDebate(ctx.senate.professors.get(pick.id));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  r.get('/api/debates', async (req, res) => {
    const { data, error } = await supabase.from('debates').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  r.get('/api/debate-stats', async (req, res) => {
    const { data, error } = await supabase.from('debate_stats').select('*').order('wins', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  return r;
}
