// Supabase REST polling client — keys served from /api/config
window.SupabaseRT = (function () {
  let url = '';
  let anon = '';

  async function init() {
    try {
      const r = await fetch('/api/config');
      const c = await r.json();
      url = c.supabaseUrl || '';
      anon = c.supabaseAnonKey || '';
    } catch (e) { console.warn('[SupabaseRT] config fetch failed'); }
  }

  function poll(table, since, cb, intervalMs = 4000) {
    let stopped = false, timer = null;
    async function tick() {
      if (stopped || !url || !anon) return;
      try {
        const q = `${url}/rest/v1/${table}?order=created_at.desc&limit=20${since ? `&created_at=gt.${encodeURIComponent(since)}` : ''}`;
        const r = await fetch(q, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data) && data.length) {
            cb(data.reverse());
            since = data[data.length - 1].created_at;
          }
        }
      } catch (_) {}
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
    init().then(tick);
    return { stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } } };
  }
  return { poll, init };
})();
