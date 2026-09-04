// Structured logging utility — replaces silent .catch(() => {}) everywhere.
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'];

function log(level, tag, message, details = {}) {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
  const detailStr = Object.keys(details).length ? ' ' + JSON.stringify(details) : '';
  if (level === 'error') {
    console.error(`${prefix} ${message}${detailStr}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}${detailStr}`);
  } else {
    console.log(`${prefix} ${message}${detailStr}`);
  }
}

// Safe wrapper: runs fn, catches and logs errors. Never throws.
export async function safeAsync(label, fn) {
  try {
    return await fn();
  } catch (e) {
    log('error', label, e.message, { stack: e.stack?.split('\n').slice(0, 3).join(' | ') });
    return null;
  }
}

// Fire-and-forget with logging (replaces fireAndForget from supabase.js)
export function fireAndForget(label, promise) {
  promise.catch(e => log('error', label, e.message));
}

// Retry wrapper with exponential backoff
export async function withRetry(label, fn, { maxRetries = 3, baseDelay = 1000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        log('warn', label, `Attempt ${attempt + 1} failed, retrying in ${delay}ms: ${e.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  log('error', label, `All ${maxRetries + 1} attempts failed: ${lastError.message}`);
  throw lastError;
}

export { log };
