// Professor Senate — Neural Canvas v2 (full UX overhaul)
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

const state = {
  professors: [], selected: null, pollers: [],
  connections: new Map(), pendingDebatePoll: false,
  zoom: 1, panX: 0, panY: 0, draggingPan: false,
  categoryFilter: null, showConnections: true,
  sidebarDirty: false, lastSidebarProf: null
};

window.addEventListener('beforeunload', () => {
  for (const p of state.pollers) { try { p.stop(); } catch (_) {} }
});

// ---------- Helpers ----------
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
function time(ts) { try { return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); } catch(_) { return ts; } }
function initials(n) { const p=(n||'').replace(/^Dr\.\s*/i,'').split(/\s+/); return p.length>=2?(p[0][0]+p[p.length-1][0]).toUpperCase():(p[0]||'?').slice(0,2).toUpperCase(); }
function uniAbbr(u) { return u==='Harvard'?'H':u==='Oxford'?'O':'M'; }
function statusLabel(s) { return {idle:'Idle',working:'Working',thinking:'Thinking',debating:'Debating',reviewing:'Reviewing'}[s]||s; }
function activityText(p) { return {idle:'Waiting for task…',working:'Processing…',thinking:'Analyzing…',debating:'In debate…',reviewing:'Reviewing sources…'}[p.status||'idle']||'Active'; }
function toast(msg, duration = 2500) { const t=$('#toast'); t.textContent=msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.add('hidden'), duration); }

// ---------- Confirmation Dialog ----------
function confirmDialog(message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <div class="confirm-msg">${esc(message)}</div>
        <div class="confirm-actions">
          <button class="confirm-cancel">Cancel</button>
          <button class="confirm-ok">Confirm</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.confirm-ok').onclick = () => { overlay.remove(); resolve(true); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

// ---------- Boot ----------
async function boot() {
  const r = await fetch('/api/professors').then(r => r.json()).catch(() => []);
  state.professors = Array.isArray(r) ? r : [];
  const loading = $('#boardLoading');
  if (loading) loading.remove();
  renderNodes();
  renderLegend();
  bindUI();
  startLive();
  initFloatingPanels();
  initZoomPan();
  initKeyboard();
}

// ---------- Category legend (clickable filter) ----------
function renderLegend() {
  const el = $('#catLegend');
  if (!el || !state.professors.length) return;
  const cats = {};
  for (const p of state.professors) {
    const c = p.category || 'cs';
    if (!cats[c]) cats[c] = { name: p.category_name || c, color: p.avatar_color, count: 0 };
    cats[c].count++;
  }
  el.innerHTML = `<div class="cat-item cat-item-all ${!state.categoryFilter ? 'active' : ''}" data-cat="">All (${state.professors.length})</div>` +
    Object.entries(cats).map(([key, c]) =>
      `<div class="cat-item ${state.categoryFilter === key ? 'active' : ''}" data-cat="${key}">
        <span class="cat-dot" style="background:${c.color};--dot-color:${c.color}"></span>
        ${esc(c.name)}
        <span class="cat-count">${c.count}</span>
      </div>`
    ).join('');
  el.querySelectorAll('.cat-item').forEach(item => {
    item.addEventListener('click', () => {
      const cat = item.dataset.cat;
      state.categoryFilter = cat || null;
      renderLegend();
      renderNodes();
    });
  });
}

// ---------- Search with count + transitions ----------
function renderNodes() {
  const board = $('#board');
  $$('.prof-node', board).forEach(el => el.remove());
  const filter = ($('#search')||{}).value?.trim().toLowerCase() || '';
  const uni = ($('#filterUni')||{}).value || '';
  let idx = 0, shown = 0;

  for (const p of state.professors) {
    if (uni && p.university !== uni) continue;
    if (state.categoryFilter && p.category !== state.categoryFilter) continue;
    if (filter) {
      const hay = [p.name,p.title,p.university,...(p.expertise||[]),...(p.subfields||[])].join(' ').toLowerCase();
      if (!hay.includes(filter)) continue;
    }
    shown++;
    const node = document.createElement('div');
    node.className = `prof-node status-${p.status||'idle'} node-entering`;
    node.dataset.id = p.id;
    node.style.setProperty('--stagger', `${idx*20}ms`);
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
    // Click: open sidebar on desktop, tooltip on mobile
    node.addEventListener('click', (ev) => {
      if (ev._dragMoved) return;
      if ('ontouchstart' in window) {
        // Mobile: toggle tooltip visibility
        const wasOpen = node.classList.contains('tooltip-open');
        $$('.prof-node.tooltip-open').forEach(n => n.classList.remove('tooltip-open'));
        if (!wasOpen) node.classList.add('tooltip-open');
      } else {
        selectProfessor(p);
      }
    });
    board.appendChild(node);
    // Stagger animation
    requestAnimationFrame(() => { node.classList.remove('node-entering'); });
    idx++;
  }
  // Update search count
  const countEl = $('#searchCount');
  if (countEl) {
    if (filter || uni || state.categoryFilter) {
      countEl.textContent = `${shown}/${state.professors.length}`;
      countEl.classList.remove('hidden');
    } else {
      countEl.classList.add('hidden');
    }
  }
}

// ---------- Zoom/Pan ----------
function initZoomPan() {
  const board = $('#board');
  let startX, startY, startPanX, startPanY;

  // Mouse wheel zoom
  board.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    state.zoom = Math.max(0.3, Math.min(3, state.zoom + delta));
    applyTransform();
  }, { passive: false });

  // Middle-click or Ctrl+click pan
  board.addEventListener('mousedown', (e) => {
    if (e.target.closest('.prof-node') || e.target.closest('.cat-legend') || e.target.closest('.board-loading')) return;
    if (e.button === 1 || (e.button === 0 && e.ctrlKey)) {
      state.draggingPan = true;
      startX = e.clientX; startY = e.clientY;
      startPanX = state.panX; startPanY = state.panY;
      board.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!state.draggingPan) return;
    state.panX = startPanX + (e.clientX - startX);
    state.panY = startPanY + (e.clientY - startY);
    applyTransform();
  });
  window.addEventListener('mouseup', () => {
    if (state.draggingPan) {
      state.draggingPan = false;
      board.style.cursor = '';
    }
  });

  // Touch pinch zoom
  let lastTouchDist = 0;
  board.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  }, { passive: true });
  board.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const scale = dist / lastTouchDist;
      state.zoom = Math.max(0.3, Math.min(3, state.zoom * scale));
      lastTouchDist = dist;
      applyTransform();
    }
  }, { passive: true });

  // Double-click to reset zoom
  board.addEventListener('dblclick', (e) => {
    if (e.target.closest('.prof-node')) return;
    state.zoom = 1; state.panX = 0; state.panY = 0;
    applyTransform();
  });
}

