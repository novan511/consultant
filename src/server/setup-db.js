// Runs schema.sql against your Supabase Postgres database.
// Requires DATABASE_URL (direct connection string, NOT the REST URL).
// Get it from: Supabase → Project Settings → Database → Connection string (URI, port 5432, direct).
// Example: postgresql://postgres:[PASSWORD]@db.qksffsjstsajbrplcaik.supabase.co:5432/postgres
//
// If DATABASE_URL is missing, we fall back to printing the SQL for manual paste.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const url = process.env.DATABASE_URL;
const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

if (!url) {
  console.log('========================================================');
  console.log('DATABASE_URL is not set.');
  console.log('To auto-apply schema, set DATABASE_URL in .env, e.g.:');
  console.log('  DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.qksffsjstsajbrplcaik.supabase.co:5432/postgres');
  console.log('Then run: npm run setup-db');
  console.log('========================================================');
  console.log('\n--- SCHEMA SQL (paste into Supabase SQL editor if you prefer) ---\n');
  console.log(sql);
  process.exit(0);
}

async function main() {
  let Client;
  try {
    ({ Client } = await import('pg'));
  } catch {
    console.error("The 'pg' package is required for auto-setup. Install it with: npm i pg");
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected. Applying schema…');
  try {
    await client.query(sql);
    console.log('Schema applied successfully.');
  } catch (e) {
    console.error('Schema apply failed:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
