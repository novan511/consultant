// Route: /api/ask — user chat goes through Spectator first
import { Router } from 'express';
import { supabase } from '../supabase.js';
import spectator from '../lib/spectator.js';
import ctx from '../lib/context.js';

export default function askRoutes() {
  const r = Router();

  // Spectator status
  r.get('/api/spectator/status', (req, res) => {
    res.json(spectator.getStatus());
  });

  r.post('/api/ask', async (req, res) => {
    if (!ctx.senate) return res.status(503).json({ error: 'Senate not ready' });
    const { prompt, professor_id, direct_to_professor } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // Direct ask to specific professor (bypass spectator)
    if (professor_id) {
      try {
        const p = ctx.senate.professors.get(professor_id);
        if (!p) return res.status(404).json({ error: 'professor not found' });
        const out = await p.ask(prompt, { temperature: 0.7, max_tokens: 800 });
        const j = await p.journal('response', { title: `Reply: ${prompt.slice(0, 60)}`, content: out.content, user_prompt: prompt });
        return res.json({ answers: [{ professor_id, professor_name: p.record.name, expertise: p.record.expertise, content: out.content, model: out.model, journal_id: j?.id, source: 'professor' }] });
      } catch (e) { return res.status(500).json({ error: String(e) }); }
    }

    // SSE streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    try {
      // Step 1: Spectator answers from observation (fast, no professor delay)
      const spectatorAnswer = await spectator.askUserQuestion(prompt);

      // Check if spectator suggests routing to a professor
      const routeMatch = spectatorAnswer.match(/\[ROUTE:(\w+)\]/);
      const shouldRouteToProfessor = routeMatch || direct_to_professor;

      // Stream spectator answer
      const spectatorChunks = spectatorAnswer.split(/(?<=[.!?\n])\s+/);
      for (const chunk of spectatorChunks) {
        res.write(`data: ${JSON.stringify({
          source: 'spectator',
          content: chunk + ' ',
          done: false
        })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ source: 'spectator', content: '', done: true })}\n\n`);

      // Step 2: If topic needs deep expertise, also ask the best professor
      const prof = spectator.routeToProfessor(prompt);
      if (prof && prof.score > 2) {
        const profInstance = ctx.senate.professors.get(prof.id);
        if (profInstance) {
          // Notify user that professor is also responding
          res.write(`data: ${JSON.stringify({ source: 'system', content: `\n\n--- ${prof.name} is also responding ---\n` })}\n\n`);

          const out = await profInstance.ask(prompt, { temperature: 0.7, max_tokens: 800 });
          await profInstance.journal('response', {
            title: `Reply to user: ${prompt.slice(0, 60)}`,
            content: out.content, topic: prompt, user_prompt: prompt,
            metadata: { model: out.model, via: 'spectator-route' }
          });

          // Stream professor answer
          const profChunks = out.content.split(/(?<=[.!?\n])\s+/);
          for (const chunk of profChunks) {
            res.write(`data: ${JSON.stringify({
              source: 'professor',
              professor_id: prof.id,
              professor_name: prof.name,
              expertise: prof.expertise,
              content: chunk + ' ',
              model: out.model,
              done: false
            })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ source: 'professor', content: '', done: true })}\n\n`);
        }
      }
    } catch (e) {
      const msg = String(e.message || e).replace(/^Error:\s*/, '');
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    }

    res.write(`data: [DONE]\n\n`);
    res.end();
  });

  return r;
}
