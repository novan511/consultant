// LLM router — dual provider: NVIDIA (primary) + OpenRouter free models (fallback).
// Dynamic pool: models are assigned at runtime, not hardcoded per professor.
import OpenAI from 'openai';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';

// NVIDIA models — keys from env
const NVIDIA_MODELS = {
  'deepseek-ai/deepseek-v4-pro-0813':          process.env.NVIDIA_DEEPSEEK_V4_PRO,
  'deepseek-ai/deepseek-v4-flash-0731':        process.env.NVIDIA_DEEPSEEK_V4_FLASH,
  'google/diffusiongemma-26b-a4b-it':          process.env.NVIDIA_DIFFUSIONGEMMA_26B,
  'openai/gpt-oss-20b':                        process.env.NVIDIA_GPT_OSS_20B,
  'google/gemma-4-31b-it':                     process.env.NVIDIA_GEMMA_4_31B,
  'nvidia/nemotron-3.5-lightning-30b-a3b':     process.env.NVIDIA_NEMOTRON_35_LIGHTNING,
  'nvidia/nemotron-3-ultra-550b-a55b':         process.env.NVIDIA_NEMOTRON_3_ULTRA,
  'nvidia/nemotron-3-super-120b-a12b':         process.env.NVIDIA_NEMOTRON_3_SUPER,
  'meta/muse-glimmer-30b':                     process.env.NVIDIA_MUSE_GLIMMER_30B,
  'moonshotai/kimi-k3':                        process.env.NVIDIA_KIMI_K3,
  'poolside/laguna-xs-2.1':                    process.env.NVIDIA_LAGUNA_XS_21
};

// OpenRouter free models (all 18 — updated Sep 2026)
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_FREE_MODELS = [
  // Frontier reasoning
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'z-ai/glm-5.2:free',
  'minimax/minimax-m3:free',
  'qwen/qwen3-235b-a22b:free',
  // Multimodal
  'google/gemma-4-31b-it:free',
  'minimax/minimax-m2.7:free',
  // Agentic/coding
  'thinkingmachines/inkling:free',
  'poolside/laguna-s-2.1:free',
  // Fast/compact
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-26b-a4b-it:free',
  'liquid/lfm-2.5-2.6b:free',
  // Specialist
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3.5-content-safety:free',
  'cohere/north-mini-code:free',
  'poolside/laguna-xs-2.1:free',
  'thinkingmachines/inkling-small:free',
  'inclusionai/ling-3.0-flash-fin:free'
];

// Model tiers — for dynamic assignment
const MODEL_TIERS = {
  // Best for complex reasoning, debates, research
  heavy: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'qwen/qwen3-235b-a22b:free', 'z-ai/glm-5.2:free', 'thinkingmachines/inkling:free', 'minimax/minimax-m3:free'],
  // Good for general tasks, learning, discussions
  medium: ['nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free', 'minimax/minimax-m2.7:free', 'thinkingmachines/inkling-small:free', 'poolside/laguna-s-2.1:free'],
  // Fast, for tick/reflection/routing
  fast: ['nvidia/nemotron-3.5-lightning:free', 'google/gemma-4-26b-a4b-it:free', 'liquid/lfm-2.5-2.6b:free', 'poolside/laguna-xs-2.1:free', 'cohere/north-mini-code:free'],
  // Specialist
  special: ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'nvidia/nemotron-3.5-content-safety:free', 'inclusionai/ling-3.0-flash-fin:free']
};

const ALL_NVIDIA = Object.keys(NVIDIA_MODELS).filter(k => NVIDIA_MODELS[k]);
const ALL_MODEL_KEYS = [...ALL_NVIDIA, ...OPENROUTER_FREE_MODELS];

// Round-robin index for default assignment
let roundRobinIdx = 0;
function modelFor(index) { return ALL_MODEL_KEYS[index % ALL_MODEL_KEYS.length]; }

// Dynamic model selection: pick best available model for a task type
export function selectModel(taskType = 'medium') {
  const tier = MODEL_TIERS[taskType] || MODEL_TIERS.medium;
  // Try tier models, fallback to any available
  const available = [...tier, ...OPENROUTER_FREE_MODELS];
  const model = available[roundRobinIdx % available.length];
  roundRobinIdx++;
  return model;
}

const clientCache = new Map();
const chainLocks = new Map();

function isOpenRouter(modelId) { return modelId.includes(':free'); }

