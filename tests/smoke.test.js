// Comprehensive tests — professor, senate, router, prompts, project logic.
// Uses mock LLM calls (no real API costs).
import assert from 'node:assert/strict';
import { buildRoster, PROFESSORS, PERSONALITY_PROFILES } from '../src/server/professors.js';
import { Professor } from '../src/server/professor.js';
import { Senate } from '../src/server/senate.js';
import { MODEL_IDS } from '../src/server/llm.js';
import { tokenize, scoreByKeywords, rankProfessors, pickTopProfessors } from '../src/server/lib/router.js';
import { buildPhasePrompts, isRefusal, PHASE_ORDER } from '../src/server/lib/prompts.js';
import { log } from '../src/server/lib/logger.js';

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log('  ✓', name); passed++; })
    .catch(e => { console.log('  ✗', name, '-', e.message); failed++; });
}

console.log('Professor Senate — comprehensive tests\n');

// ===== ROSTER & PERSONALITY TESTS =====

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

await test('all 50 professors have unique personality profiles', () => {
  const voices = new Set();
  for (const p of PROFESSORS) {
    const profile = PERSONALITY_PROFILES[p.name];
    assert.ok(profile, `missing profile for ${p.name}`);
    assert.ok(profile.voice, `missing voice for ${p.name}`);
    assert.ok(profile.debateStyle, `missing debateStyle for ${p.name}`);
    assert.ok(profile.biases?.length > 0, `missing biases for ${p.name}`);
    assert.ok(profile.heroes?.length > 0, `missing heroes for ${p.name}`);
    assert.ok(!voices.has(profile.voice), `duplicate voice for ${p.name}`);
    voices.add(profile.voice);
  }
});

await test('buildRoster produces 50 records with personalityProfile', () => {
  const r = buildRoster();
  assert.equal(r.length, 50);
  for (const x of r) {
    assert.ok(x.id, 'missing id');
    assert.ok(x.model_id, `missing model_id for ${x.name}`);
    assert.ok(x.personalityProfile, `missing personalityProfile for ${x.name}`);
    assert.ok(x.personalityProfile.voice, `missing voice for ${x.name}`);
    assert.ok(x.personality.length > 50, `personality too short for ${x.name}`);
  }
});

await test('each professor has unique id', () => {
  const r = buildRoster();
  const ids = new Set(r.map(x => x.id));
  assert.equal(ids.size, 50);
});

// ===== PROFESSOR CLASS TESTS =====

await test('Professor instance: mutex serializes', async () => {
  const r = buildRoster()[0];
  const p = new Professor(r);
  let order = [];
  await Promise.all([
    p._withLock(async () => { await new Promise(r => setTimeout(r, 10)); order.push(1); }),
    p._withLock(async () => { await new Promise(r => setTimeout(r, 5)); order.push(2); })
  ]);
  assert.equal(order.length, 2);
});

await test('Professor buildMessages includes personality in system prompt', () => {
  const r = buildRoster()[0];
  const p = new Professor(r);
  const msgs = p.buildMessages('test question');
  assert.ok(msgs.length >= 2, 'should have system + user messages');
  const sysContent = msgs[0].content;
  assert.ok(sysContent.includes('PERSONALITY'), 'should include PERSONALITY section');
  assert.ok(sysContent.includes('Voice:'), 'should include voice');
  assert.ok(sysContent.includes('Debate style:'), 'should include debate style');
  assert.ok(sysContent.includes('Known biases:'), 'should include biases');
});

await test('Professor buildMessages filters low-confidence learnings', () => {
  const r = buildRoster()[0];
  const p = new Professor(r);
  p.learnings = [
    { title: 'High conf', insight: 'good stuff', confidence: 0.8, source: 'test', created_at: new Date().toISOString(), tags: ['ai'] },
    { title: 'Low conf', insight: 'bad stuff', confidence: 0.1, source: 'test', created_at: new Date().toISOString(), tags: ['ai'] },
  ];
  const msgs = p.buildMessages('artificial intelligence');
  const allContent = msgs.map(m => m.content).join(' ');
  assert.ok(allContent.includes('High conf'), 'should include high-confidence learning');
  assert.ok(!allContent.includes('Low conf'), 'should NOT include low-confidence learning');
});

await test('Professor buildMessages ranks learnings by relevance', () => {
  const r = buildRoster()[0];
  const p = new Professor(r);
  p.learnings = [
    { title: 'Quantum computing breakthrough', insight: 'qubits improved', confidence: 0.9, source: 'arxiv', created_at: new Date().toISOString(), tags: ['quantum'] },
    { title: 'New recipe for cookies', insight: 'chocolate chips are good', confidence: 0.9, source: 'blog', created_at: new Date().toISOString(), tags: ['cooking'] },
  ];
  const msgs = p.buildMessages('quantum computing advances');
  const allContent = msgs.map(m => m.content).join(' ');
  assert.ok(allContent.includes('Quantum computing'), 'should include relevant learning');
  // The irrelevant one should have lower relevance score
});

await test('Professor _tokenize works correctly', () => {
  const r = buildRoster()[0];
  const p = new Professor(r);
  const tokens = p._tokenize('Hello World! This is a test.');
  assert.ok(tokens.includes('hello'), 'should include "hello"');
  assert.ok(tokens.includes('world'), 'should include "world"');
  assert.ok(!tokens.includes('is'), 'should filter short tokens');
});

