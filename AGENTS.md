# Agent notes for this repo

- **Run** `npm install` first, then `npm run seed` to insert the 50 professors, then `npm start` to boot.
- The schema lives in `src/server/schema.sql`; run it in the Supabase SQL editor once.
- LLM keys are hard-coded in `src/server/llm.js`. For production, move them to `.env` and read from `process.env`.
- Each professor in `src/server/professors.js` is unique. When adding new ones, ensure `expertise` arrays don't overlap with any existing professor (use the `verify-expertise` script below).
- 24/7 loop is in `Senate.startLoop()` in `src/server/senate.js`. The cycle loops forever and yields a 1.5s delay per professor to avoid rate-limit spikes.
- Debates persist every turn to `debates.turns` (JSONB) so users can replay the whole exchange.
- UI position is persisted to Supabase via `POST /api/professors/:id/position` on drag-end.

## Tests
There are no automated tests yet. Quick smoke test:

```powershell
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/ask -H "Content-Type: application/json" -d '{\"prompt\":\"hello\"}'   # NOTE: use proper escaping
```

Or open the UI and click around.

## Verify expertise uniqueness
```powershell
node -e "import('./src/server/professors.js').then(m => { const seen = new Map(); for (const p of m.PROFESSORS) { const k = p.expertise.join('|'); if (seen.has(k)) console.log('DUP', p.name, '<->', seen.get(k)); seen.set(k, p.name);} console.log('Total', m.PROFESSORS.length);})"
```
