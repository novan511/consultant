// Route: /api/projects/*
import { Router } from 'express';
import { supabase } from '../supabase.js';
import { advanceProject, runDiscussion, smartAssign } from '../lib/project-logic.js';
import { generateProjectPDF } from '../lib/pdf.js';
import { log } from '../lib/logger.js';
import ctx from '../lib/context.js';

export default function projectRoutes() {
  const r = Router();

  r.get('/api/projects', async (req, res) => {
    const { data, error } = await supabase.from('projects').select('*').order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  r.post('/api/projects', async (req, res) => {
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

  r.get('/api/projects/:id', async (req, res) => {
    const [proj, phases, comments, peerReviews, factChecks] = await Promise.all([
      supabase.from('projects').select('*').eq('id', req.params.id).single(),
      supabase.from('project_phases').select('*').eq('project_id', req.params.id).order('created_at', { ascending: true }),
      supabase.from('project_comments').select('*').eq('project_id', req.params.id).order('created_at', { ascending: true }),
      supabase.from('peer_reviews').select('*').eq('project_id', req.params.id).order('created_at', { ascending: false }),
      supabase.from('fact_checks').select('*').eq('project_id', req.params.id).order('created_at', { ascending: false })
    ]);
    if (proj.error) return res.status(404).json({ error: 'not found' });
    res.json({
      ...proj.data,
      phases: phases.data || [],
      comments: comments.data || [],
      peer_reviews: peerReviews.data || [],
      fact_checks: factChecks.data || []
    });
  });

  r.post('/api/projects/:id/discuss', async (req, res) => {
    if (!ctx.senate) return res.status(503).json({ error: 'Senate not ready' });
    const { id } = req.params;
    const { topic } = req.body || {};
    const { data: proj } = await supabase.from('projects').select('*').eq('id', id).single();
    if (!proj) return res.status(404).json({ error: 'not found' });

    if (proj.metadata?.discussion_running) return res.json({ ok: true, status: 'already_running' });

    await supabase.from('projects').update({ metadata: { discussion_running: true } }).eq('id', id);

    runDiscussion(id, topic, proj, ctx.senate).catch(e => {
      log('error', 'discussion', `Background error: ${e.message}`);
      supabase.from('projects').update({ metadata: { discussion_running: false } }).eq('id', id);
    });

    res.json({ ok: true, status: 'started' });
  });

  r.post('/api/projects/:id/comment', async (req, res) => {
    const { author, content } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    const { data, error } = await supabase.from('project_comments').insert({
      project_id: req.params.id, author: author || 'user', content
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  r.post('/api/projects/:id/advance', async (req, res) => {
    if (!ctx.senate) return res.status(503).json({ error: 'Senate not ready' });
    const { id } = req.params;
    const { data: proj } = await supabase.from('projects').select('*').eq('id', id).single();
    if (!proj) return res.status(404).json({ error: 'not found' });

    advanceProject(id, proj, ctx.senate).catch(e => log('error', 'advance', `Error: ${e.message}`));
    res.json({ ok: true, status: 'advancing' });
  });

  r.get('/api/projects/:id/pdf', async (req, res) => {
    const { data: proj } = await supabase.from('projects').select('*').eq('id', req.params.id).single();
    if (!proj?.metadata?.pdf_url) {
      await generateProjectPDF(req.params.id);
      const { data: p2 } = await supabase.from('projects').select('*').eq('id', req.params.id).single();
      if (p2?.metadata?.pdf_url) return res.redirect(p2.metadata.pdf_url);
      return res.status(404).json({ error: 'PDF not ready yet' });
    }
    res.redirect(proj.metadata.pdf_url);
  });

  return r;
}
