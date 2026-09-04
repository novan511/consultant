// Project logic — advance, discuss, smartAssign, projectLoop.
// Extracted from the old monolithic index.js.
import { supabase } from '../supabase.js';
import { chat, MODEL_IDS } from '../llm.js';
import { getFeed } from '../feed.js';
import { rankProfessors } from './router.js';
import { buildPhasePrompts, isRefusal, PHASE_ORDER } from './prompts.js';
import { generateProjectPDF } from './pdf.js';
import { log, safeAsync } from './logger.js';

// Smart assignment: use LLM to pick the best 3 professors for a project
export async function smartAssign(proj, roster, professorMap) {
  const list = roster.map(r =>
    `${r.id} | ${r.name} | ${r.expertise.join(', ')} | ${r.subfields.join(', ')}`
  ).join('\n');

  try {
    const modelId = MODEL_IDS['gpt-oss-20b'] || Object.values(MODEL_IDS)[0];
    const { content } = await chat(modelId, [
      { role: 'system', content: 'You are a project coordinator. Given a project description, pick the 3 BEST professors by ID who have the most relevant expertise. Return ONLY a JSON array of IDs. No explanation.' },
      { role: 'user', content: `Project: "${proj.title}"\nDescription: ${proj.description}\nVision: ${proj.vision}\n\nAvailable professors:\n${list}\n\nReturn JSON array of 3 professor IDs.` }
    ], { temperature: 0.2, max_tokens: 200 });
    const m = content.match(/\[[\s\S]*?\]/);
    const ids = m ? JSON.parse(m[0]) : [];
    return ids.filter(id => professorMap.has(id)).slice(0, 3);
  } catch (e) {
    log('warn', 'project', `LLM assignment failed, using keyword fallback: ${e.message}`);
    return keywordAssign(proj, roster);
  }
}

