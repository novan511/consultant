// Professor Senate — Neural Canvas (floating panels + draggable FABs)
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

const state = {
  professors: [], selected: null, pollers: [],
  connections: new Map(), pendingDebatePoll: false
};

window.addEventListener('beforeunload', () => {
  for (const p of state.pollers) { try { p.stop(); } catch (_) {} }
});

// ---------- Boot ----------
async function boot() {
  const r = await fetch('/api/professors').then(r => r.json()).catch(() => []);
  state.professors = Array.isArray(r) ? r : [];
  renderNodes();
  renderLegend();
  bindUI();
  startLive();
  initFloatingPanels();
}

// ---------- Category legend ----------
function renderLegend() {
  const el = $('#catLegend');
  if (!el || !state.professors.length) return;
  const cats = {};
  for (const p of state.professors) {
    const c = p.category || 'cs';
    if (!cats[c]) cats[c] = { name: p.category_name || c, color: p.avatar_color, count: 0 };
    cats[c].count++;
  }
  el.innerHTML = Object.values(cats).map(c =>
    `<div class="cat-item">
      <span class="cat-dot" style="background:${c.color};--dot-color:${c.color}"></span>
      ${esc(c.name)}
      <span class="cat-count">${c.count}</span>
    </div>`
  ).join('');
}

// ---------- Helpers ----------
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
function time(ts) { try { return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); } catch(_) { return ts; } }
function initials(n) { const p=(n||'').replace(/^Dr\.\s*/i,'').split(/\s+/); return p.length>=2?(p[0][0]+p[p.length-1][0]).toUpperCase():(p[0]||'?').slice(0,2).toUpperCase(); }
function uniAbbr(u) { return u==='Harvard'?'H':u==='Oxford'?'O':'M'; }
function statusLabel(s) { return {idle:'Idle',working:'Working',thinking:'Thinking',debating:'Debating',reviewing:'Reviewing'}[s]||s; }
function activityText(p) { return {idle:'Waiting for task…',working:'Processing…',thinking:'Analyzing…',debating:'In debate…',reviewing:'Reviewing sources…'}[p.status||'idle']||'Active'; }
function toast(msg) { const t=$('#toast'); t.textContent=msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.add('hidden'),2500); }

// ---------- Floating panels ----------
function initFloatingPanels() {
  const sidebar = $('#sidebarPanel');
  const chat = $('#chatPanel');
  const fabSidebar = $('#toggleSidebar');
  const fabChat = $('#toggleChat');

  // Start hidden
  sidebar.classList.add('hidden');
  chat.classList.add('hidden');

  // FABs: click to toggle
  fabSidebar.addEventListener('click', (e) => {
    if (e._moved) return;
    sidebar.classList.toggle('hidden');
  });
  fabChat.addEventListener('click', (e) => {
    if (e._moved) return;
    chat.classList.toggle('hidden');
  });

  // Close buttons
  $('#closeSidebar').addEventListener('click', () => sidebar.classList.add('hidden'));
  $('#closeChat').addEventListener('click', () => chat.classList.add('hidden'));

  // Make panels + FABs draggable
  makeFloatingDraggable(sidebar, $('#sidebarDragHandle'));
  makeFloatingDraggable(chat, $('#chatDragHandle'));
  makeFabDraggable(fabSidebar);
  makeFabDraggable(fabChat);
}

function makeFloatingDraggable(panel, handle) {
  let dragging = false, startX, startY, origX, origY;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('.float-close')) return;
    dragging = true; startX = e.clientX; startY = e.clientY;
    origX = panel.offsetLeft; origY = panel.offsetTop;
    panel.style.transition = 'none';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left = (origX + e.clientX - startX) + 'px';
    panel.style.top = (origY + e.clientY - startY) + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    document.body.style.userSelect = '';
    clampPanel(panel);
  });
}

function makeFabDraggable(fab) {
  let dragging = false, startX, startY, origX, origY, moved;
  fab.addEventListener('mousedown', (e) => {
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    origX = fab.offsetLeft; origY = fab.offsetTop;
    fab.style.transition = 'none';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    fab.style.left = (origX + dx) + 'px';
    fab.style.top = (origY + dy) + 'px';
    fab.style.right = 'auto'; fab.style.bottom = 'auto';
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    fab.style.transition = '';
    document.body.style.userSelect = '';
    e._moved = moved;
    clampFab(fab);
  });
}

