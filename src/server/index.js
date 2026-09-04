// Express server — slim bootstrap. All logic lives in routes/ and lib/.
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { buildRoster } from './professors.js';
import { Senate } from './senate.js';
import { supabase, ping } from './supabase.js';
import { initTelegram, stopTelegram } from './telegram.js';
import { projectLoop } from './lib/project-logic.js';
import { log } from './lib/logger.js';
import { getCostSummary, getCircuitStatus } from './lib/llm-manager.js';
import { PORT, JSON_BODY_LIMIT } from './lib/constants.js';
import ctx from './lib/context.js';

import professorRoutes from './routes/professors.js';
import askRoutes from './routes/ask.js';
import debateRoutes from './routes/debates.js';
import dataRoutes from './routes/data.js';
import projectRoutes from './routes/projects.js';
import pageRoutes from './routes/pages.js';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// Serve Supabase config to frontend (anon key is safe to expose)
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  });
});

app.get('/api/health', async (req, res) => {
  try {
    await ping();
    res.json({ ok: true, professors: ctx.senate?.roster.length || 0, running: !!ctx.senate?.running });
  } catch (e) { res.status(500).json({ ok: false, err: String(e) }); }
});

// LLM cost & circuit status
app.get('/api/llm/stats', (req, res) => {
  res.json({ costs: getCostSummary(), circuit: getCircuitStatus() });
});

// Mount all route modules (they read from ctx.senate at request time)
app.use(professorRoutes());
app.use(askRoutes());
app.use(debateRoutes());
app.use(dataRoutes());
app.use(projectRoutes());
app.use(pageRoutes());

async function main() {
  log('info', 'boot', 'Verifying Supabase...');
  try {
    const result = await ping();
    log('info', 'boot', `Supabase ping: ${result}`);
  } catch (e) {
    log('error', 'boot', `Could not reach Supabase: ${e.message}`);
  }

  log('info', 'boot', 'Building roster...');
  const roster = buildRoster();
  log('info', 'boot', `Roster built: ${roster.length}`);

  ctx.senate = new Senate(roster);
  log('info', 'boot', 'Senate created, booting...');
  await ctx.senate.boot();
  log('info', 'boot', 'Senate booted');

  log('info', 'boot', 'Starting Telegram...');
  await initTelegram(ctx.senate);
  log('info', 'boot', 'Telegram initialized');

  process.on('SIGINT', () => { stopTelegram(); process.exit(0); });
  process.on('SIGTERM', () => { stopTelegram(); process.exit(0); });

  const port = PORT;
  app.listen(port, () => {
    log('info', 'boot', `Professor Senate running on http://localhost:${port}`);
  });

  ctx.senate.startLoop().catch(e => log('error', 'loop', `Loop crashed: ${e.message}`));
  projectLoop(ctx.senate);
}

main().catch(e => { log('error', 'fatal', e.message); process.exit(1); });
