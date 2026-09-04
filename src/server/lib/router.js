// DRY routing utility — keyword scoring used in 4+ places.
// Single source of truth for all routing logic.

// Tokenize text into searchable tokens (lowercase, min length 3)
export function tokenize(text) {
  return (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
}

// Score a professor against a set of tokens using keyword overlap
export function scoreByKeywords(tokens, professorRecord) {
  const fields = [
    ...(professorRecord.expertise || []),
    ...(professorRecord.subfields || [])
  ].join(' ').toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (fields.includes(t)) score += 1;
  }
  return score;
}

// Rank all professors by relevance to a prompt. Returns sorted array of { r, score }.
export function rankProfessors(prompt, roster) {
  const tokens = tokenize(prompt);
  if (tokens.length === 0) tokens.push('general');
  return roster.map(r => {
    const score = scoreByKeywords(tokens, r);
    return { r, score };
  }).sort((a, b) => b.score - a.score);
}

// Pick top N professors that have score > 0 (fallback to top-1 if none match).
export function pickTopProfessors(prompt, roster, n = 1) {
  const ranked = rankProfessors(prompt, roster);
  const top = ranked.filter(x => x.score > 0).slice(0, n).map(x => x.r);
  if (top.length === 0) top.push(ranked[0].r);
  return top;
}