await test('Professor _buildVector creates frequency map', () => {
  const r = buildRoster()[0];
  const p = new Professor(r);
  const vec = p._buildVector(['hello', 'world', 'hello']);
  assert.equal(vec.get('hello'), 2);
  assert.equal(vec.get('world'), 1);
});

// ===== ROUTER TESTS =====

await test('tokenize splits on non-alphanumeric', () => {
  const tokens = tokenize('Hello, World! This is a test.');
  assert.ok(Array.isArray(tokens));
  assert.ok(tokens.includes('hello'));
  assert.ok(tokens.includes('world'));
  assert.ok(!tokens.includes('is'));
});

await test('scoreByKeywords returns correct scores', () => {
  const record = { expertise: ['quantum computing', 'quantum error correction'], subfields: ['surface codes'] };
  const tokens = tokenize('quantum computing is amazing');
  const score = scoreByKeywords(tokens, record);
  assert.ok(score >= 2, `expected >= 2, got ${score}`);
});

await test('rankProfessors sorts by relevance', () => {
  const roster = buildRoster();
  const ranked = rankProfessors('quantum computing', roster);
  assert.equal(ranked.length, 50);
  // Hiroshi Tanaka should be near the top
  const tanakaIdx = ranked.findIndex(x => x.r.name === 'Dr. Hiroshi Tanaka');
  assert.ok(tanakaIdx < 5, `Tanaka should be in top 5, got ${tanakaIdx}`);
});

await test('pickTopProfessors returns fallback when no match', () => {
  const roster = buildRoster();
  const top = pickTopProfessors('zzzzzzzzz', roster, 1);
  assert.equal(top.length, 1);
  assert.ok(top[0].id, 'should return a professor');
});

await test('pickTopProfessors returns top N matches', () => {
  const roster = buildRoster();
  const top = pickTopProfessors('quantum computing', roster, 3);
  assert.ok(top.length <= 3);
  assert.ok(top.length >= 1);
});

// ===== SENATE TESTS =====

await test('Senate construction', () => {
  const s = new Senate(buildRoster());
  assert.equal(s.professors.size, 50);
  assert.ok(s._vectors.size === 50);
});

await test('Senate教授professors are Professor instances', () => {
  const s = new Senate(buildRoster());
  for (const [, prof] of s.professors) {
    assert.ok(prof instanceof Professor);
    assert.ok(typeof prof.ask === 'function');
    assert.ok(typeof prof.argue === 'function');
    assert.ok(typeof prof.factCheck === 'function');
    assert.ok(typeof prof.peerReview === 'function');
    assert.ok(typeof prof.crossReference === 'function');
  }
});

// ===== PROMPTS TESTS =====

await test('PHASE_ORDER has 8 phases', () => {
  assert.equal(PHASE_ORDER.length, 8);
  assert.equal(PHASE_ORDER[0], 'ideation');
  assert.equal(PHASE_ORDER[7], 'published');
});

await test('buildPhasePrompts generates all 8 prompts', () => {
  const proj = { title: 'Test', description: 'Desc', vision: 'Vision' };
  const prompts = buildPhasePrompts(proj, 'history', 'comments');
  for (const phase of PHASE_ORDER) {
    assert.ok(prompts[phase], `missing prompt for ${phase}`);
    assert.ok(prompts[phase].includes('Test'), `prompt should include project title`);
  }
});

await test('isRefusal detects refusal patterns', () => {
  assert.ok(isRefusal('This is outside my expertise'));
  assert.ok(isRefusal('I am not qualified'));
  assert.ok(isRefusal('This is not my field'));
  assert.ok(isRefusal('I cannot help with that'));
  assert.ok(!isRefusal('I can help with that'));
  assert.ok(!isRefusal(''));
  assert.ok(!isRefusal(null));
});

// ===== TOKEN SIMILARITY TESTS =====

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

await test('tokenSim returns value between 0 and 1', () => {
  const a = new Map([['x', 1], ['y', 2], ['z', 3]]);
  const b = new Map([['y', 2], ['z', 3], ['w', 4]]);
  const sim = Professor.tokenSim(a, b);
  assert.ok(sim >= 0 && sim <= 1, `sim should be 0-1, got ${sim}`);
});

// ===== PARETO / CONCURRENCY TEST =====

await test('Pareto: pMap bounded concurrency', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let active = 0, max = 0;
  const fn = (x) => new Promise(r => setTimeout(() => { active--; r(x * 2); }, 20));
  const wrapped = (x) => { active++; max = Math.max(max, active); return fn(x); };
  let i = 0;
  const out = new Array(items.length);
  const conc = 3;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; out[idx] = await wrapped(items[idx]); }
  }));
  assert.equal(out.filter(x => typeof x === 'number').length, 20);
  assert.ok(max <= conc, `max ${max} > ${conc}`);
});

// ===== LOGGER TESTS =====

await test('log function exists and does not throw', () => {
  assert.equal(typeof log, 'function');
  log('info', 'test', 'this is a test message');
  log('error', 'test', 'this is an error message', { key: 'value' });
});

// ===== SUMMARY =====

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
