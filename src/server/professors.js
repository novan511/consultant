// 50 unique professors from MIT / Harvard / Oxford level — no duplicate expertise.
// Each gets a primary LLM from the 12 NVIDIA models. Fallbacks rotate.
//
// Models available (id : display name):
//   deepseek-v4-pro         - deepseek-ai/deepseek-v4-pro-0813
//   deepseek-v4-flash       - deepseek-ai/deepseek-v4-flash-0731
//   diffusiongemma-26b      - google/diffusiongemma-26b-a4b-it (vision)
//   gpt-oss-20b             - openai/gpt-oss-20b
//   gemma-4-31b             - google/gemma-4-31b-it (vision)
//   nemotron-3.5-lightning  - nvidia/nemotron-3.5-lightning-30b-a3b
//   nemotron-3-ultra        - nvidia/nemotron-3-ultra-550b-a55b
//   nemotron-3-super        - nvidia/nemotron-3-super-120b-a12b
//   muse-glimmer-30b        - meta/muse-glimmer-30b
//   kimi-k3                 - moonshotai/kimi-k3
//   laguna-xs-2.1           - poolside/laguna-xs-2.1
//   diffusiongemma-26b      - google/diffusiongemma-26b-a4b-it

const MODELS = {
  'deepseek-v4-pro':        { id: 'deepseek-ai/deepseek-v4-pro-0813',   vision: false, thinking: false },
  'deepseek-v4-flash':      { id: 'deepseek-ai/deepseek-v4-flash-0731', vision: false, thinking: true  },
  'diffusiongemma-26b':     { id: 'google/diffusiongemma-26b-a4b-it',   vision: true,  thinking: true  },
  'gpt-oss-20b':            { id: 'openai/gpt-oss-20b',                 vision: false, thinking: true  },
  'gemma-4-31b':            { id: 'google/gemma-4-31b-it',              vision: true,  thinking: true  },
  'nemotron-3.5-lightning':  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', vision: false, thinking: true  },
  'nemotron-3-ultra':       { id: 'nvidia/nemotron-3-ultra-550b-a55b',  vision: false, thinking: true  },
  'nemotron-3-super':       { id: 'nvidia/nemotron-3-super-120b-a12b',  vision: false, thinking: true  },
  'muse-glimmer-30b':       { id: 'meta/muse-glimmer-30b',              vision: false, thinking: false },
  'kimi-k3':                { id: 'moonshotai/kimi-k3',                 vision: true,  thinking: true  },
  'laguna-xs-2.1':          { id: 'poolside/laguna-xs-2.1',             vision: false, thinking: false },
  'diffusiongemma-26b':     { id: 'google/diffusiongemma-26b-a4b-it',   vision: true,  thinking: true  }
};

const ALL_MODEL_KEYS = Object.keys(MODELS);

// Round-robin so the 12 models are spread across the 50 professors.
function modelFor(index) {
  return ALL_MODEL_KEYS[index % ALL_MODEL_KEYS.length];
}

const PALETTE = [
  '#ef4444','#f97316','#f59e0b','#eab308','#84cc16','#22c55e','#10b981','#14b8a6',
  '#06b6d4','#0ea5e9','#3b82f6','#6366f1','#8b5cf6','#a855f7','#d946ef','#ec4899',
  '#f43f5e','#78716c','#52525b','#1f2937','#dc2626','#ea580c','#ca8a04','#65a30d',
  '#16a34a','#0d9488','#0891b2','#2563eb','#4f46e5','#7c3aed','#c026d3','#db2777',
  '#e11d48','#9a3412','#92400e','#3f6212','#166534','#115e59','#155e75','#1e40af',
  '#3730a3','#5b21b6','#86198f','#9d174d','#0f172a','#334155','#475569','#64748b',
  '#0891b2','#0e7490'
];

