// Route: /api/journals, /api/logs, /api/learnings, /api/activity, /api/peer-reviews, /api/fact-checks
import { Router } from 'express';
import { supabase } from '../supabase.js';

export default function dataRoutes() {
  const r = Router();

  r.get('/api/journals', async (req, res) => {
    const limit = parseInt(req.query.limit || '50', 10);
    const prof = req.query.professor_id;
    let q = supabase.from('journals').select('*').order('created_at', { ascending: false }).limit(limit);
    if (prof) q = q.eq('professor_id', prof);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  r.get('/api/logs', async (req, res) => {
    const limit = parseInt(req.query.limit || '100', 10);
    const prof = req.query.professor_id;
    let q = supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(limit);
    if (prof) q = q.eq('professor_id', prof);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  r.get('/api/learnings', async (req, res) => {
    const prof = req.query.professor_id;
    let q = supabase.from('learnings').select('*').order('created_at', { ascending: false }).limit(50);
    if (prof) q = q.eq('professor_id', prof);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  r.get('/api/activity', async (req, res) => {
    const limit = parseInt(req.query.limit || '20', 10);
    const { data, error } = await supabase.from('journals').select('*, professors(name, avatar_color, university)').order('created_at', { ascending: false }).limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  r.get('/api/peer-reviews', async (req, res) => {
    const projectId = req.query.project_id;
    let q = supabase.from('peer_reviews').select('*').order('created_at', { ascending: false }).limit(50);
    if (projectId) q = q.eq('project_id', projectId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  r.get('/api/fact-checks', async (req, res) => {
    const projectId = req.query.project_id;
    let q = supabase.from('fact_checks').select('*').order('created_at', { ascending: false }).limit(50);
    if (projectId) q = q.eq('project_id', projectId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  return r;
}
