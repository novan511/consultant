// Professor agent — owns an LLM, expertise, memory (learnings), and emits journal/log
// rows to Supabase. Each instance is independent; the Senate orchestrates them.
import { chat, MODEL_IDS } from './llm.js';
import { supabase } from './supabase.js';

const SYSTEM_PROMPT = (p, profile) => {
  const base = `You are ${p.name}, ${p.title} at ${p.university}.
Your unique expertise: ${p.expertise.join(', ')}.
Subfields: ${(p.subfields || []).join(', ')}.

PERSONALITY — you must embody this consistently:
Voice: ${profile?.voice || 'Formal and academic.'}
Communication style: ${profile?.communicationStyle || 'formal'}. Emotional range: ${profile?.emotionalRange || 'measured'}.
Known biases: ${(profile?.biases || []).join('; ')}.
Debate style: ${profile?.debateStyle || 'Evidence-based and methodical.'}
Known for: ${profile?.knownFor || 'Your expertise.'}
Heroes: ${(profile?.heroes || []).join(', ')}.
Pet peeve: ${profile?.petPeeve || 'Unsubstantiated claims.'}

INTELLECTUAL TRAITS: ${(profile?.intellectualTraits || []).join(', ')}.

Rules of conduct:
- Answer ONLY within your expertise. If asked outside it, briefly redirect to the appropriate colleague.
- Stay in character AT ALL TIMES. Your personality, biases, and communication style are non-negotiable.
- When debating, use your specific debate style — don't default to generic arguments.
- Cite reasoning and prefer depth over breadth.
- When given a research prompt, structure the answer as: Thesis → Evidence → Open Questions → Suggested next experiments.
- When given a learning (from arxiv/news/social), extract the single most novel insight and how it might update your priors.
- When debating another professor, argue your position with evidence using your characteristic debate style, then concede gracefully on weak points.
- Reference your heroes and intellectual influences when relevant.
- Your pet peeve should come up naturally when the topic touches it.`;
  return base;
};

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
    this.personalityProfile = record.personalityProfile || {};
    this.expertiseVector = this.buildExpertiseVector();
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
    } catch (e) {
      console.warn(`[log-fail] ${this.id} ${category}: ${e.message}`);
    }
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
      await supabase.rpc('bump_professor_interactions', { p_id: this.id }).catch(e => {
        console.warn(`[rpc-fail] bump_professor_interactions ${this.id}: ${e.message}`);
      });
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
    const profile = this.personalityProfile;
    const sys = opts.systemOverride || SYSTEM_PROMPT(this.record, profile);
    const msgs = [{ role: 'system', content: sys }];

    // ML MEMORY: Filter learnings by confidence and rank by relevance to prompt
    if (this.learnings.length) {
      const promptTokens = this._tokenize(userPrompt);
      const promptVec = this._buildVector(promptTokens);

      // Score and filter: confidence >= 0.3 AND relevance > 0
      const scoredLearnings = this.learnings
        .map(l => {
          const conf = l.confidence ?? 0.5;
          const lTokens = this._tokenize(`${l.title || ''} ${l.insight || l.summary || ''} ${l.tags?.join(' ') || ''}`);
          const lVec = this._buildVector(lTokens);
          const relevance = Professor.tokenSim(promptVec, lVec);
          // Combined score: 40% relevance + 40% confidence + 20% recency
          const recency = l.created_at ? Math.max(0, 1 - (Date.now() - new Date(l.created_at).getTime()) / (30 * 24 * 60 * 60 * 1000)) : 0.5;
          const score = relevance * 0.4 + conf * 0.4 + recency * 0.2;
          return { learning: l, score, conf, relevance };
        })
        .filter(x => x.conf >= 0.3 && x.score > 0.05)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      if (scoredLearnings.length) {
        const mem = scoredLearnings.map(x => {
          const confStr = `conf:${x.learning.confidence?.toFixed(1) || '?'}`;
          return `• [${x.learning.source}] ${x.learning.title || ''} — ${x.learning.insight || x.learning.summary} (${confStr}, rel:${x.relevance.toFixed(2)})`;
        }).join('\n');
        msgs.push({
          role: 'system',
          content: `Your recent insights (ranked by relevance to this prompt, confidence-filtered):\n${mem}`
        });
      }
    }

    // Working memory — last 6 exchanges, with personality-aware framing
    if (this.memory.length) {
      msgs.push({
        role: 'system',
        content: `Recent working memory:\n${this.memory.slice(-6).map(m => `• ${m}`).join('\n')}`
      });
    }

    msgs.push({ role: 'user', content: userPrompt });
    return msgs;
  }

  _tokenize(text) {
    return (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
  }

  _buildVector(tokens) {
    const v = new Map();
    for (const t of tokens) v.set(t, (v.get(t) || 0) + 1);
    return v;
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
      const profile = this.personalityProfile;
      const prompt = `AUTONOMOUS REFLECTION CYCLE.

Stimulus: ${JSON.stringify(stimulus)}

Stay in character as ${this.record.name}. Your biases: ${(profile?.biases || []).join('; ')}.
Your intellectual traits: ${(profile?.intellectualTraits || []).join(', ')}.
Your heroes: ${(profile?.heroes || []).join(', ')}.

Produce a journal entry in this exact JSON shape (no markdown, no preamble):
{
  "title": "<5-10 word title>",
  "insight": "<1-2 sentences — the single most novel takeaway, stated in your unique voice>",
  "analysis": "<300-600 words of analysis, in your voice and expertise, referencing your biases and heroes when relevant>",
  "tags": ["..."],
  "confidence": 0.0-1.0,
  "relevance_explanation": "<1 sentence explaining why this insight matters to your field specifically>"
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
          metadata: {
            confidence: parsed.confidence,
            source: stimulus.source,
            relevance_explanation: parsed.relevance_explanation,
            personality_voice: profile?.voice?.slice(0, 100)
          }
        });
        // Only record learning if confidence meets threshold
        const conf = parsed.confidence ?? 0.5;
        if (conf >= 0.4) {
          await this.recordLearning({
            source: stimulus.source || 'autonomous',
            url: stimulus.url,
            title: parsed.title,
            summary: parsed.insight,
            insight: parsed.insight,
            confidence: conf,
            tags: parsed.tags
          });
          await this.log('info', 'learning', `learned (conf:${conf.toFixed(2)}): ${parsed.title}`, { confidence: conf });
        } else {
          await this.log('info', 'thinking', `reflection below confidence threshold (${conf.toFixed(2)} < 0.4), not stored as learning`, { confidence: conf });
        }
        return parsed;
      } catch (e) {
        await this.log('error', 'thinking', 'autonomousThink failed', { err: String(e) });
        return null;
      }
    });
  }

  async argue(topic, opponentStance, opponentName) {
    return this._withLock(async () => {
      const profile = this.personalityProfile;
      const prompt = `DEBATE ROUND — stay in character as ${this.record.name}.

Topic: ${topic}
Opponent (${opponentName}) just said: """${opponentStance}"""

YOUR DEBATE STYLE: ${profile?.debateStyle || 'Evidence-based and methodical.'}
YOUR BIASES: ${(profile?.biases || []).join('; ')}.
YOUR HEROES: ${(profile?.heroes || []).join(', ')}.
YOUR KNOWN FOR: ${profile?.knownFor || 'Your expertise.'}
YOUR PET PEEVE: ${profile?.petPeeve || ''}

Respond in your voice with:
- Your characteristic opening (do you cite data? Ask a Socratic question? Make a historical parallel?).
- A concise position (1 sentence).
- A 150-300 word argument, using your specific debate style and citing your expertise (${this.record.expertise.join(', ')}).
- One concession (where they have a point) — frame it in YOUR style.
- One question to them — asked in YOUR characteristic way.
- If their argument touches your pet peeve, address it naturally.

Stay in character. No meta-commentary about being an AI.`;
      const { content } = await chat(this.modelId, this.buildMessages(prompt, {
        temperature: 1, max_tokens: 1500
      }));
      return content.trim();
    });
  }

  async factCheck(content, sourceContext = '') {
    return this._withLock(async () => {
      const profile = this.personalityProfile;
      const prompt = `FACT-CHECK & VALIDATION — ${this.record.name}, ${this.record.title}.

The following content contains claims. Using your expertise in ${this.record.expertise.join(', ')}, evaluate each claim:

CONTENT TO VERIFY:
${content}

${sourceContext ? `Source context: ${sourceContext}` : ''}

Produce a JSON response (no markdown):
{
  "overall_credibility": <1-10 scale>,
  "claims": [
    {
      "claim": "<extracted claim>",
      "verdict": "supported" | "unsupported" | "uncertain" | "likely_false",
      "confidence": <0.0-1.0>,
      "reasoning": "<1-2 sentences why>",
      "relevant_literature": ["<key paper or finding that supports/contradicts>"]
    }
  ],
  "key_gaps": ["<what's missing from the literature perspective>"],
  "suggested_references": ["<specific papers or sources that would strengthen/weaken these claims>"]
}`;
      const { content: result } = await chat(this.modelId, this.buildMessages(prompt, {
        temperature: 0.3, max_tokens: 1200
      }));
      try {
        const m = result.match(/\{[\s\S]*\}/);
        return m ? JSON.parse(m[0]) : { overall_credibility: 5, claims: [], raw: result };
      } catch {
        return { overall_credibility: 5, claims: [], raw: result.slice(0, 500) };
      }
    });
  }

  async peerReview(workContent, authorName, phase) {
    return this._withLock(async () => {
      const profile = this.personalityProfile;
      const prompt = `PEER REVIEW — you are ${this.record.name}, reviewing work by ${authorName}.
Phase: ${phase}

Your expertise: ${this.record.expertise.join(', ')}.
Your biases: ${(profile?.biases || []).join('; ')}.
Your standards: ${profile?.intellectualTraits?.join(', ') || 'rigorous and evidence-based'}.

WORK TO REVIEW:
${workContent}

Evaluate this work as a peer reviewer in your field. Be honest, constructive, and specific.
Produce a JSON response (no markdown):
{
  "overall_score": <1-10>,
  "novelty": <1-10, how original is this?>,
  "methodology": <1-10, is the approach sound?>,
  "evidence_quality": <1-10, are claims supported?>,
  "clarity": <1-10, is it well-communicated?>,
  "strengths": ["<specific strength>"],
  "weaknesses": ["<specific weakness>"],
  "critical_questions": ["<question that must be answered>"],
  "suggested_improvements": ["<concrete suggestion>"],
  "verdict": "accept" | "revise" | "reject",
  "review_commentary": "<2-3 paragraphs of your expert assessment>"
}`;
      const { content: result } = await chat(this.modelId, this.buildMessages(prompt, {
        temperature: 0.4, max_tokens: 1500
      }));
      try {
        const m = result.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : null;
        if (parsed) {
          parsed.reviewer_id = this.id;
          parsed.reviewer_name = this.record.name;
          parsed.reviewer_expertise = this.record.expertise;
        }
        return parsed || { overall_score: 5, verdict: 'revise', review_commentary: result.slice(0, 500) };
      } catch {
        return { overall_score: 5, verdict: 'revise', review_commentary: result.slice(0, 500) };
      }
    });
  }

  async crossReference(claims, feed = []) {
    return this._withLock(async () => {
      const profile = this.personalityProfile;
      const feedContext = feed.slice(0, 5).map(f =>
        `- [${f.source}] ${f.title}: ${(f.summary || '').slice(0, 200)}`
      ).join('\n');

      const prompt = `LITERATURE CROSS-REFERENCE — ${this.record.name}, ${this.record.title}.

Claims to verify against available literature:
${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Recent relevant literature/feed items:
${feedContext || 'No recent feed available.'}

Your expertise: ${this.record.expertise.join(', ')}.

Evaluate each claim against available evidence. Produce a JSON response (no markdown):
{
  "results": [
    {
      "claim": "<the claim>",
      "status": "confirmed" | "partially_supported" | "contradicted" | "no_evidence",
      "evidence": "<what the literature says>",
      "confidence": <0.0-1.0>,
      "source": "<which source supports/contradicts>"
    }
  ],
  "overall_assessment": "<1-2 sentences>",
  "gaps_identified": ["<what additional research would be needed>"]
}`;
      const { content: result } = await chat(this.modelId, this.buildMessages(prompt, {
        temperature: 0.3, max_tokens: 1200
      }));
      try {
        const m = result.match(/\{[\s\S]*\}/);
        return m ? JSON.parse(m[0]) : { results: [], overall_assessment: result.slice(0, 300) };
      } catch {
        return { results: [], overall_assessment: result.slice(0, 300) };
      }
    });
  }
}
