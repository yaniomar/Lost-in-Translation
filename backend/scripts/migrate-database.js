import 'dotenv/config';
import { Pool } from '@neondatabase/serverless';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizedText } from '../app.js';

const databaseUrl = (process.env.DATABASE_URL || '').trim();
if (!databaseUrl) {
  console.error('BLOCKED: DATABASE_URL is required. No database changes were made.');
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const schemaPath = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
  const seedPath = fileURLToPath(new URL('../sentences_log.json', import.meta.url));
  const schema = await readFile(schemaPath, 'utf8');
  const seed = JSON.parse(await readFile(seedPath, 'utf8'));
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(schema);

    for (const [sortOrder, preset] of (seed.presets || []).entries()) {
      await client.query(`
        INSERT INTO sentence_presets (id, text, normalized_text, category, sort_order)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text,
          normalized_text = EXCLUDED.normalized_text, category = EXCLUDED.category,
          sort_order = EXCLUDED.sort_order
      `, [preset.id, preset.text, normalizedText(preset.text), preset.category || 'Team', sortOrder]);
    }

    for (const example of seed.offlineExamples || []) {
      await client.query(`
        INSERT INTO offline_examples
          (id, original, normalized_original, final_arabic, similarity, recorded_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET original = EXCLUDED.original,
          normalized_original = EXCLUDED.normalized_original,
          final_arabic = EXCLUDED.final_arabic, similarity = EXCLUDED.similarity,
          recorded_at = EXCLUDED.recorded_at
      `, [example.id, example.original, normalizedText(example.original), example.finalArabic,
        example.similarity, example.recordedAt]);
    }

    // Only historical, non-demo plays remain in this import source. Verified
    // presentation rows were removed from sentences_log.json before DEVFEST.
    for (const play of seed.plays || []) {
      await client.query(`
        INSERT INTO plays
          (id, player_name, mode, original, final_arabic, similarity, created_at, translation_source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO NOTHING
      `, [play.id, play.playerName, play.mode, play.original, play.finalArabic,
        play.similarity, play.createdAt, play.translationSource || 'aws']);
    }

    for (const [playerId, attempt] of Object.entries(seed.playerAttempts || {})) {
      await client.query(`
        INSERT INTO player_attempts (player_id, player_name, completed, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (player_id) DO UPDATE SET player_name = EXCLUDED.player_name,
          completed = GREATEST(player_attempts.completed, EXCLUDED.completed), updated_at = EXCLUDED.updated_at
      `, [playerId, attempt.playerName, attempt.completed, attempt.updatedAt || new Date().toISOString()]);
    }

    await client.query(`
      UPDATE aws_usage SET
        aws_requests_attempted = GREATEST(aws_requests_attempted, $1),
        translated_characters_submitted = GREATEST(translated_characters_submitted, $2),
        updated_at = NOW()
      WHERE id = 1
    `, [seed.usage?.awsRequestsAttempted || 0, seed.usage?.translatedCharactersSubmitted || 0]);

    await client.query('COMMIT');
    console.log('PASS: schema applied and existing local booth data imported.');
  } catch (error) {
    try { await client?.query('ROLLBACK'); } catch {}
    console.error('Database migration failed. No partial import was committed.');
    console.error(`Database error code: ${error?.code || 'UNKNOWN'}`);
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end();
  }
}