// ============================================================
// CATEGORIES — 8 research clusters
// Each professor gets a category by their primary expertise.
// Default positions are computed in a radial cluster pattern.
// ============================================================
const CATEGORIES = {
  physics:    { name: 'Physics & Astronomy',  color: '#3b82f6', icon: '⚛️' },
  math:       { name: 'Math & Logic',         color: '#8b5cf6', icon: '∫' },
  chemistry:  { name: 'Chemistry & Earth',    color: '#10b981', icon: '⚗️' },
  bio:        { name: 'Biology & Medicine',   color: '#22c55e', icon: '🧬' },
  cs:         { name: 'CS & Engineering',     color: '#06b6d4', icon: '⚙️' },
  humanities: { name: 'Humanities',           color: '#f59e0b', icon: '📜' },
  social:     { name: 'Social Sciences',      color: '#ec4899', icon: '⚖️' },
  arts:       { name: 'Arts & Culture',       color: '#a855f7', icon: '🎭' }
};

const CATEGORY_BY_INDEX = [
  // MIT (17)
  'bio',        // 01 Elena Vasquez — computational neuroscience
  'physics',    // 02 Hiroshi Tanaka — quantum computing
  'chemistry',  // 03 Amelia Chen — synthetic organic chemistry
  'cs',         // 04 Marcus Feldman — cryptography
  'cs',         // 05 Priya Raman — robotics
  'physics',    // 06 Daniel Okonkwo — plasma physics
  'chemistry',  // 07 Sofia Lindqvist — marine geology
  'cs',         // 08 Rajiv Bhatt — compilers
  'bio',        // 09 Yuki Sato — synthetic biology
  'cs',         // 10 Olivia Romano — aerodynamics
  'math',       // 11 Liam O'Sullivan — pure math
  'bio',        // 12 Aisha Mensah — cancer immunotherapy
  'cs',         // 13 Wei Zhang — reinforcement learning
  'physics',    // 14 Noah Goldstein — photovoltaics
  'humanities', // 15 Camila Rojas — linguistics
  'physics',    // 16 Ethan Klein — astrophysics
  'cs',         // 17 Naomi Park — cybersecurity policy

  // Harvard (17)
  'social',     // 18 Adrian Cole — constitutional law
  'humanities', // 19 Mei Ling — comparative literature
  'social',     // 20 Bartholomew Hughes — macroeconomics
  'bio',        // 21 Isabella Reyes — epidemiology
  'bio',        // 22 Samuel Pierce — molecular biology
  'social',     // 23 Ananya Krishnan — applied statistics
  'humanities', // 24 Theodore Banks — Greek philosophy
  'chemistry',  // 25 Fatima Al-Sayed — climate science
  'bio',        // 26 Jonathan Adler — evolutionary biology
  'math',       // 27 Xinyi Wu — quantum information theory
  'social',     // 28 Richard Hawkins — intl law
  'social',     // 29 Lucia Marquez — economic history
  'humanities', // 30 Thomas Beckett — moral philosophy
  'math',       // 31 Nadia Volkov — algebraic geometry
  'humanities', // 32 Patrick Donnelly — theology
  'bio',        // 33 Yara Habibi — public health nutrition
  'humanities', // 34 Marcus Aurelius Wright — ancient history

  // Oxford (16)
  'physics',    // 35 Eleanor Fitzroy — particle physics
  'humanities', // 36 James Wetherby — English literature
  'social',     // 37 Priya Patel — intl relations
  'humanities', // 38 Victor Hugo Mendez — Andean archaeology
  'chemistry',  // 39 Charlotte Pembroke — inorganic chemistry
  'math',       // 40 Rohan Mehta — number theory
  'bio',        // 41 Genevieve Bisset — tropical medicine
  'humanities', // 42 Ibrahim Hassan — Arabic & Islamic studies
  'physics',    // 43 Helena Strauss — condensed matter
  'arts',       // 44 Connor MacLeod — music theory
  'humanities', // 45 Aiko Yamamoto — phonetics
  'humanities', // 46 Sebastian Crowe — medieval history
  'physics',    // 47 Laila Bouzid — theoretical cosmology
  'humanities', // 48 Hugo Bernstein — philosophical logic
  'bio',        // 49 Tamara Volkova — neuroscience of memory
  'social'      // 50 William Hartwell — political theory
];

