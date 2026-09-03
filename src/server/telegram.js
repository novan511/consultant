// Telegram bridge — new v2 API (middleware-based).
let Bot, Api;
let bot = null, api = null;
let senateRef = null;

export async function initTelegram(senate) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — Telegram bridge disabled.');
    return;
  }

  try {
    const mod = await import('node-telegram-bot-api');
    Bot = mod.Bot; Api = mod.Api;
  } catch (e) {
    console.error('[telegram] Failed to load node-telegram-bot-api:', e.message);
    return;
  }

  senateRef = senate;
  bot = new Bot(token, { testing: false });
  api = new Api(token);

  // Register middleware
  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name || 'there';
    await api.sendMessage(ctx.chat.id,
      `Welcome to Professor Senate, ${name}.\n\n` +
      `I have 50 professors from MIT, Harvard, and Oxford.\n` +
      `Type any question and I'll route it to the best expert(s).\n\n` +
      `/list — Show all professors\n` +
      `/debate — Trigger a random debate`
    );
  });

  bot.command('list', async (ctx) => {
    if (!senateRef) return api.sendMessage(ctx.chat.id, 'Senate not ready.');
    const lines = senateRef.roster.map((r, i) =>
      `${i + 1}. ${r.name} (${r.university}) — ${r.expertise[0]}`
    );
    await api.sendMessage(ctx.chat.id, lines.join('\n'));
  });

  bot.command('debate', async (ctx) => {
    if (!senateRef) return api.sendMessage(ctx.chat.id, 'Senate not ready.');
    try {
      const r = senateRef.roster[Math.floor(Math.random() * senateRef.roster.length)];
      const prof = senateRef.professors.get(r.id);
      await senateRef.maybeDebate(prof);
      await api.sendMessage(ctx.chat.id, `Debate completed! Check the UI for full transcript.`);
    } catch (e) {
      await api.sendMessage(ctx.chat.id, `Debate failed: ${e.message}`);
    }
  });

  // Catch-all: any text message → route to Senate
  bot.hears(/[\s\S]+/, async (ctx) => {
    const text = (ctx.message?.text || '').trim();
    if (!text || text.startsWith('/')) return;
    if (!senateRef) return api.sendMessage(ctx.chat.id, 'Senate is booting up…');
    const chatId = ctx.chat.id;

    await api.sendChatAction(chatId, 'typing');

    try {
      const answers = await senateRef.routeUserPrompt(text);
      if (!answers || answers.length === 0) {
        return api.sendMessage(chatId, 'No professor could answer that. Try rephrasing.');
      }
      for (const a of answers) {
        const header = `${a.professor_name} (${(a.expertise || [])[0] || ''})`;
        const body = a.content;
        const chunks = splitMessage(`${header}\n\n${body}`);
        for (const chunk of chunks) {
          await api.sendMessage(chatId, chunk);
        }
      }
    } catch (e) {
      console.error('[telegram] Error:', e.message);
      await api.sendMessage(chatId, `Error: ${e.message}`);
    }
  });

  bot.catch((err) => {
    console.error('[telegram] Bot error:', err.message);
  });

  // Start polling non-blocking
  bot.startPolling().catch(e => console.error('[telegram] Polling error:', e.message));
  console.log('[telegram] Bot started, polling for messages…');
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

export function stopTelegram() {
  if (bot) bot.stop();
}
