// Route: /api/ask
import { Router } from 'express';
import { supabase } from '../supabase.js';
import { pickTopProfessors } from '../lib/router.js';
import ctx from '../lib/context.js';

export default function askRoutes() {
  const r = Router();

  r.post('/api/ask', async (req, res) => {
    if (!ctx.senate) return res.status(503).json({ error: 'Senate not ready' });
    const { prompt, professor_id } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    if (professor_id) {
      try {
        const p = ctx.senate.professors.get(professor_id);
        if (!p) return res.status(404).json({ error: 'professor not found' });
        const out = await p.ask(prompt, { temperature: 0.7, max_tokens: 800 });
        const j = await p.journal('response', { title: `Reply: ${prompt.slice(0, 60)}`, content: out.content, user_prompt: prompt });
        return res.json({ answers: [{ professor_id, professor_name: p.record.name, expertise: p.record.expertise, content: out.content, model: out.model, journal_id: j?.id }] });
      } catch (e) { return res.status(500).json({ error: String(e) }); }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const top = pickTopProfessors(prompt, ctx.senate.roster, 1);
    await supabase.from('user_messages').insert({ prompt, routed_to: top.map(t => t.id), response: null });

    const tasks = top.map(async (r) => {
      const prof = ctx.senate.professors.get(r.id);
      try {
        const { content, model } = await prof.ask(prompt, { temperature: 0.7, max_tokens: 800 });
        const journal = await prof.journal('response', {
          title: `Reply to user: ${prompt.slice(0, 60)}`, content, topic: prompt, user_prompt: prompt, metadata: { model }
        });
        res.write(`data: ${JSON.stringify({ professor_id: r.id, professor_name: r.name, expertise: r.expertise, content, model, journal_id: journal?.id })}\n\n`);
      } catch (e) {
        res.write(`data: ${JSON.stringify({ error: String(e), professor_id: r.id })}\n\n`);
      }
    });

    await Promise.allSettled(tasks);
    res.write(`data: [DONE]\n\n`);
    res.end();
  });

  return r;
}