function clampPanel(p) {
  const r = p.getBoundingClientRect();
  const w = window.innerWidth, h = window.innerHeight;
  p.style.left = Math.max(0, Math.min(r.left, w - 60)) + 'px';
  p.style.top = Math.max(46, Math.min(r.top, h - 60)) + 'px';
}
function clampFab(f) {
  const r = f.getBoundingClientRect();
  const w = window.innerWidth, h = window.innerHeight;
  f.style.left = Math.max(0, Math.min(r.left, w - 48)) + 'px';
  f.style.top = Math.max(46, Math.min(r.top, h - 48)) + 'px';
}

// ---------- Render circular nodes ----------
function renderNodes() {
  const board = $('#board');
  $$('.prof-node', board).forEach(el => el.remove());
  const filter = ($('#search')||{}).value?.trim().toLowerCase() || '';
  const uni = ($('#filterUni')||{}).value || '';
  let idx = 0;

  for (const p of state.professors) {
    if (uni && p.university !== uni) continue;
    if (filter) {
      const hay = [p.name,p.title,p.university,...(p.expertise||[]),...(p.subfields||[])].join(' ').toLowerCase();
      if (!hay.includes(filter)) continue;
    }
    const node = document.createElement('div');
    node.className = `prof-node status-${p.status||'idle'}`;
    node.dataset.id = p.id;
    node.style.setProperty('--stagger', `${idx*30}ms`);
    node.style.left = (p.position_x||100)+'px';
    node.style.top = (p.position_y||100)+'px';
    node.style.setProperty('--node-color', p.avatar_color||'#7c3aed');
    node.innerHTML = `
      <span class="ring"></span>
      <span class="uni-badge uni-${p.university}">${uniAbbr(p.university)}</span>
      <span class="core"><span class="initials">${initials(p.name)}</span></span>
      <span class="node-label">${(p.name||'').replace(/^Dr\.\s*/,'')}</span>
      <div class="tooltip">
        <div class="tt-name">${esc(p.name)}</div>
        <div class="tt-uni">${esc(p.university)}</div>
        <div class="tt-expertise">${esc((p.expertise||[]).join(', '))}</div>
        <div class="tt-status"><span class="tt-status-dot"></span><span class="tt-status-text">${esc(statusLabel(p.status||'idle'))}</span></div>
        <div class="tt-activity">${esc(activityText(p))}</div>
      </div>
    `;
    makeDraggableNode(node, p);
    node.addEventListener('click', (ev) => { if (!ev._dragMoved) selectProfessor(p); });
    board.appendChild(node);
    idx++;
  }
}

// ---------- Node drag ----------
function makeDraggableNode(el, prof) {
  let sx,sy,ox,oy,drag=false,moved=false;
  el.addEventListener('mousedown', (e) => {
    if (e.button!==0) return;
    drag=true; moved=false;
    sx=e.clientX; sy=e.clientY;
    ox=parseInt(el.style.left,10)||0; oy=parseInt(el.style.top,10)||0;
    document.body.style.userSelect='none'; el.style.zIndex=10;
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX-sx)>2||Math.abs(e.clientY-sy)>2) moved=true;
    el.style.left=(ox+e.clientX-sx)+'px'; el.style.top=(oy+e.clientY-sy)+'px';
    updateAllConnections();
  });
  window.addEventListener('mouseup', (e) => {
    if (!drag) return; drag=false;
    document.body.style.userSelect=''; el.style.zIndex='';
    if (moved) {
      e._dragMoved = true;
      clearTimeout(makeDraggableNode._t);
      makeDraggableNode._t = setTimeout(() => {
        fetch(`/api/professors/${prof.id}/position`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({x:parseInt(el.style.left,10),y:parseInt(el.style.top,10)})
        }).catch(()=>{});
      }, 200);
      updateAllConnections();
    }
  });
}

