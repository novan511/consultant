-- ============================================================
-- PROFESSOR SENATE — Supabase Schema
-- Run this in the Supabase SQL editor once.
-- Safe to re-run; uses IF NOT EXISTS / CREATE OR REPLACE.
-- ============================================================

CREATE TABLE IF NOT EXISTS professors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT,
  university TEXT,
  expertise TEXT[] NOT NULL,
  subfields TEXT[],
  primary_model TEXT NOT NULL,
  model_id TEXT,
  fallback_models TEXT[],
  personality TEXT,
  avatar_color TEXT,
  position_x INT DEFAULT 100,
  position_y INT DEFAULT 100,
  status TEXT DEFAULT 'idle',
  last_active TIMESTAMPTZ DEFAULT now(),
  total_interactions INT DEFAULT 0,
  knowledge_vector JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Backfill: add columns that may be missing from older deployments.
ALTER TABLE professors ADD COLUMN IF NOT EXISTS model_id TEXT;

CREATE TABLE IF NOT EXISTS journals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  professor_id TEXT REFERENCES professors(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  topic TEXT,
  tags TEXT[],
  source_refs TEXT[],
  related_professors TEXT[],
  user_prompt TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE journals ADD COLUMN IF NOT EXISTS source_refs TEXT[];

CREATE INDEX IF NOT EXISTS idx_journals_prof    ON journals(professor_id);
CREATE INDEX IF NOT EXISTS idx_journals_kind    ON journals(kind);
CREATE INDEX IF NOT EXISTS idx_journals_created ON journals(created_at DESC);

CREATE TABLE IF NOT EXISTS logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  professor_id TEXT REFERENCES professors(id) ON DELETE SET NULL,
  level TEXT DEFAULT 'info',
  category TEXT,
  message TEXT NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_logs_prof    ON logs(professor_id);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);

CREATE TABLE IF NOT EXISTS debates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  initiated_by TEXT REFERENCES professors(id) ON DELETE SET NULL,
  participants TEXT[],
  status TEXT DEFAULT 'open',
  turns JSONB DEFAULT '[]'::jsonb,
  conclusion TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  professor_id TEXT REFERENCES professors(id) ON DELETE CASCADE,
  source TEXT,
  url TEXT,
  title TEXT,
  summary TEXT,
  insight TEXT,
  confidence REAL DEFAULT 0.5,
  applied_count INT DEFAULT 0,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_learnings_prof ON learnings(professor_id);

CREATE TABLE IF NOT EXISTS user_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt TEXT NOT NULL,
  routed_to TEXT[],
  response TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- RESEARCH PROJECTS — collaborative invention pipeline
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  vision TEXT,
  status TEXT DEFAULT 'ideation',
  phase_summary TEXT,
  assigned_professors TEXT[],
  active_professor TEXT,
  created_by TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

CREATE TABLE IF NOT EXISTS project_phases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  professor_id TEXT,
  professor_name TEXT,
  action TEXT NOT NULL,
  content TEXT,
  arguments_for TEXT[],
  arguments_against TEXT[],
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pp_phases_project ON project_phases(project_id);

CREATE TABLE IF NOT EXISTS project_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  author TEXT DEFAULT 'user',
  content TEXT NOT NULL,
  read_by_professors BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pc_comments_project ON project_comments(project_id);

-- Atomic counter bumps
CREATE OR REPLACE FUNCTION bump_professor_interactions(p_id TEXT) RETURNS void AS $$
BEGIN
  UPDATE professors SET total_interactions = COALESCE(total_interactions, 0) + 1 WHERE id = p_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bump_applied_count(p_id TEXT) RETURNS void AS $$
BEGIN
  UPDATE learnings
     SET applied_count = COALESCE(applied_count, 0) + 1
   WHERE professor_id = p_id
     AND id IN (SELECT id FROM learnings WHERE professor_id = p_id ORDER BY created_at DESC LIMIT 3);
END;
$$ LANGUAGE plpgsql;

-- Realtime: idempotent add (skip if already in publication).
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE journals;   EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE logs;       EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE debates;    EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE professors; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE learnings;  EXCEPTION WHEN duplicate_object THEN NULL; END;
END$$;
