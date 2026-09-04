// DRY project phase prompts — single source of truth.
// Was duplicated 3 times in the old index.js.

export const PHASE_ORDER = [
  'ideation', 'hypothesis', 'research', 'debate',
  'experimentation', 'refinement', 'results', 'published'
];

// Generate phase prompts with project context
export function buildPhasePrompts(proj, historyText, commentsText) {
  const t = proj.title;
  const v = proj.vision || '';
  const d = proj.description || '';
  const h = historyText || '';
  const c = commentsText || 'None';

  return {
    ideation: `PROJECT IDEATION.\nProject: "${t}"\nVision: ${v}\nDescription: ${d}\nUser feedback: ${c}\n\nBrainstorm: What is the novel invention/idea? What makes it unprecedented? What are the 3 biggest scientific barriers? Be specific and bold. You MUST provide a substantive response within your expertise.`,
    hypothesis: `HYPOTHESIS PHASE.\nProject: "${t}"\nPrevious work: ${h}\nUser feedback: ${c}\n\nFormulate 2-3 testable hypotheses. For each: state the hypothesis, required evidence, and how to falsify it. Cite relevant science.`,
    research: `RESEARCH PHASE.\nProject: "${t}"\nPrevious: ${h}\nUser feedback: ${c}\n\nConduct a literature review. What prior art exists? What references are critical? Map the state of the art and identify the exact gap this project fills.`,
    debate: `DEBATE PHASE.\nProject: "${t}"\nPrevious: ${h}\nUser feedback: ${c}\n\nArgue FOR and AGAINST the feasibility. What are the strongest arguments on each side? What would need to be true for this to work? Be rigorous.`,
    experimentation: `EXPERIMENTATION PHASE.\nProject: "${t}"\nPrevious: ${h}\nUser feedback: ${c}\n\nDesign the experiment or computational study. What materials, methods, datasets are needed? What are expected results? What controls are necessary?`,
    refinement: `REFINEMENT PHASE.\nProject: "${t}"\nPrevious: ${h}\nUser feedback: ${c}\n\nBased on all prior work, what needs refinement? Address user feedback. What assumptions were wrong? What should be revised?`,
    results: `RESULTS PHASE.\nProject: "${t}"\nPrevious: ${h}\nUser feedback: ${c}\n\nSynthesize all findings into a coherent result. What did we learn? What is the status of each hypothesis? What remains uncertain? What are the next steps?`,
    published: `FINAL PUBLICATION.\nProject: "${t}"\nPrevious: ${h}\nUser feedback: ${c}\n\nWrite a comprehensive 500-word research summary: novel discovery, impact for humanity, limitations, future research directions.`
  };
}

// Check if content looks like a professor refusal
export function isRefusal(content) {
  const lower = (content || '').toLowerCase();
  return lower.includes('outside my expertise')
    || lower.includes('not qualified')
    || lower.includes('not my field')
    || lower.includes('redirect')
    || lower.includes('i cannot');
}
