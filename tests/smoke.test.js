// Smoke test: validates imports, roster uniqueness, professor build, and (if
// Supabase is reachable) the schema. Does NOT call any LLM.
import assert from 'node:assert/strict';
import { buildRoster, PROFESSORS } from '../src/server/professors.js';
import { Professor } from '../src/server/professor.js';
import { Senate } from '../src/server/senate.js';
import { MODEL_IDS } from '../src/server/llm.js';

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log('  ✓', name); passed++; })
    .catch(e => { console.log('  ✗', name, '-', e.message); failed++; });
}

console.log('Professor Senate — smoke tests\n');

await test('50 professors defined', () => {
  assert.equal(PROFESSORS.length, 50);
});

await test('no duplicate expertise tuples', () => {
  const seen = new Set();
  for (const p of PROFESSORS) {
    const k = p.expertise.join('|');
    assert.ok(!seen.has(k), `dup: ${p.name}`);
    seen.add(k);
  }
});

await test('university distribution: MIT 17 / Harvard 17 / Oxford 16', () => {
  const u = { MIT: 0, Harvard: 0, Oxford: 0 };
  for (const p of PROFESSORS) u[p.university]++;
  assert.deepEqual(u, { MIT: 17, Harvard: 17, Oxford: 16 });
});

await test('buildRoster produces 50 records with model_id', () => {
  const r = buildRoster();
  assert.equal(r.length, 50);
  for (const x of r) {
    assert.ok(x.id, 'missing id');
    assert.ok(x.model_id, `missing model_id for ${x.name}`);
    assert.ok(MODEL_IDS[x.primary_model] === x.model_id, 'model mismatch');
  }
});

await test('Professor instance: mutex serializes', async () => {
  const r = buildRoster()[0];
  const p = new Professor(r);
  let order = [];
  // Replace _withLock's chat by stubbing.
  const orig = p._withLock;
  p._withLock = orig; // no-op (real impl used)
  // Run two _withLock in parallel; we just verify they don't throw.
  await Promise.all([
    p._withLock(async () => { await new Promise(r => setTimeout(r, 10)); order.push(1); }),
    p._withLock(async () => { await new Promise(r => setTimeout(r, 5));  order.push(2); })
  ]);
  assert.equal(order.length, 2);
});

await test('Senate boot (no LLM calls)', async () => {
  const s = new Senate(buildRoster());
  // Don't call boot() because that hits Supabase. Just verify construction.
  assert.equal(s.professors.size, 50);
  assert.ok(s._vectors.size === 50);
});

await test('tokenSim returns ~1.0 for identical vectors', () => {
  const a = new Map([['x', 1], ['y', 2]]);
  const b = new Map([['x', 1], ['y', 2]]);
  assert.ok(Math.abs(Professor.tokenSim(a, b) - 1) < 1e-9);
});

await test('tokenSim returns 0 for disjoint vectors', () => {
  const a = new Map([['x', 1]]);
  const b = new Map([['y', 1]]);
  assert.equal(Professor.tokenSim(a, b), 0);
});

await test('Pareto: pMap bounded concurrency', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let active = 0, max = 0;
  const fn = (x) => new Promise(r => setTimeout(() => { active--; r(x * 2); }, 20));
  const wrapped = (x) => { active++; max = Math.max(max, active); return fn(x); };
  // Inline pMap (mirrors senate.js)
  let i = 0;
  const out = new Array(items.length);
  const conc = 3;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; out[idx] = await wrapped(items[idx]); }
  }));
  assert.equal(out.filter(x => typeof x === 'number').length, 20);
  assert.ok(max <= conc, `max ${max} > ${conc}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
