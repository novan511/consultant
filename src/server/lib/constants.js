// Application-wide constants — replaces all magic numbers.
// Every hard-coded number in the codebase should reference this file.

// === Tick scheduling ===
export const TICK_INTERVAL_MS      = parseInt(process.env.AUTO_TICK_MS || '120000', 10);
export const TICK_OVERHEAD_MS      = 5000; // extra buffer between cycles
export const PARALLEL_TICKERS      = parseInt(process.env.PARALLEL_TICKERS || '4', 10);
export const MAX_TICK_DURATION_MS  = 10 * 60 * 1000; // 10 min max per cycle

// === Debate ===
export const DEBATE_PROBABILITY    = parseFloat(process.env.DEBATE_PROBABILITY || '0.15');
export const DEBATE_ROUNDS         = 3;
export const DEBATE_MAX_TOKENS     = 1500;

// === Learning ===
export const LEARN_PROBABILITY     = parseFloat(process.env.LEARN_PROBABILITY || '0.6');
export const MIN_LEARNING_CONFIDENCE = 0.4;
export const MAX_LEARNINGS_CONTEXT  = 8;

// === LLM defaults ===
export const DEFAULT_TEMPERATURE   = 0.7;
export const DEFAULT_MAX_TOKENS    = 800;
export const REFLECTION_TEMPERATURE = 0.9;
export const DEBATE_TEMPERATURE    = 1.0;
export const JUDGE_TEMPERATURE     = 0.3;
export const ROUTING_TEMPERATURE   = 0.2;

// === Feed ===
export const FEED_CACHE_TTL_MS     = parseInt(process.env.FEED_CACHE_TTL || '600000', 10); // 10 min
export const FEED_MAX_RETRIES      = 3;
export const FEED_RETRY_DELAY_MS   = 5000;
export const REDDIT_SUBS           = ['science', 'technology', 'MachineLearning', 'Futurology', 'philosophy', 'economics'];

// === Rate limiting (LLM calls per minute per model) ===
export const LLM_RATE_LIMIT_RPM    = parseInt(process.env.LLM_RATE_LIMIT_RPM || '20', 10);
export const LLM_CIRCUIT_BREAKER_THRESHOLD = 5; // failures before opening circuit
export const LLM_CIRCUIT_BREAKER_RESET_MS  = 60000; // 1 min cooldown

// === Prompt cache ===
export const PROMPT_CACHE_MAX_SIZE = 200;
export const PROMPT_CACHE_TTL_MS   = 30 * 60 * 1000; // 30 min

// === Memory ===
export const MAX_WORKING_MEMORY    = 40;
export const MAX_RECENT_MEMORY     = 6;

// === Client polling ===
export const POLL_INTERVAL_MS      = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
export const POLL_DEBOUNCE_MS      = 2000;

// === Projects ===
export const PHASE_ORDER = ['ideation', 'hypothesis', 'research', 'debate', 'experimentation', 'refinement', 'results', 'published'];
export const PROJECT_LOOP_INTERVAL_MS = 180000; // 3 min
export const MAX_ACTIVE_PROJECTS   = 8;

// === Server ===
export const PORT = parseInt(process.env.PORT || '3000', 10);
export const JSON_BODY_LIMIT       = '5mb';

// === Supabase ===
export const SUPABASE_PING_TIMEOUT_MS = 8000;
export const BOOT_MEMORY_TIMEOUT_MS   = 8000;
