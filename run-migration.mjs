import pg from 'pg';
import fs from 'fs';

const sql = fs.readFileSync('../supabase/migrations/006_libraries.sql', 'utf8');

// Try multiple connection methods
const connections = [
  // Session mode pooler
  `postgresql://postgres.zflawbkznckwlutlcgjh:***SCRUBBED***@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
  // Transaction mode pooler
  `postgresql://postgres.zflawbkznckwlutlcgjh:***SCRUBBED***@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
  // Direct
  `postgresql://postgres:***SCRUBBED***@db.zflawbkznckwlutlcgjh.supabase.co:5432/postgres`,
];

for (const connStr of connections) {
  const host = new URL(connStr).hostname;
  console.log(`Trying ${host}...`);
  const client = new pg.Client({ connectionString: connStr, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    console.log('Connected! Running migration...');
    await client.query(sql);
    console.log('Migration completed successfully!');

    // Verify
    const res = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('libraries','library_members') ORDER BY tablename");
    console.log('Tables created:', res.rows.map(r => r.tablename));

    const cols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name='books' AND column_name IN ('library_id','external_id','external_source') ORDER BY column_name");
    console.log('New book columns:', cols.rows.map(r => r.column_name));

    await client.end();
    process.exit(0);
  } catch (e) {
    console.log(`Failed: ${e.message}`);
    try { await client.end(); } catch {}
  }
}

console.log('All connection methods failed');
process.exit(1);
