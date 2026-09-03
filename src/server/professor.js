// Professor agent — owns an LLM, expertise, memory (learnings), and emits journal/log
// rows to Supabase. Each instance is independent; the Senate orchestrates them.
import { chat, MODEL_IDS } from './llm.js';
import { supabase } from './supabase.js';

const SYSTEM_PROMPT = (p) => `You are ${p.name}, ${p.title} at ${p.university}.
Your unique expertise: ${p.expertise.join(', ')}.
Subfields: ${(p.subfields || []).join(', ')}.

Personality: ${p.personality}

Rules of conduct:
- Answer ONLY within your expertise. If asked outside it, briefly redirect to the appropriate colleague.
- Be rigorous, cite reasoning, and prefer depth over breadth.
- When given a research prompt, structure the answer as: Thesis → Evidence → Open Questions → Suggested next experiments.
- When given a learning (from arxiv/news/social), extract the single most novel insight and how it might update your priors.
- When debating another professor, argue your position with evidence, then concede gracefully on weak points.`;

export class Professor {
  constructor(record) {
    this.record = record;
    this.id = record.id;
    this.modelKey = record.primary_model;
    this.modelId = record.model_id || MODEL_IDS[record.primary_model];
    this.fallbacks = record.fallback_models || [];
    this.memory = [];              // rolling short-term memory
    this.learnings = [];           // loaded from DB on boot
    this._inflight = null;         // per-instance mutex (Promise chain)
  }

  // Serialize all LLM-bound work for this agent to prevent race conditions.
  async _withLock(fn) {
    const prev = this._inflight || Promise.resolve();
    const next = prev.then(fn, fn);
    // Swallow errors so the chain keeps moving.
    this._inflight = next.catch(() => {});
    return next;
  }

  async loadMemory() {
    const { data } = await supabase
      .from('learnings')
      .select('*')
      .eq('professor_id', this.id)
      .order('created_at', { ascending: false })
      .limit(50);
    this.learnings = data || [];
  }

  async log(level, category, message, details = {}) {
    try {
      await supabase.from('logs').insert({
        professor_id: this.id,
        level, category, message, details
      });
    } catch (_) { /* never let logging kill the agent */ }
  }

  async journal(kind, payload) {
    try {
      const row = {
        professor_id: this.id,
        kind,
        title: payload.title || null,
        content: payload.content,
        topic: payload.topic || null,
        tags: payload.tags || this.record.expertise.slice(0, 3),
        related_professors: payload.related_professors || [],
        user_prompt: payload.user_prompt || null,
        metadata: payload.metadata || {}
      };
      const { data, error } = await supabase.from('journals').insert(row).select().single();
      if (error) throw error;
      // Bump total_interactions on the professor record.
      await supabase.rpc('bump_professor_interactions', { p_id: this.id }).then(() => {}, () => {});
      return data;
    } catch (e) {
      await this.log('error', 'journal', 'failed to write journal', { err: String(e) });
      return null;
    }
  }

  async recordLearning(l) {
    try {
      const { data, error } = await supabase.from('learnings').insert({
        professor_id: this.id,
        source: l.source, url: l.url, title: l.title,
        summary: l.summary, insight: l.insight,
        confidence: l.confidence ?? 0.6,
        tags: l.tags || this.record.expertise
      }).select().single();
      if (error) throw error;
      if (data) this.learnings.unshift(data);
      return data;
    } catch (e) {
      await this.log('error', 'learning', 'failed to persist learning', { err: String(e) });
      return null;
    }
  }

  // Semantic-ish "embedding" of expertise: token frequency vector (cheap).
  buildExpertiseVector() {
    const v = new Map();
    const tokens = [
      ...(this.record.expertise || []),
      ...(this.record.subfields || []),
      this.record.title || '',
      this.record.university || ''
    ].join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
    for (const t of tokens) v.set(t, (v.get(t) || 0) + 1);
    return v;
  }

