// LLM Manager — rate limiting, cost tracking, circuit breaker, prompt caching.
// Wraps the raw chat() function from llm.js.
import { chat as rawChat } from '../llm.js';
import { log } from './logger.js';
import {
  LLM_RATE_LIMIT_RPM, LLM_CIRCUIT_BREAKER_THRESHOLD, LLM_CIRCUIT_BREAKER_RESET_MS,
  PROMPT_CACHE_MAX_SIZE, PROMPT_CACHE_TTL_MS
} from './constants.js';

// === Rate Limiter (sliding window per model) ===
const rateWindows = new Map(); // modelId -> { timestamps: [], windowMs: 60000 }

function checkRateLimit(modelId) {
  const now = Date.now();
  const windowMs = 60000;
  if (!rateWindows.has(modelId)) rateWindows.set(modelId, { timestamps: [] });
  const w = rateWindows.get(modelId);
  // Remove timestamps older than window
  w.timestamps = w.timestamps.filter(t => now - t < windowMs);
  if (w.timestamps.length >= LLM_RATE_LIMIT_RPM) {
    const oldest = w.timestamps[0];
    const waitMs = windowMs - (now - oldest);
    return { allowed: false, waitMs };
  }
  w.timestamps.push(now);
  return { allowed: true, waitMs: 0 };
}

// === Circuit Breaker ===
const circuitState = new Map(); // modelId -> { failures: number, openUntil: number, state: 'closed'|'open' }

function checkCircuit(modelId) {
  const now = Date.now();
  if (!circuitState.has(modelId)) circuitState.set(modelId, { failures: 0, openUntil: 0, state: 'closed' });
  const c = circuitState.get(modelId);
  if (c.state === 'open') {
    if (now >= c.openUntil) {
      c.state = 'half-open';
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: c.openUntil - now };
  }
  return { allowed: true };
}

function recordFailure(modelId) {
  const c = circuitState.get(modelId) || { failures: 0, openUntil: 0, state: 'closed' };
  c.failures++;
  if (c.failures >= LLM_CIRCUIT_BREAKER_THRESHOLD) {
    c.state = 'open';
    c.openUntil = Date.now() + LLM_CIRCUIT_BREAKER_RESET_MS;
    log('warn', 'circuit-breaker', `Model ${modelId} circuit OPEN (${c.failures} failures), cooling down`);
  }
  circuitState.set(modelId, c);
}

function recordSuccess(modelId) {
  const c = circuitState.get(modelId);
  if (c) {
    c.failures = 0;
    c.state = 'closed';
  }
}

// === Prompt Cache (content-hash based dedup) ===
const promptCache = new Map(); // hash -> { result, at }

function hashPrompt(modelId, messages) {
  const key = modelId + ':' + JSON.stringify(messages);
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return String(hash);
}

function getCached(modelId, messages) {
  const h = hashPrompt(modelId, messages);
  const c = promptCache.get(h);
  if (c && Date.now() - c.at < PROMPT_CACHE_TTL_MS) return c.result;
  if (c) promptCache.delete(h);
  return null;
}

function setCache(modelId, messages, result) {
  // Evict oldest if at capacity
  if (promptCache.size >= PROMPT_CACHE_MAX_SIZE) {
    const oldest = promptCache.keys().next().value;
    promptCache.delete(oldest);
  }
  const h = hashPrompt(modelId, messages);
  promptCache.set(h, { result, at: Date.now() });
}

// === Cost Tracking ===
const costLog = []; // { model, tokens_in, tokens_out, timestamp, latency_ms }
const MAX_COST_LOG = 1000;

function recordCost(model, raw, latencyMs) {
  const usage = raw?.usage || {};
  costLog.push({
    model,
    tokens_in: usage.prompt_tokens || 0,
    tokens_out: usage.completion_tokens || 0,
    timestamp: Date.now(),
    latency_ms: latencyMs
  });
  if (costLog.length > MAX_COST_LOG) costLog.shift();
}

export function getCostSummary() {
  const byModel = {};
  let totalIn = 0, totalOut = 0;
  for (const entry of costLog) {
    if (!byModel[entry.model]) byModel[entry.model] = { calls: 0, tokens_in: 0, tokens_out: 0 };
    byModel[entry.model].calls++;
    byModel[entry.model].tokens_in += entry.tokens_in;
    byModel[entry.model].tokens_out += entry.tokens_out;
    totalIn += entry.tokens_in;
    totalOut += entry.tokens_out;
  }
  return { byModel, total_tokens_in: totalIn, total_tokens_out: totalOut, total_calls: costLog.length };
}

export function getCircuitStatus() {
  const status = {};
  for (const [modelId, state] of circuitState) {
    status[modelId] = { state: state.state, failures: state.failures, openUntil: state.openUntil };
  }
  return status;
}

// === Main exported chat function ===
export async function chat(modelId, messages, opts = {}) {
  // 1. Check circuit breaker
  const circuit = checkCircuit(modelId);
  if (!circuit.allowed) {
    log('warn', 'llm', `Circuit open for ${modelId}, retry after ${circuit.retryAfterMs}ms`);
    throw new Error(`Circuit breaker open for ${modelId}`);
  }

  // 2. Check rate limit
  const rate = checkRateLimit(modelId);
  if (!rate.allowed) {
    log('warn', 'llm', `Rate limit hit for ${modelId}, waiting ${rate.waitMs}ms`);
    await new Promise(r => setTimeout(r, rate.waitMs));
    // Re-check after wait
    const recheck = checkRateLimit(modelId);
    if (!recheck.allowed) {
      throw new Error(`Rate limit exceeded for ${modelId}`);
    }
  }

  // 3. Check prompt cache
  if (opts.useCache !== false) {
    const cached = getCached(modelId, messages);
    if (cached) {
      log('debug', 'llm', `Cache hit for ${modelId}`);
      return cached;
    }
  }

  // 4. Call LLM with cost tracking
  const start = Date.now();
  try {
    const result = await rawChat(modelId, messages, opts);
    const latency = Date.now() - start;
    recordSuccess(modelId);
    recordCost(modelId, result.raw, latency);

    // 5. Cache successful results
    if (opts.useCache !== false) {
      setCache(modelId, messages, result);
    }

    log('debug', 'llm', `OK ${modelId} in ${latency}ms, ${(result.raw?.usage?.total_tokens || '?')} tokens`);
    return result;
  } catch (e) {
    recordFailure(modelId);
    log('error', 'llm', `FAIL ${modelId}: ${e.message}`);
    throw e;
  }
}

export { chat as rawChat } from '../llm.js';
export { MODEL_IDS } from '../llm.js';