function applyTransform() {
  const content = $$('#board .prof-node, #board svg.connections');
  const t = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  const boardContent = $('#board');
  boardContent.style.transform = t;
  boardContent.style.transformOrigin = '0 0';
  // Update zoom display
  const zoomEl = $('#zoomLevel');
  if (zoomEl) zoomEl.textContent = `${Math.round(state.zoom * 100)}%`;
}

// ---------- Keyboard shortcuts ----------
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Don't trigger if typing in input/textarea
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    switch(e.key) {
      case '/': e.preventDefault(); $('#search')?.focus(); break;
      case 'Escape':
        $$('.prof-node.tooltip-open').forEach(n => n.classList.remove('tooltip-open'));
        $('#sidebarPanel')?.classList.add('hidden');
        $('#chatPanel')?.classList.add('hidden');
        break;
      case 'c': // Toggle chat
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          $('#chatPanel')?.classList.toggle('hidden');
        }
        break;
      case 'd': // Toggle sidebar detail
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          $('#sidebarPanel')?.classList.toggle('hidden');
        }
        break;
      case '+': case '=': // Zoom in
        e.preventDefault();
        state.zoom = Math.min(3, state.zoom + 0.1);
        applyTransform();
        break;
      case '-': // Zoom out
        e.preventDefault();
        state.zoom = Math.max(0.3, state.zoom - 0.1);
        applyTransform();
        break;
      case '0': // Reset zoom
        e.preventDefault();
        state.zoom = 1; state.panX = 0; state.panY = 0;
        applyTransform();
        break;
      case 'l': // Toggle connection lines
        e.preventDefault();
        state.showConnections = !state.showConnections;
        $$('.conn-line, .conn-particle').forEach(el => el.style.display = state.showConnections ? '' : 'none');
        toast(state.showConnections ? 'Connections visible' : 'Connections hidden');
        break;
    }
  });
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

