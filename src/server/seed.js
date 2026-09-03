// Run: node src/server/seed.js
// Inserts all 50 professors into Supabase (upsert by id).
import { buildRoster } from './professors.js';
import { supabase, ping } from './supabase.js';

async function main() {
  console.log('Pinging Supabase...');
  await ping();
  const roster = buildRoster();
  console.log(`Upserting ${roster.length} professors...`);
  const { error } = await supabase
    .from('professors')
    .upsert(roster.map(r => ({
      id: r.id,
      name: r.name,
      title: r.title,
      university: r.university,
      expertise: r.expertise,
      subfields: r.subfields,
      primary_model: r.primary_model,
      model_id: r.model_id,
      fallback_models: r.fallback_models,
      personality: r.personality,
      avatar_color: r.avatar_color,
      position_x: r.position_x,
      position_y: r.position_y,
      status: 'idle'
    })), { onConflict: 'id' });
  if (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
  console.log('Done. 50 professors in Supabase.');
}

main().catch(e => { console.error(e); process.exit(1); });