function getClient(modelId) {
  if (clientCache.has(modelId)) return clientCache.get(modelId);
  let apiKey, baseURL;
  if (isOpenRouter(modelId)) {
    apiKey = OPENROUTER_KEY;
    baseURL = OPENROUTER_BASE;
  } else {
    apiKey = NVIDIA_MODELS[modelId];
    if (!apiKey) throw new Error(`No API key for model ${modelId}`);
    baseURL = NVIDIA_BASE;
  }
  const c = new OpenAI({ apiKey, baseURL, timeout: 60000, maxRetries: 2 });
  clientCache.set(modelId, c);
  return c;
}

function buildBody(modelId, messages, opts = {}) {
  const body = { model: modelId, messages, temperature: opts.temperature ?? 1, top_p: opts.top_p ?? 0.95, max_tokens: opts.max_tokens ?? 2048, stream: false };
  if (opts.seed !== undefined && !isOpenRouter(modelId)) body.seed = opts.seed;
  if (modelId === 'deepseek-ai/deepseek-v4-pro-0813') body.chat_template_kwargs = { thinking: false };
  else if (modelId === 'deepseek-ai/deepseek-v4-flash-0731') body.chat_template_kwargs = { thinking: true, reasoning_effort: 'high' };
  else if (modelId.startsWith('google/') && !isOpenRouter(modelId)) body.chat_template_kwargs = { enable_thinking: true };
  else if (modelId === 'nvidia/nemotron-3.5-lightning-30b-a3b') { body.reasoning_budget = 16384; body.chat_template_kwargs = { enable_thinking: true }; }
  else if (modelId === 'nvidia/nemotron-3-ultra-550b-a55b') body.extra_body = { chat_template_kwargs: { enable_thinking: true } };
  else if (modelId === 'nvidia/nemotron-3-super-120b-a12b') body.chat_template_kwargs = { enable_thinking: true };
  else if (modelId === 'moonshotai/kimi-k3') body.reasoning_effort = 'max';
  if (isOpenRouter(modelId)) body.provider = { allow_fallbacks: true };
  return body;
}

export async function chat(modelId, messages, opts = {}) {
  const prev = chainLocks.get(modelId) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  chainLocks.set(modelId, prev.then(() => next));
  await prev;
  try {
    try {
      const client = getClient(modelId);
      const body = buildBody(modelId, messages, opts);
      const res = await client.chat.completions.create(body);
      const msg = res.choices?.[0]?.message || {};
      return { content: msg.content || '', reasoning: msg.reasoning_content || msg.reasoning || '', raw: res };
    } catch (e) {
      if (!isOpenRouter(modelId) && OPENROUTER_KEY && OPENROUTER_FREE_MODELS.length) {
        const fallback = OPENROUTER_FREE_MODELS[Math.floor(Math.random() * OPENROUTER_FREE_MODELS.length)];
        console.log(`[llm] ${modelId} failed, falling back to ${fallback}`);
        const client = getClient(fallback);
        const body = buildBody(fallback, messages, opts);
        const res = await client.chat.completions.create(body);
        const msg = res.choices?.[0]?.message || {};
        return { content: msg.content || '', reasoning: msg.reasoning_content || msg.reasoning || '', raw: res, model: fallback };
      }
      throw e;
    }
  } finally { release(); }
}

export const MODEL_IDS = {
  'deepseek-v4-pro':       'deepseek-ai/deepseek-v4-pro-0813',
  'deepseek-v4-flash':     'deepseek-ai/deepseek-v4-flash-0731',
  'diffusiongemma-26b':    'google/diffusiongemma-26b-a4b-it',
  'gpt-oss-20b':           'openai/gpt-oss-20b',
  'gemma-4-31b':           'google/gemma-4-31b-it',
  'nemotron-3.5-lightning': 'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nemotron-3-ultra':      'nvidia/nemotron-3-ultra-550b-a55b',
  'nemotron-3-super':      'nvidia/nemotron-3-super-120b-a12b',
  'muse-glimmer-30b':      'meta/muse-glimmer-30b',
  'kimi-k3':               'moonshotai/kimi-k3',
  'laguna-xs-2.1':         'poolside/laguna-xs-2.1'
};

export { OPENROUTER_FREE_MODELS, NVIDIA_MODELS, MODEL_TIERS, ALL_MODEL_KEYS, modelFor };