// ---------- Sidebar (context-aware, prevents data loss) ----------
async function selectProfessor(p) {
  // Check for unsaved input in sidebar
  if (state.sidebarDirty && state.lastSidebarProf) {
    const input = $('#directAskInput');
    if (input?.value.trim()) {
      const proceed = await confirmDialog(`Unsaved question for ${state.lastSidebarProf.name}. Discard?`);
      if (!proceed) return;
    }
  }

  state.selected = p;
  state.lastSidebarProf = p;
  state.sidebarDirty = false;
  $$('.prof-node.selected').forEach(n => n.classList.remove('selected'));
  const node = $(`.prof-node[data-id="${p.id}"]`);
  if (node) node.classList.add('selected');

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
  $('#openFullProfile')?.addEventListener('click', () => { window.location.href = `/professor/${p.id}`; });
  const askInput = $('#directAskInput');
  if (askInput) {
    askInput.addEventListener('input', () => { state.sidebarDirty = askInput.value.trim().length > 0; });
  }
  $('#directAsk').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const prompt = $('#directAskInput').value.trim();
    if (!prompt) return;
    state.sidebarDirty = false;
    addChat(`You → ${p.name}`, prompt);
    $('#directAskInput').value = '';
    // Show loading in sidebar
    const journalEl = $('#profJournals');
    if (journalEl) journalEl.insertAdjacentHTML('afterbegin', '<div class="entry entry-loading"><div class="meta">Waiting for response…</div></div>');
    try {
      const res = await fetch('/api/ask', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt,professor_id:p.id}) });
      const j = await res.json();
      if (j.answers?.[0]) addChat(p.name, j.answers[0].content, {model:j.answers[0].model});
      else addChat('System', j.error||'No response.');
    } catch(e) {
      addChat('System', 'Network error. Please try again.');
    }
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
  const le = $('#profLogs'); if (le) le.innerHTML = (l||[]).map(x => `<div class="entry"><div class="meta">${time(x.created_at)} · ${esc(x.category)} · <span style="color:${x.level==='error'?'#ef4444':x.level==='warn'?'#f59e0b':'#6b7a8d'}">${esc(x.level)}</span></div><div>${esc(x.message)}</div></div>`).join('')||'<div class="empty">No logs yet.</div>';
  const lrEl = $('#profLearnings'); if (lrEl) lrEl.innerHTML = (lr||[]).map(x => `<div class="entry"><div class="meta">${esc(x.source)} · conf ${(x.confidence!=null?Number(x.confidence).toFixed(2):'?')}</div><b>${esc(x.title||'')}</b><div>${esc(x.insight||x.summary||'')}</div></div>`).join('')||'<div class="empty">No learnings yet.</div>';
}

// ---------- Chat (streaming + typing indicator) ----------
function addChat(who, body, meta = {}) {
  const log = $('#chatlog');
  const el = document.createElement('div');
  el.className = 'msg' + (meta.thinking ? ' thinking' : meta.model ? '' : ' user');
  el.innerHTML = `<div class="who">${esc(who)}${meta.model ? ' · ' + esc(meta.model) : ''}</div><div class="body">${esc(body)}</div>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

// Streaming chat element (updates in place)
function addStreamingChat(who, meta = {}) {
  const log = $('#chatlog');
  const el = document.createElement('div');
  el.className = 'msg streaming';
  el.innerHTML = `<div class="who">${esc(who)}</div><div class="body"><span class="streaming-cursor">|</span></div>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return {
    el,
    append(text) {
      const bodyEl = el.querySelector('.body');
      const cursor = bodyEl.querySelector('.streaming-cursor');
      if (cursor) cursor.remove();
      bodyEl.innerHTML = esc(bodyEl.textContent + text);
      bodyEl.innerHTML += '<span class="streaming-cursor">|</span>';
      log.scrollTop = log.scrollHeight;
    },
    finish(finalText, model) {
      const bodyEl = el.querySelector('.body');
      const cursor = bodyEl.querySelector('.streaming-cursor');
      if (cursor) cursor.remove();
      bodyEl.innerHTML = esc(finalText);
      if (model) el.querySelector('.who').textContent += ` · ${model}`;
      el.classList.remove('streaming');
    }
  };
}

