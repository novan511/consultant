// Route: Static page routes
import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default function pageRoutes() {
  const r = Router();

  r.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', '..', '..', 'public', 'index.html')));
  r.get('/professor/:id', (req, res) => res.sendFile(path.join(__dirname, '..', '..', '..', 'public', 'professor.html')));
  r.get('/projects', (req, res) => res.sendFile(path.join(__dirname, '..', '..', '..', 'public', 'projects.html')));
  r.get('/projects/:id', (req, res) => res.sendFile(path.join(__dirname, '..', '..', '..', 'public', 'project-detail.html')));

  return r;
}