// ---------- Sidebar ----------
async function selectProfessor(p) {
  state.selected = p;
  $$('.prof-node.selected').forEach(n => n.classList.remove('selected'));
  const node = $(`.prof-node[data-id="${p.id}"]`);
  if (node) node.classList.add('selected');

  // Open sidebar
  $('#sidebarPanel').classList.remove('hidden');

  const panel = $('#detailPanel');
  panel.innerHTML = `
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <h2 style="margin:0">${esc(p.name)}</h2>
        <button class="full-profile-btn" id="openFullProfile" title="Open full detail page" style="font-size:11px;padding:4px 8px;border-radius:6px;background:var(--accent);color:#fff;border:none;cursor:pointer;">Full Profile →</button>
      </div>
      <div class="uni">${esc(p.university)} · ${esc(p.primary_model)}</div>
      <div class="exp">${esc(p.expertise.join(' · '))}</div>
      <div class="row"><b>Title:</b> ${esc(p.title)}</div>
      <div class="row"><b>Subfields:</b> ${esc((p.subfields||[]).join(' · '))}</div>
      <div class="row"><b>Category:</b> ${esc(p.category_name||'')}</div>
      <div class="row"><b>Interactions:</b> ${p.total_interactions||0}</div>
      <div class="section">
        <h3>Ask directly</h3>
        <form id="directAsk">
          <textarea id="directAskInput" placeholder="Ask ${esc(p.name)}…" style="width:100%;height:48px;font-size:12px;"></textarea>
          <button type="submit" style="margin-top:4px;font-size:11px;">Send</button>
        </form>
      </div>
      <div class="section"><h3>Journals</h3><div id="profJournals">Loading…</div></div>
      <div class="section"><h3>Logs</h3><div id="profLogs">Loading…</div></div>
      <div class="section"><h3>Learnings</h3><div id="profLearnings">Loading…</div></div>
    </div>
  `;
  // Full profile button
  const fpBtn = $('#openFullProfile');
  if (fpBtn) fpBtn.addEventListener('click', () => { window.location.href = `/professor/${p.id}`; });
  $('#directAsk').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const prompt = $('#directAskInput').value.trim();
    if (!prompt) return;
    addChat(`You → ${p.name}`, prompt);
    $('#directAskInput').value = '';
    const res = await fetch('/api/ask', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt,professor_id:p.id}) });
    const j = await res.json();
    if (j.answers?.[0]) addChat(p.name, j.answers[0].content, {model:j.answers[0].model});
    else addChat('System', j.error||'No response.');
    refreshPanel();
  });
  refreshPanel();
}

async function refreshPanel() {
  if (!state.selected) return;
  const p = state.selected;
  const [j,l,lr] = await Promise.all([
    fetch(`/api/journals?professor_id=${p.id}&limit=20`).then(r=>r.json()).catch(()=>[]),
    fetch(`/api/logs?professor_id=${p.id}&limit=30`).then(r=>r.json()).catch(()=>[]),
    fetch(`/api/learnings?professor_id=${p.id}`).then(r=>r.json()).catch(()=>[])
  ]);
  const je = $('#profJournals'); if (!je) return;
  je.innerHTML = (j||[]).map(x => `<div class="entry"><div class="meta">${time(x.created_at)} · ${esc(x.kind)}</div><b>${esc(x.title||'')}</b><div>${esc((x.content||'').slice(0,200))}${(x.content||'').length>200?'…':''}</div></div>`).join('')||'<div class="empty">No journals yet.</div>';
  const le = $('#profLogs'); if (le) le.innerHTML = (l||[]).map(x => `<div class="entry"><div class="meta">${time(x.created_at)} · ${esc(x.category)} · ${esc(x.level)}</div><div>${esc(x.message)}</div></div>`).join('')||'<div class="empty">No logs yet.</div>';
  const lrEl = $('#profLearnings'); if (lrEl) lrEl.innerHTML = (lr||[]).map(x => `<div class="entry"><div class="meta">${esc(x.source)} · conf ${(x.confidence!=null?Number(x.confidence).toFixed(2):'?')}</div><b>${esc(x.title||'')}</b><div>${esc(x.insight||x.summary||'')}</div></div>`).join('')||'<div class="empty">No learnings yet.</div>';
}