$('#askForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const prompt = $('#askInput').value.trim();
  if (!prompt) return;
  addChat('You', prompt);
  $('#askInput').value = '';
  const chatPanel = $('#chatPanel');
  if (chatPanel.classList.contains('hidden')) chatPanel.classList.remove('hidden');

  const thinkingEl = addChat('Senate', 'Thinking… ⏳', { thinking: true });
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    thinkingEl.remove();
    // SSE stream with token-by-token display
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const streaming = {};
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          // Finalize all streaming elements
          for (const [pid, s] of Object.entries(streaming)) s.finish(s.el.querySelector('.body').textContent, s.model);
          return;
        }
        try {
          const a = JSON.parse(data);
          if (a.error) { addChat('System', a.error.replace(/^Error:\s*/, '')); continue; }
          if (!streaming[a.professor_id]) {
            streaming[a.professor_id] = addStreamingChat(`${a.professor_name} (${(a.expertise||[])[0]||''})`);
            streaming[a.professor_id].model = a.model;
          }
          // Simulate streaming by appending chunks
          const chunks = a.content.match(/.{1,20}/gs) || [a.content];
          for (const chunk of chunks) {
            streaming[a.professor_id].append(chunk);
            await new Promise(r => setTimeout(r, 15));
          }
          streaming[a.professor_id].finish(a.content, a.model);
        } catch (_) {}
      }
    }
  } catch (e) {
    thinkingEl.remove();
    addChat('System', 'Network error. Is the server running? Check server status.');
  }
});

// ---------- Buttons with confirmation ----------
$('#debateBtn').addEventListener('click', async () => {
  const ok = await confirmDialog('Trigger a random debate between two professors? This will use LLM tokens.');
  if (!ok) return;
  toast('Triggering debate…');
  try {
    const r = await fetch('/api/debates/trigger', {method:'POST'});
    const j = await r.json();
    toast(j.ok ? 'Debate kicked off' : 'Failed: ' + (j.error || ''));
  } catch(e) { toast('Network error'); }
});

$('#tickAllBtn').addEventListener('click', async () => {
  const ok = await confirmDialog('Tick all 50 professors? Each will make 1 LLM call. This may take several minutes and use significant tokens.');
  if (!ok) return;
  toast('Ticking all… this may take a while');
  try {
    const r = await fetch('/api/professors/tick-all',{method:'POST'});
    const j = await r.json();
    toast(j.ok ? `Ticked ${j.processed}/${j.total}` : 'Failed');
  } catch(_) { toast('Network error'); }
});

