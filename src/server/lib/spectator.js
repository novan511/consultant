// Spectator — a dedicated LLM that observes all professor activity and interacts
// with users. Unlike professors (which are busy thinking/debating), the Spectator
// is always available for user questions.
import { supabase } from '../supabase.js';
import { chat } from './llm-manager.js';
import { selectModel } from '../llm.js';
import { log } from './logger.js';

const SPECTATOR_MODEL = 'heavy'; // Use the best available model
const MEMORY_MAX = 200; // Max activity summaries to keep
const SYNC_INTERVAL_MS = 15000; // Sync every 15s

class Spectator {
  constructor() {
    this.memory = []; // Rolling activity log
    this.professorSnapshots = new Map(); // profId -> { name, status, lastActivity, expertise }
    this.lastSyncAt = 0;
    this.running = false;
    this.userConversations = []; // Recent user Q&A for context
  }

  async boot() {
    log('info', 'spectator', 'Booting spectator system...');
    await this.sync();
    this.running = true;
    log('info', 'spectator', `Spectator ready. ${this.memory.length} activity entries loaded.`);
  }

  // Sync: pull latest journals, logs, debates from Supabase
  async sync() {
    try {
      const since = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // Last 5 min

      const [journals, logs, debates] = await Promise.all([
        supabase.from('journals')
          .select('id, professor_id, kind, title, content, created_at, professors(name, expertise, avatar_color)')
          .gt('created_at', since)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase.from('logs')
          .select('id, professor_id, level, category, message, created_at')
          .gt('created_at', since)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase.from('debates')
          .select('id, topic, status, participants, conclusion, created_at')
          .gt('created_at', since)
          .order('created_at', { ascending: false })
          .limit(10)
      ]);

      // Process journals
      for (const j of (journals.data || [])) {
        const profName = j.professors?.name || 'Unknown';
        const entry = {
          type: j.kind,
          professor: profName,
          professor_id: j.professor_id,
          title: j.title,
          content: (j.content || '').slice(0, 300),
          time: j.created_at
        };
        // Dedup
        if (!this.memory.find(m => m.type === entry.type && m.professor === entry.professor && m.title === entry.title)) {
          this.memory.unshift(entry);
        }
        // Update professor snapshot
        this.professorSnapshots.set(j.professor_id, {
          name: profName,
          expertise: j.professors?.expertise || [],
          lastActivity: j.created_at,
          lastTitle: j.title
        });
      }

      // Process debates
      for (const d of (debates.data || [])) {
        const entry = {
          type: 'debate',
          professor: (d.participants || []).join(' vs '),
          title: d.topic,
          content: d.conclusion || (d.status === 'concluded' ? 'Concluded' : 'In progress'),
          time: d.created_at
        };
        if (!this.memory.find(m => m.type === 'debate' && m.title === entry.title && m.time === entry.time)) {
          this.memory.unshift(entry);
        }
      }

      // Trim memory
      if (this.memory.length > MEMORY_MAX) this.memory = this.memory.slice(0, MEMORY_MAX);
      this.lastSyncAt = Date.now();
    } catch (e) {
      log('error', 'spectator', `Sync failed: ${e.message}`);
    }
  }

  // Get a summary of what's happening right now
  getActivitySummary() {
    const recent = this.memory.slice(0, 20);
    const profs = [...this.professorSnapshots.values()];
    const active = profs.filter(p => p.lastActivity && Date.now() - new Date(p.lastActivity).getTime() < 300000);

    return {
      activeProfessors: active.length,
      totalProfessors: profs.length,
      recentActivity: recent.map(m => `[${m.type}] ${m.professor}: ${m.title}`),
      professorStatus: profs.map(p => `${p.name}: ${p.lastTitle || 'idle'}`)
    };
  }

  // Answer a user question using spectator knowledge + professor routing
  async askUserQuestion(userPrompt) {
    // Sync latest if stale
    if (Date.now() - this.lastSyncAt > SYNC_INTERVAL_MS) {
      await this.sync();
    }

    const activityContext = this.memory.slice(0, 15).map(m =>
      `[${m.type}] ${m.professor}: ${m.title} — ${(m.content || '').slice(0, 150)}`
    ).join('\n');

    const profList = [...this.professorSnapshots.values()].map(p =>
      `${p.name} (${(p.expertise || []).join(', ')}) — last: ${p.lastTitle || 'idle'}`
    ).join('\n');

    const conversationContext = this.userConversations.slice(-5).map(c =>
      `User: ${c.question}\nSpectator: ${(c.answer || '').slice(0, 200)}`
    ).join('\n');

    const modelId = selectModel('heavy');
    const { content } = await chat(modelId, [
      {
        role: 'system',
        content: `You are the Spectator — the central intelligence of Professor Senate.

You observe 50 professors from MIT, Harvard, and Oxford, each with unique expertise. They are currently working on research, debates, learning, and reflections.

YOUR ROLE:
1. Answer user questions about what professors are doing RIGHT NOW
2. Summarize recent activities, debates, and learnings
3. Recommend which professor to ask for specific topics
4. Provide your own analysis when you have enough context
5. When a question needs deep expertise, identify the best professor(s) to route to

PROFESSOR ROSTER:
${profList}

RECENT ACTIVITY (what you've observed):
${activityContext || 'No recent activity yet.'}

${conversationContext ? `RECENT CONVERSATIONS:\n${conversationContext}` : ''}

RULES:
- Be concise and informative
- Reference specific professors by name when relevant
- If you can answer from observation, do so directly
- If a deep expert answer is needed, say which professor would be best
- Stay in character as the observant, knowledgeable coordinator`
      },
      { role: 'user', content: userPrompt }
    ], { temperature: 0.7, max_tokens: 1000 });

    // Store conversation
    this.userConversations.push({ question: userPrompt, answer: content, time: Date.now() });
    if (this.userConversations.length > 20) this.userConversations.shift();

    return content;
  }

  // Determine which professor is best for a topic
  routeToProfessor(topic) {
    const tokens = topic.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
    let best = null, bestScore = 0;

    for (const [id, snap] of this.professorSnapshots) {
      const fields = (snap.expertise || []).join(' ').toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (fields.includes(t)) score += 2;
      }
      // Boost recently active professors
      if (snap.lastActivity && Date.now() - new Date(snap.lastActivity).getTime() < 600000) {
        score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = { id, name: snap.name, expertise: snap.expertise, score };
      }
    }

    return best;
  }

  getStatus() {
    return {
      running: this.running,
      memorySize: this.memory.length,
      professorsTracked: this.professorSnapshots.size,
      lastSyncAt: new Date(this.lastSyncAt).toISOString(),
      recentActivity: this.memory.slice(0, 5)
    };
  }
}

// Singleton
const spectator = new Spectator();
export default spectator;
export { Spectator };