// Cluster centers laid out in a 3×3 grid (with center empty)
const CLUSTER_CENTERS = {
  physics:    { x: 220,  y: 180 },
  math:       { x: 500,  y: 180 },
  chemistry:  { x: 780,  y: 180 },
  bio:        { x: 220,  y: 400 },
  cs:         { x: 500,  y: 400 },
  humanities: { x: 780,  y: 400 },
  social:     { x: 220,  y: 620 },
  arts:       { x: 500,  y: 620 }
};

// Assign deterministic positions within a category's cluster.
// Professors are spread in a circle around the center, with small radius.
function clusterPosition(categoryKey, ordinalInCat) {
  const center = CLUSTER_CENTERS[categoryKey];
  if (!center) return { x: 100 + ordinalInCat * 30, y: 100 };
  const total = PROFESSORS_BY_CATEGORY[categoryKey].length;
  // Use a Fibonacci-spiral for even distribution
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const t = (ordinalInCat + 0.5) / total;
  const radius = 30 + Math.sqrt(t) * 75;
  const angle = ordinalInCat * goldenAngle;
  return {
    x: Math.round(center.x + Math.cos(angle) * radius),
    y: Math.round(center.y + Math.sin(angle) * radius)
  };
}

// ============= 50 unique fields =============
export const PROFESSORS = [
  // ---- MIT (17) ----
  { name: 'Dr. Elena Vasquez',   title: 'Professor of Computational Neuroscience',         university: 'MIT',          expertise: ['computational neuroscience','brain circuits','synaptic plasticity'], subfields: ['neural coding','astrocyte signaling'] },
  { name: 'Dr. Hiroshi Tanaka',  title: 'Professor of Quantum Computing',                  university: 'MIT',          expertise: ['quantum computing','quantum error correction','topological qubits'], subfields: ['surface codes','anyon braiding'] },
  { name: 'Dr. Amelia Chen',     title: 'Professor of Synthetic Organic Chemistry',         university: 'MIT',          expertise: ['synthetic organic chemistry','catalysis','total synthesis'], subfields: ['C-H activation','asymmetric catalysis'] },
  { name: 'Dr. Marcus Feldman',  title: 'Professor of Cryptography',                       university: 'MIT',          expertise: ['cryptography','post-quantum security','zero-knowledge proofs'], subfields: ['lattice-based crypto','MPC'] },
  { name: 'Dr. Priya Raman',     title: 'Professor of Robotics & Embodied AI',             university: 'MIT',          expertise: ['robotics','embodied AI','manipulation'], subfields: ['soft robotics','sim-to-real'] },
  { name: 'Dr. Daniel Okonkwo',  title: 'Professor of Plasma Physics & Fusion',             university: 'MIT',          expertise: ['plasma physics','nuclear fusion','tokamak engineering'], subfields: ['magnetic confinement','SPARC'] },
  { name: 'Dr. Sofia Lindqvist', title: 'Professor of Marine Geology',                      university: 'MIT',          expertise: ['marine geology','abyssal sedimentation','seafloor volcanism'], subfields: ['mid-ocean ridges','black smokers'] },
  { name: 'Dr. Rajiv Bhatt',     title: 'Professor of Compiler Design',                    university: 'MIT',          expertise: ['compilers','programming languages','type theory'], subfields: ['LLVM','dependent types'] },
  { name: 'Dr. Yuki Sato',       title: 'Professor of Synthetic Biology',                   university: 'MIT',          expertise: ['synthetic biology','genetic circuits','cell-free systems'], subfields: ['gene drives','biosensors'] },
  { name: 'Dr. Olivia Romano',   title: 'Professor of Aerodynamics',                       university: 'MIT',          expertise: ['aerodynamics','hypersonic flow','CFD'], subfields: ['shock waves','boundary layers'] },
  { name: 'Dr. Liam O\'Sullivan', title: 'Professor of Pure Mathematics',                  university: 'MIT',          expertise: ['pure mathematics','algebraic topology','category theory'], subfields: ['homotopy theory','K-theory'] },
  { name: 'Dr. Aisha Mensah',    title: 'Professor of Cancer Immunotherapy',                university: 'MIT',          expertise: ['cancer immunotherapy','CAR-T','tumor microenvironment'], subfields: ['checkpoint inhibitors','TCR engineering'] },
  { name: 'Dr. Wei Zhang',       title: 'Professor of Reinforcement Learning',              university: 'MIT',          expertise: ['reinforcement learning','decision theory','multi-agent RL'], subfields: ['policy optimization','exploration'] },
  { name: 'Dr. Noah Goldstein',  title: 'Professor of Photovoltaic Engineering',            university: 'MIT',          expertise: ['photovoltaics','perovskite solar cells','energy materials'], subfields: ['tandem cells','charge transport'] },
  { name: 'Dr. Camila Rojas',    title: 'Professor of Linguistics & Syntax',                university: 'MIT',          expertise: ['linguistics','syntax','language universals'], subfields: ['minimalism','field linguistics'] },
  { name: 'Dr. Ethan Klein',     title: 'Professor of Astrophysics',                       university: 'MIT',          expertise: ['astrophysics','stellar dynamics','gravitational waves'], subfields: ['LIGO','binary mergers'] },
  { name: 'Dr. Naomi Park',      title: 'Professor of Cybersecurity Policy',                university: 'MIT',          expertise: ['cybersecurity policy','nation-state threats','critical infrastructure'], subfields: ['attribution','deterrence'] },

  // ---- Harvard (17) ----
  { name: 'Dr. Adrian Cole',     title: 'Professor of Constitutional Law',                  university: 'Harvard',      expertise: ['constitutional law','judicial review','civil rights'], subfields: ['First Amendment','14th Amendment'] },
  { name: 'Dr. Mei Ling',        title: 'Professor of Comparative Literature',              university: 'Harvard',      expertise: ['comparative literature','postcolonial narratives','translation theory'], subfields: ['world literature','diaspora'] },
  { name: 'Dr. Bartholomew Hughes', title: 'Professor of Macroeconomics',                   university: 'Harvard',      expertise: ['macroeconomics','monetary policy','fiscal policy'], subfields: ['DSGE','inflation dynamics'] },
  { name: 'Dr. Isabella Reyes',  title: 'Professor of Epidemiology',                       university: 'Harvard',      expertise: ['epidemiology','pandemic modeling','global health'], subfields: ['infectious disease dynamics','vaccine equity'] },
  { name: 'Dr. Samuel Pierce',   title: 'Professor of Molecular Biology',                  university: 'Harvard',      expertise: ['molecular biology','gene regulation','chromatin'], subfields: ['epigenetics','non-coding RNA'] },
  { name: 'Dr. Ananya Krishnan', title: 'Professor of Applied Statistics',                 university: 'Harvard',      expertise: ['applied statistics','causal inference','Bayesian methods'], subfields: ['propensity scoring','hierarchical models'] },
  { name: 'Dr. Theodore Banks',  title: 'Professor of Greek Philosophy',                   university: 'Harvard',      expertise: ['Greek philosophy','Aristotelian ethics','Stoicism'], subfields: ['virtue ethics','political philosophy'] },
  { name: 'Dr. Fatima Al-Sayed', title: 'Professor of Climate Science',                    university: 'Harvard',      expertise: ['climate science','atmospheric dynamics','carbon cycle'], subfields: ['feedback loops','tipping points'] },
  { name: 'Dr. Jonathan Adler', title: 'Professor of Evolutionary Biology',                university: 'Harvard',      expertise: ['evolutionary biology','speciation','phylogenetics'], subfields: ['adaptive radiation','molecular evolution'] },
  { name: 'Dr. Xinyi Wu',        title: 'Professor of Quantum Information Theory',          university: 'Harvard',      expertise: ['quantum information theory','entanglement','channel capacity'], subfields: ['holographic duality','operator algebras'] },
  { name: 'Dr. Richard Hawkins', title: 'Professor of Public International Law',           university: 'Harvard',      expertise: ['international law','humanitarian law','treaty interpretation'], subfields: ['ICJ','customary law'] },
  { name: 'Dr. Lucia Marquez',   title: 'Professor of Macroeconomic History',              university: 'Harvard',      expertise: ['economic history','financial crises','institutions'], subfields: ['Great Depression','debt cycles'] },
  { name: 'Dr. Thomas Beckett',  title: 'Professor of Moral Philosophy',                   university: 'Harvard',      expertise: ['moral philosophy','normative ethics','justice'], subfields: ['contractualism','consequentialism'] },
  { name: 'Dr. Nadia Volkov',    title: 'Professor of Algebraic Geometry',                  university: 'Harvard',      expertise: ['algebraic geometry','schemes','derived categories'], subfields: ['moduli spaces','mirror symmetry'] },
  { name: 'Dr. Patrick Donnelly', title: 'Professor of Theology & Religious Studies',       university: 'Harvard',      expertise: ['theology','comparative religion','hermeneutics'], subfields: ['Abrahamic traditions','phenomenology of religion'] },
  { name: 'Dr. Yara Habibi',     title: 'Professor of Public Health Nutrition',             university: 'Harvard',      expertise: ['public health nutrition','metabolic disease','food systems'], subfields: ['gut microbiome','diet policy'] },
  { name: 'Dr. Marcus Aurelius Wright', title: 'Professor of Ancient History',              university: 'Harvard',      expertise: ['ancient history','Roman empire','Late Antiquity'], subfields: ['epigraphy','prosopography'] },

  // ---- Oxford (16) ----
  { name: 'Dr. Eleanor Fitzroy',  title: 'Professor of Particle Physics',                  university: 'Oxford',       expertise: ['particle physics','Higgs sector','collider phenomenology'], subfields: ['LHC','BSM searches'] },
  { name: 'Dr. James Wetherby',   title: 'Professor of English Literature',                university: 'Oxford',       expertise: ['English literature','Romantic poetry','modernist fiction'], subfields: ['Shakespeare','stream of consciousness'] },
  { name: 'Dr. Priya Patel',      title: 'Professor of Public International Relations',    university: 'Oxford',       expertise: ['international relations','diplomatic history','great power politics'], subfields: ['realism','liberal institutionalism'] },
  { name: 'Dr. Victor Hugo Mendez', title: 'Professor of Andean Archaeology',              university: 'Oxford',       expertise: ['archaeology','Andean civilizations','lithic analysis'], subfields: ['Inca','preceramic cultures'] },
  { name: 'Dr. Charlotte Pembroke', title: 'Professor of Inorganic Chemistry',             university: 'Oxford',       expertise: ['inorganic chemistry','coordination complexes','organometallics'], subfields: ['catalysis','MOF design'] },
  { name: 'Dr. Rohan Mehta',      title: 'Professor of Number Theory',                     university: 'Oxford',       expertise: ['number theory','analytic number theory','modular forms'], subfields: ['L-functions','BSD conjecture'] },
  { name: 'Dr. Genevieve Bisset', title: 'Professor of Tropical Medicine',                  university: 'Oxford',       expertise: ['tropical medicine','parasitology','neglected diseases'], subfields: ['malaria','antimicrobial resistance'] },
  { name: 'Dr. Ibrahim Hassan',   title: 'Professor of Arabic & Islamic Studies',           university: 'Oxford',       expertise: ['Arabic studies','Islamic philosophy','Sufi thought'], subfields: ['Ibn Sina','Mysticism'] },
  { name: 'Dr. Helena Strauss',   title: 'Professor of Condensed Matter Physics',          university: 'Oxford',       expertise: ['condensed matter','topological materials','superconductivity'], subfields: ['twisted bilayer graphene','correlated electrons'] },
  { name: 'Dr. Connor MacLeod',   title: 'Professor of Music Theory & Composition',         university: 'Oxford',       expertise: ['music theory','serialism','spectral composition'], subfields: ['counterpoint','algorithmic composition'] },
  { name: 'Dr. Aiko Yamamoto',    title: 'Professor of Linguistics & Phonetics',            university: 'Oxford',       expertise: ['phonetics','laboratory phonology','tone'], subfields: ['articulatory phonology','tone languages'] },
  { name: 'Dr. Sebastian Crowe',  title: 'Professor of Medieval History',                   university: 'Oxford',       expertise: ['medieval history','crusades','manorial economy'], subfields: ['Anglo-Norman','monasticism'] },
  { name: 'Dr. Laila Bouzid',     title: 'Professor of Theoretical Cosmology',              university: 'Oxford',       expertise: ['theoretical cosmology','inflation','dark energy'], subfields: ['CMB','large scale structure'] },
  { name: 'Dr. Hugo Bernstein',   title: 'Professor of Philosophical Logic',                university: 'Oxford',       expertise: ['philosophical logic','modal logic','philosophy of language'], subfields: ['possible worlds','reference'] },
  { name: 'Dr. Tamara Volkova',   title: 'Professor of Neuroscience of Memory',             university: 'Oxford',       expertise: ['neuroscience of memory','hippocampus','engram cells'], subfields: ['long-term potentiation','systems consolidation'] },
  { name: 'Dr. William Hartwell', title: 'Professor of Political Theory',                  university: 'Oxford',       expertise: ['political theory','republicanism','liberalism'], subfields: ['Pettit','Rawls'] }
];

