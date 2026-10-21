import 'dotenv/config';
import { Pool } from '@neondatabase/serverless';

const verifiedDemoRows = [
  ['seed-1', 'ليان', 'guardian', 100, '2026-10-15T09:20:00.000Z'],
  ['seed-2', 'عمر', 'glitcher', 6, '2026-10-15T09:24:00.000Z'],
  ['seed-3', 'سارة', 'guardian', 100, '2026-10-15T09:31:00.000Z'],
  ['seed-4', 'يزن', 'glitcher', 4, '2026-10-15T09:38:00.000Z'],
  ['seed-5', 'نور', 'guardian', 100, '2026-10-15T09:42:00.000Z'],
  ['seed-6', 'آدم', 'glitcher', 8, '2026-10-15T09:50:00.000Z'],
].map(([id, playerName, mode, similarity, createdAt]) => ({ id, playerName, mode, similarity, createdAt }));

const execute = process.argv.includes('--execute');
const databaseUrl = (process.env.DATABASE_URL || '').trim();
if (!databaseUrl) {
  console.error('BLOCKED: DATABASE_URL is required. No database changes were made.');
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const ids = verifiedDemoRows.map((row) => row.id);
    const { rows } = await client.query(`
      SELECT id, player_name, mode, similarity, created_at, translation_source
      FROM plays WHERE id = ANY($1::text[]) ORDER BY created_at
    `, [ids]);
    const expectedById = new Map(verifiedDemoRows.map((row) => [row.id, row]));
    const matched = rows.filter((row) => {
      const expected = expectedById.get(row.id);
      return expected && row.player_name === expected.playerName && row.mode === expected.mode
        && row.similarity === expected.similarity
        && new Date(row.created_at).toISOString() === expected.createdAt;
    });
    const protectedRows = rows.filter((row) => !matched.some((match) => match.id === row.id));
    const missingIds = ids.filter((id) => !rows.some((row) => row.id === id));
    const { rows: [remaining] } = await client.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE mode = 'guardian')::int AS guardians,
        COUNT(*) FILTER (WHERE mode = 'glitcher')::int AS glitchers
      FROM plays WHERE NOT (id = ANY($1::text[]))
    `, [matched.map((row) => row.id)]);

    console.log(`${execute ? 'EXECUTION' : 'DRY RUN'}: verified demo leaderboard cleanup`);
    console.table(matched.map((row) => ({
      id: row.id, player: row.player_name, mode: row.mode,
      similarity: `${row.similarity}%`, createdAt: new Date(row.created_at).toISOString(),
    })));
    console.log(`Verified demo rows eligible for removal: ${matched.length}`);
    console.log(`Other plays preserved: ${remaining.total} (${remaining.guardians} guardian, ${remaining.glitchers} glitcher)`);
    if (missingIds.length) console.log(`Verified demo IDs already absent: ${missingIds.join(', ')}`);
    if (protectedRows.length) console.log(`Protected because stored values did not match the verified fingerprint: ${protectedRows.map((row) => row.id).join(', ')}`);

    if (execute) {
      if (!matched.length) {
        console.log('No verified demo rows remain; nothing to delete.');
      } else {
        await client.query('DELETE FROM plays WHERE id = ANY($1::text[])', [matched.map((row) => row.id)]);
        console.log(`Deleted ${matched.length} verified demo score rows. Presets, offline examples, attempts, and AWS usage were untouched.`);
      }
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
      console.log('No changes made. Run with --execute only after explicit approval.');
    }
  } catch (error) {
    try { await client?.query('ROLLBACK'); } catch {}
    console.error('Demo score cleanup failed. No partial cleanup was committed.');
    console.error(`Database error code: ${error?.code || 'UNKNOWN'}`);
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end();
  }
}
