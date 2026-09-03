// Telegram bridge — direct HTTP API, no library dependency.
let botToken = '';
let senateRef = null;
let pollingOffset = 0;
let pollingTimer = null;

const API = (method) => `https://api.telegram.org/bot${botToken}/${method}`;

async function sendMessage(chatId, text, opts = {}) {
  // Telegram limit 4096 chars, split if needed.
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    try {
      await fetch(API('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown', ...opts })
      });
    } catch (e) {
      // Fallback without markdown if parse fails
      try {
        await fetch(API('sendMessage'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk })
        });
      } catch (_) {}
    }
  }
}

async function sendChatAction(chatId, action = 'typing') {
  try {
    await fetch(API('sendChatAction'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action })
    });
  } catch (_) {}
}

async function getUpdates() {
  try {
    const r = await fetch(`${API('getUpdates')}?offset=${pollingOffset}&timeout=30&allowed_updates=["message"]`);
    const data = await r.json();
    if (data.ok && data.result) {
      for (const update of data.result) {
        pollingOffset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
      }
    }
  } catch (e) {
    console.error('[telegram] Polling error:', e.message);
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  // /start
  if (text === '/start') {
    const name = msg.from?.first_name || 'there';
    await sendMessage(chatId,
      `Welcome to Professor Senate, ${name}.\n\n` +
      `I have 50 professors from MIT, Harvard, and Oxford, each with unique expertise.\n` +
      `Just type a question and I'll route it to the best expert.\n\n` +
      `/list — Show all professors\n` +
      `/debate — Trigger a random debate`
    );
    return;
  }

  // /list
  if (text === '/list') {
    if (!senateRef) return sendMessage(chatId, 'Senate not ready.');
    const lines = senateRef.roster.slice(0, 50).map((r, i) =>
      `${i + 1}. ${r.name} (${r.university}) — ${r.expertise[0]}`
    );
    await sendMessage(chatId, lines.join('\n'));
    return;
  }

  // /debate
  if (text === '/debate') {
    if (!senateRef) return sendMessage(chatId, 'Senate not ready.');
    try {
      const r = senateRef.roster[Math.floor(Math.random() * senateRef.roster.length)];
      const prof = senateRef.professors.get(r.id);
      await senateRef.maybeDebate(prof);
      await sendMessage(chatId, 'Debate completed! Check the web UI for the full transcript.');
    } catch (e) {
      await sendMessage(chatId, `Debate failed: ${e.message}`);
    }
    return;
  }

  // /ask <question>
  if (text.startsWith('/ask ')) {
    await handleQuestion(chatId, text.slice(5).trim());
    return;
  }

  // Plain text → route to Senate
  await handleQuestion(chatId, text);
}

async function handleQuestion(chatId, question) {
  if (!question) return sendMessage(chatId, 'Please ask a question.');
  if (!senateRef) return sendMessage(chatId, 'Senate is booting up…');

  await sendChatAction(chatId, 'typing');

  try {
    // Route to 1 best professor.
    const scored = senateRef.roster.map(r => {
      const fields = [...(r.expertise || []), ...(r.subfields || [])].join(' ').toLowerCase();
      let s = 0;
      for (const t of question.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2)) {
        if (fields.includes(t)) s += 1;
      }
      return { r, s };
    }).sort((a, b) => b.s - a.s);
    const best = scored.find(x => x.s > 0)?.r || scored[0].r;

    const prof = senateRef.professors.get(best.id);
    const { content, model } = await prof.ask(question, { temperature: 0.7, max_tokens: 800 });

    await prof.journal('response', {
      title: `Reply to user: ${question.slice(0, 60)}`,
      content, topic: question, user_prompt: question,
      metadata: { model, source: 'telegram' }
    });

    const header = `*${best.name}* (${best.expertise[0]})`;
    await sendMessage(chatId, `${header}\n\n${content}`);
  } catch (e) {
    console.error('[telegram] Error:', e.message);
    await sendMessage(chatId, `Error: ${e.message}`);
  }
}

function splitMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}

export async function initTelegram(senate) {
  botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — disabled.');
    return;
  }
  senateRef = senate;

  // Verify bot
  try {
    const r = await fetch(API('getMe'));
    const me = await r.json();
    if (me.ok) {
      console.log(`[telegram] Bot @${me.result.username} started.`);
    } else {
      console.error('[telegram] Bot token invalid:', me);
      return;
    }
  } catch (e) {
    console.error('[telegram] Failed to connect:', e.message);
    return;
  }

  // Start polling loop
  async function poll() {
    await getUpdates();
    pollingTimer = setTimeout(poll, 1000);
  }
  poll();
}

export function stopTelegram() {
  if (pollingTimer) clearTimeout(pollingTimer);
}