const PROFESSORS_BY_CATEGORY = {};
PROFESSORS.forEach((p, i) => {
  const cat = CATEGORY_BY_INDEX[i] || 'cs';
  if (!PROFESSORS_BY_CATEGORY[cat]) PROFESSORS_BY_CATEGORY[cat] = [];
  PROFESSORS_BY_CATEGORY[cat].push(i);
});

// Build full professor records with model assignment.
export function buildRoster() {
  const catOrdinal = {};
  return PROFESSORS.map((p, i) => {
    const primary = modelFor(i);
    const fallbacks = ALL_MODEL_KEYS.filter(k => k !== primary).slice(0, 3);
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const cat = CATEGORY_BY_INDEX[i] || 'cs';
    const catInfo = CATEGORIES[cat];
    const ordinal = (catOrdinal[cat] = (catOrdinal[cat] || 0) + 1) - 1;
    const pos = clusterPosition(cat, ordinal);
    return {
      id: `prof_${String(i + 1).padStart(2, '0')}_${slug}`,
      name: p.name,
      title: p.title,
      university: p.university,
      expertise: p.expertise,
      subfields: p.subfields || [],
      primary_model: primary,
      fallback_models: fallbacks,
      model_id: MODELS[primary].id,
      personality: `A ${p.university} scholar of ${p.expertise.join(', ')}. Precise, citation-driven, opinionated within their specialty.`,
      category: cat,
      category_name: catInfo?.name || cat,
      avatar_color: catInfo?.color || PALETTE[i % PALETTE.length],
      position_x: pos.x,
      position_y: pos.y,
      status: 'idle'
    };
  });
}

export { CATEGORIES };

export { MODELS };