// ---------- Chat ----------
function addChat(who, body, meta = {}) {
  const log = $('#chatlog');
  const el = document.createElement('div');
  el.className = 'msg' + (meta.thinking ? ' thinking' : meta.model ? '' : ' user');
  el.innerHTML = `<div class="who">${esc(who)}${meta.model ? ' · ' + esc(meta.model) : ''}</div><div class="body">${esc(body)}</div>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

$('#askForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const prompt = $('#askInput').value.trim();
  if (!prompt) return;
  addChat('You', prompt);
  $('#askInput').value = '';
  // Open chat panel if hidden
  const chatPanel = $('#chatPanel');
  if (chatPanel.classList.contains('hidden')) chatPanel.classList.remove('hidden');
  // Show thinking indicator
  const thinkingEl = addChat('Senate', 'Thinking… ⏳', { thinking: true });
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    // Remove thinking indicator
    if (thinkingEl) thinkingEl.remove();
    // SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          const a = JSON.parse(data);
          if (a.error) { addChat('System', `Error from ${a.professor_id}: ${a.error}`); continue; }
          addChat(`${a.professor_name} (${(a.expertise||[])[0]||''})`, a.content, { model: a.model });
        } catch (_) {}
      }
    }
  } catch (e) {
    if (thinkingEl) thinkingEl.remove();
    addChat('System', 'Network error. Is the server running?');
  }
});

$('#debateBtn').addEventListener('click', async () => {
  toast('Triggering debate…');
  const r = await fetch('/api/debates/trigger', {method:'POST'});
  const j = await r.json();
  toast(j.ok?'Debate kicked off':'Failed: '+(j.error||''));
});

$('#tickAllBtn').addEventListener('click', async () => {
  toast('Ticking all…');
  try { const r=await fetch('/api/professors/tick-all',{method:'POST'}); const j=await r.json(); toast(j.ok?`Ticked ${j.processed}/${j.total}`:'Failed'); } catch(_) { toast('Network error'); }
});

function bindUI() {
  $('#search').addEventListener('input', renderNodes);
  $('#filterUni').addEventListener('change', renderNodes);
}

// ---------- Connection Lines (SVG) ----------
function getSvgEl() { return $('#connections'); }
function getNodeCenter(id) {
  const node = $(`.prof-node[data-id="${id}"]`);
  if (!node) return null;
  const board=$('#board'), br=board.getBoundingClientRect(), nr=node.getBoundingClientRect();
  return { x:nr.left-br.left+nr.width/2, y:nr.top-br.top+nr.height/2 };
}
function setConnection(idA,idB,active) {
  const key=[idA,idB].sort().join('|'), svg=getSvgEl();
  if (!state.connections.has(key)) {
    const line=document.createElementNS('http://www.w3.org/2000/svg','line'); line.classList.add('conn-line'); svg.appendChild(line);
    const particle=document.createElementNS('http://www.w3.org/2000/svg','circle'); particle.classList.add('conn-particle'); svg.appendChild(particle);
    state.connections.set(key,{lineEl:line,particleEl:particle,a:idA,b:idB});
  }
  const c=state.connections.get(key); c.active=active;
  c.lineEl.classList.toggle('active',active); c.particleEl.classList.toggle('active',active);
  if (active) { const pa=state.professors.find(p=>p.id===idA); c.lineEl.style.stroke=pa?.avatar_color||'#06b6d4'; c.particleEl.style.fill='#fff'; }
  updateConnection(key);
}
function updateConnection(key) {
  const c=state.connections.get(key); if (!c) return;
  const a=getNodeCenter(c.a),b=getNodeCenter(c.b); if (!a||!b) return;
  c.lineEl.setAttribute('x1',a.x);c.lineEl.setAttribute('y1',a.y);c.lineEl.setAttribute('x2',b.x);c.lineEl.setAttribute('y2',b.y);
  const t=(Date.now()%2000)/2000;
  c.particleEl.setAttribute('cx',a.x+(b.x-a.x)*t); c.particleEl.setAttribute('cy',a.y+(b.y-a.y)*t);
}
function updateAllConnections() { for (const [key] of state.connections) updateConnection(key); }
function animateParticles() { for (const [key,c] of state.connections) if (c.active) updateConnection(key); requestAnimationFrame(animateParticles); }
requestAnimationFrame(animateParticles);

// ---------- Live polling ----------
function startLive() {
  for (const p of state.pollers) { try{p.stop();}catch(_){} }
  state.pollers = [];

  setInterval(async () => {
    try {
      const r = await fetch('/api/professors').then(r=>r.json());
      if (!Array.isArray(r)) return;
      for (const np of r) {
        const old=state.professors.find(x=>x.id===np.id); if (!old) continue;
        const wasIdle=old.status==='idle';
        Object.assign(old,{status:np.status,total_interactions:np.total_interactions,position_x:np.position_x,position_y:np.position_y});
        const node=$(`.prof-node[data-id="${np.id}"]`); if (!node) continue;
        node.className=`prof-node status-${np.status||'idle'}`+(state.selected?.id===np.id?' selected':'');
        if (wasIdle && np.status!=='idle') { node.style.transform='scale(1.25)'; setTimeout(()=>{node.style.transform='';},300); }
      }
    } catch(_){}
  }, 6000);

  setInterval(async () => {
    if (state.pendingDebatePoll) return; state.pendingDebatePoll=true;
    try {
      const r=await fetch('/api/debates?limit=5').then(r=>r.json());
      if (!Array.isArray(r)) return;
      for (const d of r) {
        const turns=d.turns||[];
        if (turns.length>=2) { const a=turns[0]?.professor_id,b=turns[1]?.professor_id; if(a&&b) setConnection(a,b,d.status!=='concluded'); }
      }
    } catch(_){}
    state.pendingDebatePoll=false;
  }, 5000);

  const poller=SupabaseRT.poll('journals',new Date(Date.now()-600000).toISOString(),()=>{if(state.selected)refreshPanel();},5000);
  state.pollers.push(poller);
}

boot();