// Fallback keyword-based assignment
export function keywordAssign(proj, roster) {
  const tokens = `${proj.title} ${proj.description} ${proj.vision || ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
  const ranked = rankProfessors(tokens.join(' '), roster);
  return ranked.slice(0, 3).map(x => x.r.id);
}

// Advance a project to the next phase
export async function advanceProject(id, proj, senate) {
  const currentIdx = PHASE_ORDER.indexOf(proj.status);
  const nextPhase = PHASE_ORDER[Math.min(currentIdx + 1, PHASE_ORDER.length - 1)];

  const { data: comments } = await supabase.from('project_comments').select('*').eq('project_id', id).order('created_at', { ascending: true });
  const { data: recentPhases } = await supabase.from('project_phases').select('professor_name,phase,content').eq('project_id', id).order('created_at', { ascending: false }).limit(5);
  const userCommentsText = (comments || []).map(c => `[${c.author}]: ${c.content}`).join('\n');
  const historyText = (recentPhases || []).map(p => `[${p.professor_name} → ${p.phase}]: ${(p.content || '').slice(0, 400)}`).join('\n');

  // Smart assignment
  let profIds = proj.assigned_professors || [];
  const needReassign = profIds.length === 0 || (recentPhases?.length && recentPhases[0]?.content && isRefusal(recentPhases[0].content));
  if (needReassign) {
    profIds = await smartAssign(proj, senate.roster, senate.professors);
    if (profIds.length === 0) profIds = senate.roster.slice(0, 3).map(r => r.id);
    await supabase.from('projects').update({ assigned_professors: profIds }).eq('id', id);
  }

  const prompts = buildPhasePrompts(proj, historyText, userCommentsText);

  let contributions = 0;
  for (const pid of profIds) {
    const prof = senate.professors.get(pid);
    if (!prof) continue;
    await supabase.from('projects').update({ active_professor: pid }).eq('id', id);
    try {
      const { content } = await prof.ask(prompts[nextPhase], { temperature: 0.8, max_tokens: 1000 });
      if (isRefusal(content)) {
        log('info', 'advance', `${prof.record.name} refused ${nextPhase} for "${proj.title}"`);
        continue;
      }
      await supabase.from('project_phases').insert({
        project_id: id, phase: nextPhase, professor_id: prof.id, professor_name: prof.record.name,
        action: `auto-advance to ${nextPhase}`, content, metadata: { auto: true }
      });
      contributions++;
    } catch (e) {
      log('error', 'advance', `${prof.record.name} error: ${e.message}`);
    }
  }

  if (contributions > 0) {
    await supabase.from('projects').update({
      status: nextPhase, updated_at: new Date().toISOString(),
      phase_summary: `${nextPhase.toUpperCase()}: ${contributions} professor(s) contributed. ${currentIdx + 2}/${PHASE_ORDER.length} phases.`
    }).eq('id', id);
    log('info', 'advance', `"${proj.title}" → ${nextPhase} (${contributions} contributions)`);
    if (nextPhase === 'published') await generateProjectPDF(id);

    // Peer review
    await runPeerReview(id, nextPhase, profIds, senate);

    // Fact-check
    await runFactCheck(id, nextPhase, profIds, senate);
  } else {
    const newIds = await smartAssign({ ...proj, description: proj.description + ' URGENTLY need experts in this field' }, senate.roster, senate.professors);
    await supabase.from('projects').update({ assigned_professors: newIds, updated_at: new Date().toISOString() }).eq('id', id);
    log('warn', 'advance', `All refused for "${proj.title}", reassigned to ${newIds.join(',')}`);
  }
}

async function runPeerReview(projectId, phase, profIds, senate) {
  if (!['research', 'debate', 'experimentation', 'refinement', 'results'].includes(phase)) return;
  await safeAsync('peer-review', async () => {
    const { data: latestPhases } = await supabase.from('project_phases')
      .select('*').eq('project_id', projectId).eq('phase', phase)
      .order('created_at', { ascending: false }).limit(3);
    if (!latestPhases?.length) return;

    const reviewerCandidates = profIds.filter(pid => !latestPhases.some(p => p.professor_id === pid));
    if (reviewerCandidates.length === 0) return;

    const reviewerId = reviewerCandidates[Math.floor(Math.random() * reviewerCandidates.length)];
    const reviewer = senate.professors.get(reviewerId);
    if (!reviewer) return;

    const latestContent = latestPhases.map(p => `[${p.professor_name}]: ${p.content?.slice(0, 800) || ''}`).join('\n\n');
    const review = await reviewer.peerReview(latestContent, latestPhases[0]?.professor_name || 'unknown', phase);
    if (!review) return;

    await supabase.from('peer_reviews').insert({
      project_id: projectId, phase_id: latestPhases[0].id,
      reviewer_id: reviewer.id, reviewer_name: reviewer.record.name,
      overall_score: review.overall_score, novelty: review.novelty,
      methodology: review.methodology, evidence_quality: review.evidence_quality,
      clarity: review.clarity, strengths: review.strengths || [],
      weaknesses: review.weaknesses || [], critical_questions: review.critical_questions || [],
      suggested_improvements: review.suggested_improvements || [],
      verdict: review.verdict, review_commentary: review.review_commentary
    });
    log('info', 'peer-review', `${reviewer.record.name} reviewed ${phase}: score=${review.overall_score}, verdict=${review.verdict}`);
  });
}

async function runFactCheck(projectId, phase, profIds, senate) {
  if (!['hypothesis', 'research', 'results'].includes(phase)) return;
  await safeAsync('fact-check', async () => {
    const { data: latestPhases } = await supabase.from('project_phases')
      .select('*').eq('project_id', projectId).eq('phase', phase)
      .order('created_at', { ascending: false }).limit(1);
    if (!latestPhases?.[0]?.content) return;

    const checkerCandidates = profIds.filter(pid => pid !== latestPhases[0].professor_id);
    if (checkerCandidates.length === 0) return;

    const checkerId = checkerCandidates[Math.floor(Math.random() * checkerCandidates.length)];
    const checker = senate.professors.get(checkerId);
    if (!checker) return;

    const feed = await getFeed();
    const claims = latestPhases[0].content.match(/.{50,200}\./g)?.slice(0, 5) || [latestPhases[0].content.slice(0, 500)];
    const crossRef = await checker.crossReference(claims, feed);
    await supabase.from('fact_checks').insert({
      project_id: projectId, checker_id: checker.id, checker_name: checker.record.name,
      content_checked: latestPhases[0].content.slice(0, 1000),
      overall_credibility: crossRef.results?.length
        ? Math.round(crossRef.results.reduce((s, r) => s + (r.confidence || 0.5), 0) / crossRef.results.length * 10)
        : 5,
      claims: crossRef.results || [], key_gaps: crossRef.gaps_identified || [], suggested_references: []
    });
    log('info', 'fact-check', `${checker.record.name} cross-referenced ${phase} claims`);
  });
}

// Run inter-professor discussion on a project
export async function runDiscussion(projectId, topic, proj, senate) {
  let profIds = proj.assigned_professors || [];
  if (profIds.length < 2) {
    profIds = keywordAssign(proj, senate.roster);
    await supabase.from('projects').update({ assigned_professors: profIds }).eq('id', projectId);
  }
  const profs = profIds.map(pid => senate.professors.get(pid)).filter(Boolean);
  if (profs.length < 2) {
    await supabase.from('projects').update({ metadata: { discussion_running: false } }).eq('id', projectId);
    return;
  }

  const discussTopic = topic || `Given the project "${proj.title}" (${proj.description}), what is the most promising approach and what are the biggest risks?`;
  const { data: prevPhases } = await supabase.from('project_phases').select('professor_name,phase,content').eq('project_id', projectId).order('created_at', { ascending: false }).limit(3);
  const historyText = (prevPhases || []).map(p => `[${p.professor_name} → ${p.phase}]: ${(p.content || '').slice(0, 300)}`).join('\n');

  let prevArgument = `${discussTopic}\n\nRecent project work:\n${historyText}`;
  for (let round = 0; round < 3; round++) {
    for (const prof of profs) {
      const { content } = await prof.ask(
        `PROJECT DISCUSSION — Round ${round + 1}.\nTopic: ${discussTopic}\nProject: "${proj.title}"\nYour colleague previously said:\n"${prevArgument.slice(0, 500)}"\n\nRespond with your position (2-3 paragraphs). Agree, disagree, or build on what was said. Be specific.`,
        { temperature: 0.8, max_tokens: 600 }
      );
      await supabase.from('project_phases').insert({
        project_id: projectId, phase: 'discussion', professor_id: prof.id, professor_name: prof.record.name,
        action: `round ${round + 1} discussion`, content: content.trim(),
        metadata: { discussion_round: round + 1, topic: discussTopic }
      });
      prevArgument = content;
    }
  }

  const summarizer = profs.length > 2 ? profs[2] : profs[0];
  const { data: turns } = await supabase.from('project_phases').select('professor_name,content,metadata').eq('project_id', projectId).eq('phase', 'discussion').order('created_at', { ascending: false }).limit(6);
  const summaryInput = (turns || []).map(t => `${t.professor_name}: ${(t.content || '').slice(0, 200)}`).join('\n');
  const { content: summary } = await summarizer.ask(`Summarize this discussion about "${proj.title}". Points of agreement, disagreements, and key insights:\n${summaryInput}`, { temperature: 0.6, max_tokens: 400 });
  await supabase.from('project_phases').insert({
    project_id: projectId, phase: 'discussion', professor_id: summarizer.id, professor_name: summarizer.record.name,
    action: 'discussion summary', content: summary, metadata: { is_summary: true }
  });

  await supabase.from('projects').update({ metadata: { discussion_running: false }, updated_at: new Date().toISOString() }).eq('id', projectId);
  log('info', 'discussion', `Completed for "${proj.title}"`);
}

// Auto-advance loop for projects
export async function projectLoop(senate) {
  if (!senate || !senate.running) {
    setTimeout(() => projectLoop(senate), 30000);
    return;
  }

  await safeAsync('project-loop', async () => {
    // Part 1: Autonomous project creation from feed
    const { count } = await supabase.from('projects').select('*', { count: 'exact', head: true });
    if (!count || count < 8) {
      await safeAsync('project-create', async () => {
        const feed = await getFeed();
        if (!feed.length) return;

        const proposer = senate.roster[Math.floor(Math.random() * senate.roster.length)];
        const prof = senate.professors.get(proposer.id);
        const recentFeed = feed.slice(0, 10).map(f => `- ${f.title}: ${(f.summary || '').slice(0, 200)}`).join('\n');
        const { content } = await prof.ask(
          `You are a ${proposer.expertise.join('/')} researcher. Based on these recent developments:\n${recentFeed}\n\nPropose ONE novel research project that could lead to a groundbreaking invention for humanity. Reply in this EXACT JSON format (no markdown):\n{"title":"...","description":"...","vision":"..."}`,
          { temperature: 0.9, max_tokens: 500 }
        );
        let parsed;
        try { parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || content); } catch { parsed = null; }
        if (parsed?.title) {
          const { data: existing } = await supabase.from('projects').select('id').eq('title', parsed.title).limit(1);
          if (!existing?.length) {
            await supabase.from('projects').insert({
              title: parsed.title, description: parsed.description || '', vision: parsed.vision || '',
              status: 'ideation', assigned_professors: [proposer.id],
              phase_summary: `Proposed by ${proposer.name}. Auto-created from ${feed[0]?.source || 'feed'}.`
            });
            log('info', 'project', `Auto-created: "${parsed.title}" by ${proposer.name}`);
          }
        }
      });
    }

    // Part 2: Auto-advance existing projects
    const { data: activeProjects } = await supabase.from('projects').select('*').not('status', 'eq', 'published').order('updated_at', { ascending: true }).limit(3);
    for (const proj of (activeProjects || [])) {
      await safeAsync('project-advance', async () => {
        const currentIdx = PHASE_ORDER.indexOf(proj.status);
        const nextPhase = PHASE_ORDER[Math.min(currentIdx + 1, PHASE_ORDER.length - 1)];
        if (nextPhase === proj.status) return;

        const { data: prevPhases } = await supabase.from('project_phases').select('professor_name,phase,content').eq('project_id', proj.id).order('created_at', { ascending: false }).limit(4);
        const { data: comments } = await supabase.from('project_comments').select('author,content').eq('project_id', proj.id);
        const historyText = (prevPhases || []).map(p => `[${p.professor_name} → ${p.phase}]: ${(p.content || '').slice(0, 400)}`).join('\n');
        const commentsText = (comments || []).map(c => `[${c.author}]: ${c.content}`).join('\n');

        let profIds = proj.assigned_professors || [];
        if (profIds.length === 0) {
          profIds = keywordAssign(proj, senate.roster);
          await supabase.from('projects').update({ assigned_professors: profIds }).eq('id', proj.id);
        }

        const prompts = buildPhasePrompts(proj, historyText, commentsText);
        const contribs = profIds.slice(0, nextPhase === 'published' ? 3 : 2);
        for (const pid of contribs) {
          const prof = senate.professors.get(pid);
          if (!prof) continue;
          await supabase.from('projects').update({ active_professor: pid }).eq('id', proj.id);
          const { content } = await prof.ask(prompts[nextPhase] || `Continue "${proj.title}" in ${nextPhase} phase.`, { temperature: 0.8, max_tokens: 1000 });
          await supabase.from('project_phases').insert({
            project_id: proj.id, phase: nextPhase, professor_id: prof.id, professor_name: prof.record.name,
            action: `auto-advance to ${nextPhase}`, content, metadata: { auto: true }
          });
        }

        await supabase.from('projects').update({
          status: nextPhase, updated_at: new Date().toISOString(),
          phase_summary: `${nextPhase.toUpperCase()}: ${contribs.length} professor(s) contributed. ${currentIdx + 2}/${PHASE_ORDER.length} phases.`
        }).eq('id', proj.id);
        log('info', 'project', `"${proj.title}" → ${nextPhase}`);

        if (nextPhase === 'published') await generateProjectPDF(proj.id);
      });
    }
  });

  setTimeout(() => projectLoop(senate), 180000);
}