// ---------- Connection Lines ----------
function getSvgEl() { return $('#connections'); }
function getNodeCenter(id) {
  const node = $(`.prof-node[data-id="${id}"]`);
  if (!node) return null;
  const board=$('#board'), br=board.getBoundingClientRect(), nr=node.getBoundingClientRect();
  return { x:nr.left-br.left+nr.width/2, y:nr.top-br.top+nr.height/2 };
}
function setConnection(idA,idB,active) {
  if (!state.showConnections) return;
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

// ---------- Floating panels ----------
function initFloatingPanels() {
  const sidebar = $('#sidebarPanel');
  const chat = $('#chatPanel');
  const fabSidebar = $('#toggleSidebar');
  const fabChat = $('#toggleChat');
  sidebar.classList.add('hidden');
  chat.classList.add('hidden');

  // FABs: click to toggle (NOT draggable — too confusing)
  fabSidebar.addEventListener('click', () => sidebar.classList.toggle('hidden'));
  fabChat.addEventListener('click', () => chat.classList.toggle('hidden'));

  $('#closeSidebar').addEventListener('click', () => sidebar.classList.add('hidden'));
  $('#closeChat').addEventListener('click', () => chat.classList.add('hidden'));

  // Panels are draggable via header
  makePanelDraggable(sidebar, $('#sidebarDragHandle'));
  makePanelDraggable(chat, $('#chatDragHandle'));
}

function makePanelDraggable(panel, handle) {
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
function clampPanel(p) {
  const r = p.getBoundingClientRect();
  const w = window.innerWidth, h = window.innerHeight;
  p.style.left = Math.max(0, Math.min(r.left, w - 60)) + 'px';
  p.style.top = Math.max(46, Math.min(r.top, h - 60)) + 'px';
}

// ---------- Live polling ----------
function startLive() {
  for (const p of state.pollers) { try{p.stop();}catch(_){} }
  state.pollers = [];

  let profPollTimer = null;
  async function pollProfessors() {
    if (state._profPolling) return;
    state._profPolling = true;
    try {
      const r = await fetch('/api/professors').then(r => r.json());
      if (!Array.isArray(r)) return;
      for (const np of r) {
        const old = state.professors.find(x => x.id === np.id);
        if (!old) continue;
        if (old.status === np.status && old.total_interactions === np.total_interactions) continue;
        const wasIdle = old.status === 'idle';
        Object.assign(old, { status: np.status, total_interactions: np.total_interactions, position_x: np.position_x, position_y: np.position_y });
        const node = $(`.prof-node[data-id="${np.id}"]`);
        if (!node) continue;
        node.className = `prof-node status-${np.status || 'idle'}` + (state.selected?.id === np.id ? ' selected' : '');
        if (wasIdle && np.status !== 'idle') { node.style.transform = 'scale(1.25)'; setTimeout(() => { node.style.transform = ''; }, 300); }
      }
    } catch(_) {}
    state._profPolling = false;
    const activeCount = state.professors.filter(p => p.status !== 'idle').length;
    const interval = activeCount > 10 ? 5000 : activeCount > 0 ? 8000 : 15000;
    profPollTimer = setTimeout(pollProfessors, interval);
  }
  pollProfessors();

  async function pollDebates() {
    if (state.pendingDebatePoll) return;
    state.pendingDebatePoll = true;
    try {
      const r = await fetch('/api/debates?limit=5').then(r => r.json());
      if (!Array.isArray(r)) return;
      for (const d of r) {
        const turns = d.turns || [];
        if (turns.length >= 2) {
          const a = turns[0]?.professor_id, b = turns[1]?.professor_id;
          if (a && b) setConnection(a, b, d.status !== 'concluded');
        }
      }
    } catch(_) {}
    state.pendingDebatePoll = false;
    setTimeout(pollDebates, 10000);
  }
  pollDebates();

  const poller = SupabaseRT.poll('journals', new Date(Date.now() - 600000).toISOString(), () => { if (state.selected) refreshPanel(); }, 5000);
  state.pollers.push(poller);
}

// ---------- UI Bindings ----------
function bindUI() {
  const searchInput = $('#search');
  let searchDebounce;
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(renderNodes, 200);
  });
  $('#filterUni')?.addEventListener('change', renderNodes);

  // Zoom buttons
  $('#zoomIn')?.addEventListener('click', () => { state.zoom = Math.min(3, state.zoom + 0.15); applyTransform(); });
  $('#zoomOut')?.addEventListener('click', () => { state.zoom = Math.max(0.3, state.zoom - 0.15); applyTransform(); });
  $('#zoomReset')?.addEventListener('click', () => { state.zoom = 1; state.panX = 0; state.panY = 0; applyTransform(); });
  $('#toggleLines')?.addEventListener('click', () => {
    state.showConnections = !state.showConnections;
    $$('.conn-line, .conn-particle').forEach(el => el.style.display = state.showConnections ? '' : 'none');
    toast(state.showConnections ? 'Connections visible' : 'Connections hidden');
  });

  // Offline detection — grace period 10s before showing, longer timeout for Render cold starts
  window.addEventListener('online', () => { $('#offlineBar')?.classList.remove('visible'); });
  window.addEventListener('offline', () => { $('#offlineBar')?.classList.add('visible'); });
  let offlineCount = 0;
  setTimeout(() => {
    setInterval(async () => {
      try {
        const r = await fetch('/api/health', { signal: AbortSignal.timeout(15000) });
        const j = await r.json();
        if (j.ok) {
          offlineCount = 0;
          $('#offlineBar')?.classList.remove('visible');
        } else throw new Error();
      } catch {
        offlineCount++;
        // Only show after 2 consecutive failures (avoid false positives)
        if (offlineCount >= 2) $('#offlineBar')?.classList.add('visible');
      }
    }, 30000);
  }, 10000);
}

boot();
