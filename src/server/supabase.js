import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 10 } }
});

export const supabaseAnon = createClient(url, anonKey, {
  auth: { persistSession: false }
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))
  ]);
}

export function fireAndForget(promise) {
  promise.then(() => {}, () => {});
}

export async function ping() {
  try {
    const { error } = await withTimeout(
      supabase.from('professors').select('id', { count: 'exact', head: true }),
      8000
    );
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn('[supabase] ping failed (non-fatal):', e.message);
    return false;
  }
}