  // Cosine similarity between two token-frequency vectors.
  static tokenSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (const [, va] of a) na += va * va;
    for (const [, vb] of b) nb += vb * vb;
    for (const [k, va] of a) { const vb = b.get(k); if (vb) dot += va * vb; }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  buildMessages(userPrompt, opts = {}) {
    const sys = opts.systemOverride || SYSTEM_PROMPT(this.record);
    const msgs = [{ role: 'system', content: sys }];

    if (this.learnings.length) {
      const mem = this.learnings.slice(0, 8).map(l =>
        `• [${l.source}] ${l.title || ''} — ${l.insight || l.summary}`
      ).join('\n');
      msgs.push({
        role: 'system',
        content: `Recent insights you've absorbed (apply when relevant):\n${mem}`
      });
    }

    if (this.memory.length) {
      msgs.push({
        role: 'system',
        content: `Recent working memory:\n${this.memory.slice(-6).map(m => `• ${m}`).join('\n')}`
      });
    }

    msgs.push({ role: 'user', content: userPrompt });
    return msgs;
  }

  async ask(userPrompt, opts = {}) {
    return this._withLock(async () => {
      const messages = this.buildMessages(userPrompt, opts);
      await this.log('info', 'thinking', `received prompt`, { length: userPrompt.length });
      let result;
      let usedModel = this.modelId;
      try {
        result = await chat(this.modelId, messages, opts);
      } catch (e) {
        await this.log('warn', 'response', `primary model failed, trying fallback`, { err: String(e) });
        for (const fb of this.fallbacks) {
          try {
            const fbId = MODEL_IDS[fb];
            if (!fbId) continue;
            result = await chat(fbId, messages, opts);
            usedModel = fbId;
            await this.log('info', 'response', `fallback ${fb} succeeded`);
            break;
          } catch (_) { /* try next */ }
        }
        if (!result) throw e;
      }

      const answer = (result.content || '').trim();

      this.memory.push(`Q: ${userPrompt.slice(0, 200)}`);
      this.memory.push(`A: ${answer.slice(0, 200)}`);
      if (this.memory.length > 40) this.memory.splice(0, this.memory.length - 40);

      await this.log('info', 'response', `answered via ${usedModel}`, {
        model: usedModel, length: answer.length
      });

      return { content: answer, reasoning: result.reasoning || '', model: usedModel };
    });
  }

  async autonomousThink(stimulus) {
    return this._withLock(async () => {
      const prompt = `AUTONOMOUS REFLECTION CYCLE.

Stimulus: ${JSON.stringify(stimulus)}

Produce a journal entry in this exact JSON shape (no markdown, no preamble):
{
  "title": "<5-10 word title>",
  "insight": "<1-2 sentences — the single most novel takeaway>",
  "analysis": "<300-600 words of analysis, in your voice and expertise>",
  "tags": ["..."],
  "confidence": 0.0-1.0
}`;
      try {
        const { content } = await chat(this.modelId, this.buildMessages(prompt, {
          temperature: 0.9, max_tokens: 1800
        }));
        let parsed;
        try { parsed = JSON.parse(content); } catch {
          const m = content.match(/\{[\s\S]*\}/);
          parsed = m ? JSON.parse(m[0]) : null;
        }
        if (!parsed) {
          await this.log('warn', 'thinking', 'failed to parse autonomous reflection', { raw: content.slice(0, 200) });
          return null;
        }
        await this.journal('thought', {
          title: parsed.title,
          content: parsed.analysis,
          topic: stimulus.topic || 'autonomous',
          tags: parsed.tags || [],
          metadata: { confidence: parsed.confidence, source: stimulus.source }
        });
        await this.recordLearning({
          source: stimulus.source || 'autonomous',
          url: stimulus.url,
          title: parsed.title,
          summary: parsed.insight,
          insight: parsed.insight,
          confidence: parsed.confidence ?? 0.6,
          tags: parsed.tags
        });
        await this.log('info', 'learning', `learned: ${parsed.title}`, { confidence: parsed.confidence });
        return parsed;
      } catch (e) {
        await this.log('error', 'thinking', 'autonomousThink failed', { err: String(e) });
        return null;
      }
    });
  }

  async argue(topic, opponentStance, opponentName) {
    return this._withLock(async () => {
      const prompt = `DEBATE ROUND.

Topic: ${topic}
Opponent (${opponentName}) just said: """${opponentStance}"""

Respond in your voice with:
- A concise position (1 sentence).
- A 150-300 word argument, citing your expertise (${this.record.expertise.join(', ')}).
- One concession (where they have a point).
- One question to them.

Stay in character. No meta.`;
      const { content } = await chat(this.modelId, this.buildMessages(prompt, {
        temperature: 1, max_tokens: 1500
      }));
      return content.trim();
    });
  }
}
