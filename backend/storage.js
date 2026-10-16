import { Pool } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export class StorageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

function databaseDefaults(database) {
  database.presets = Array.isArray(database.presets) ? database.presets : [];
  database.plays = Array.isArray(database.plays) ? database.plays : [];
  database.offlineExamples = Array.isArray(database.offlineExamples) ? database.offlineExamples : [];
  database.usage = database.usage && typeof database.usage === 'object' && !Array.isArray(database.usage)
    ? database.usage : {};
  database.usage.awsRequestsAttempted = Number.isSafeInteger(database.usage.awsRequestsAttempted)
    && database.usage.awsRequestsAttempted >= 0 ? database.usage.awsRequestsAttempted : 0;
  database.usage.translatedCharactersSubmitted = Number.isSafeInteger(database.usage.translatedCharactersSubmitted)
    && database.usage.translatedCharactersSubmitted >= 0 ? database.usage.translatedCharactersSubmitted : 0;
  database.playerAttempts = database.playerAttempts && typeof database.playerAttempts === 'object'
    && !Array.isArray(database.playerAttempts) ? database.playerAttempts : {};
  return database;
}

function leaderboardFromPlays(plays) {
  const competitive = plays.filter((play) => play.translationSource !== 'offline');
  return {
    guardians: competitive
      .filter((play) => play.mode === 'guardian')
      .sort((a, b) => b.similarity - a.similarity || a.createdAt.localeCompare(b.createdAt))
      .slice(0, 5),
    glitchers: competitive
      .filter((play) => play.mode === 'glitcher')
      .sort((a, b) => a.similarity - b.similarity || a.createdAt.localeCompare(b.createdAt))
      .slice(0, 5),
  };
}

export async function createJsonStore({ dataPath, normalizeText, now }) {
  const database = databaseDefaults(JSON.parse(await readFile(dataPath, 'utf8')));
  const activeRounds = new Map();
  let writeQueue = Promise.resolve();
  let usageQueue = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify(database, null, 2);
    const operation = writeQueue.catch(() => undefined)
      .then(() => writeFile(dataPath, `${snapshot}\n`, 'utf8'));
    writeQueue = operation;
    return operation;
  }

  function withUsageLock(task) {
    const operation = usageQueue.then(task, task);
    usageQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return {
    kind: 'json',
    database,
    async getUsage() {
      return { ...database.usage };
    },
    async countOfflineExamples() {
      return database.offlineExamples.length;
    },
    async listPresets() {
      return database.presets.map((preset) => ({ ...preset }));
    },
    async addPreset(sentence) {
      if (database.presets.some((item) => normalizeText(item.text) === sentence.normalizedText)) {
        throw new StorageError('That sentence is already in the sentence bank.', 'DUPLICATE_SENTENCE');
      }
      const saved = { id: sentence.id, text: sentence.text, category: sentence.category };
      database.presets.unshift(saved);
      await persist();
      return saved;
    },
    async getLeaderboard() {
      return leaderboardFromPlays(database.plays);
    },
    async findOfflineExample(normalizedOriginal) {
      const match = database.offlineExamples
        .find((example) => normalizeText(example.original) === normalizedOriginal);
      return match ? { ...match } : null;
    },
    async canReserveUsage(characters, limits) {
      return database.usage.awsRequestsAttempted + 1 <= limits.maxTotalAwsRequests
        && database.usage.translatedCharactersSubmitted + characters <= limits.maxTotalTranslatedCharacters;
    },
    async reserveUsage(characters, limits) {
      return withUsageLock(async () => {
        const allowed = database.usage.awsRequestsAttempted + 1 <= limits.maxTotalAwsRequests
          && database.usage.translatedCharactersSubmitted + characters <= limits.maxTotalTranslatedCharacters;
        if (!allowed) return false;
        database.usage.awsRequestsAttempted += 1;
        database.usage.translatedCharactersSubmitted += characters;
        database.usage.updatedAt = now().toISOString();
        await persist();
        return true;
      });
    },
    async beginRound({ playerId, playerName, maxAttempts }) {
      if (activeRounds.has(playerId)) {
        throw new StorageError('A round is already active for this player.', 'ROUND_ALREADY_ACTIVE');
      }
      const completed = database.playerAttempts[playerId]?.completed || 0;
      if (completed >= maxAttempts) {
        throw new StorageError(`This player has used all ${maxAttempts} competitive attempts.`, 'PLAYER_ATTEMPT_LIMIT');
      }
      const token = randomUUID();
      activeRounds.set(playerId, token);
      return { token, completed, playerName };
    },
    async releaseRound({ playerId, token }) {
      if (activeRounds.get(playerId) === token) activeRounds.delete(playerId);
    },
    async completeRound({ playerId, playerName, token, play }) {
      if (activeRounds.get(playerId) !== token) {
        throw new StorageError('The player round lock expired. Please try again.', 'ROUND_LOCK_EXPIRED');
      }
      const completed = database.playerAttempts[playerId]?.completed || 0;
      database.plays.unshift(play);
      database.playerAttempts[playerId] = {
        playerName,
        completed: completed + 1,
        updatedAt: now().toISOString(),
      };
      activeRounds.delete(playerId);
      await persist();
    },
    async waitForWrites() {
      await Promise.all([writeQueue.catch(() => undefined), usageQueue]);
    },
    async close() {},
  };
}

function mapPlay(row) {
  return {
    id: row.id,
    playerName: row.player_name,
    mode: row.mode,
    original: row.original,
    finalArabic: row.final_arabic,
    similarity: row.similarity,
    createdAt: new Date(row.created_at).toISOString(),
    translationSource: row.translation_source,
    competitive: row.translation_source !== 'offline',
  };
}

async function transaction(pool, task) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await task(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresStore({ connectionString, pool: suppliedPool, roundLockTtlMs = 120_000 }) {
  const pool = suppliedPool || new Pool({ connectionString, max: 2 });

  return {
    kind: 'postgres',
    async getUsage() {
      const result = await pool.query(`
        SELECT aws_requests_attempted, translated_characters_submitted, updated_at
        FROM aws_usage WHERE id = 1
      `);
      const row = result.rows[0];
      if (!row) throw new StorageError('The database schema has not been initialized.', 'DATABASE_NOT_INITIALIZED');
      return {
        awsRequestsAttempted: Number(row.aws_requests_attempted),
        translatedCharactersSubmitted: Number(row.translated_characters_submitted),
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
      };
    },
    async countOfflineExamples() {
      const result = await pool.query('SELECT COUNT(*)::int AS count FROM offline_examples');
      return result.rows[0].count;
    },
    async listPresets() {
      const result = await pool.query(`
        SELECT id, text, category FROM sentence_presets
        ORDER BY sort_order ASC, id ASC
      `);
      return result.rows;
    },
    async addPreset(sentence) {
      try {
        const result = await pool.query(`
          INSERT INTO sentence_presets (id, text, normalized_text, category, sort_order)
          VALUES ($1, $2, $3, $4, COALESCE((SELECT MIN(sort_order) - 1 FROM sentence_presets), 0))
          RETURNING id, text, category
        `, [sentence.id, sentence.text, sentence.normalizedText, sentence.category]);
        return result.rows[0];
      } catch (error) {
        if (error?.code === '23505') {
          throw new StorageError('That sentence is already in the sentence bank.', 'DUPLICATE_SENTENCE');
        }
        throw error;
      }
    },
    async getLeaderboard() {
      const [guardians, glitchers] = await Promise.all([
        pool.query(`
          SELECT * FROM plays WHERE mode = 'guardian' AND translation_source <> 'offline'
          ORDER BY similarity DESC, created_at ASC LIMIT 5
        `),
        pool.query(`
          SELECT * FROM plays WHERE mode = 'glitcher' AND translation_source <> 'offline'
          ORDER BY similarity ASC, created_at ASC LIMIT 5
        `),
      ]);
      return { guardians: guardians.rows.map(mapPlay), glitchers: glitchers.rows.map(mapPlay) };
    },
    async findOfflineExample(normalizedOriginal) {
      const result = await pool.query(`
        SELECT id, original, final_arabic, similarity, recorded_at
        FROM offline_examples WHERE normalized_original = $1 LIMIT 1
      `, [normalizedOriginal]);
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        original: row.original,
        finalArabic: row.final_arabic,
        similarity: row.similarity,
        recordedAt: new Date(row.recorded_at).toISOString(),
      };
    },
    async canReserveUsage(characters, limits) {
      const usage = await this.getUsage();
      return usage.awsRequestsAttempted + 1 <= limits.maxTotalAwsRequests
        && usage.translatedCharactersSubmitted + characters <= limits.maxTotalTranslatedCharacters;
    },
    async reserveUsage(characters, limits) {
      return transaction(pool, async (client) => {
        const result = await client.query(`
          SELECT aws_requests_attempted, translated_characters_submitted
          FROM aws_usage WHERE id = 1 FOR UPDATE
        `);
        const row = result.rows[0];
        if (!row) throw new StorageError('The database schema has not been initialized.', 'DATABASE_NOT_INITIALIZED');
        const requests = Number(row.aws_requests_attempted);
        const submitted = Number(row.translated_characters_submitted);
        if (requests + 1 > limits.maxTotalAwsRequests
          || submitted + characters > limits.maxTotalTranslatedCharacters) return false;
        await client.query(`
          UPDATE aws_usage SET
            aws_requests_attempted = aws_requests_attempted + 1,
            translated_characters_submitted = translated_characters_submitted + $1,
            updated_at = NOW()
          WHERE id = 1
        `, [characters]);
        return true;
      });
    },
    async beginRound({ playerId, playerName, maxAttempts }) {
      return transaction(pool, async (client) => {
        await client.query(`
          INSERT INTO player_attempts (player_id, player_name)
          VALUES ($1, $2) ON CONFLICT (player_id) DO NOTHING
        `, [playerId, playerName]);
        const result = await client.query(`
          SELECT completed, active_round_token,
            (active_round_token IS NOT NULL AND active_round_expires_at > NOW()) AS round_active
          FROM player_attempts WHERE player_id = $1 FOR UPDATE
        `, [playerId]);
        const row = result.rows[0];
        if (Number(row.completed) >= maxAttempts) {
          throw new StorageError(`This player has used all ${maxAttempts} competitive attempts.`, 'PLAYER_ATTEMPT_LIMIT');
        }
        if (row.round_active) {
          throw new StorageError('A round is already active for this player.', 'ROUND_ALREADY_ACTIVE');
        }
        const token = randomUUID();
        await client.query(`
          UPDATE player_attempts SET player_name = $2, active_round_token = $3,
            active_round_expires_at = NOW() + ($4::double precision * INTERVAL '1 millisecond'), updated_at = NOW()
          WHERE player_id = $1
        `, [playerId, playerName, token, roundLockTtlMs]);
        return { token, completed: Number(row.completed), playerName };
      });
    },
    async releaseRound({ playerId, token }) {
      await pool.query(`
        UPDATE player_attempts SET active_round_token = NULL, active_round_expires_at = NULL, updated_at = NOW()
        WHERE player_id = $1 AND active_round_token = $2
      `, [playerId, token]);
    },
    async completeRound({ playerId, playerName, token, play }) {
      await transaction(pool, async (client) => {
        const lock = await client.query(`
          SELECT active_round_token FROM player_attempts WHERE player_id = $1 FOR UPDATE
        `, [playerId]);
        if (lock.rows[0]?.active_round_token !== token) {
          throw new StorageError('The player round lock expired. Please try again.', 'ROUND_LOCK_EXPIRED');
        }
        await client.query(`
          INSERT INTO plays
            (id, player_name, mode, original, final_arabic, similarity, created_at, translation_source)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [play.id, play.playerName, play.mode, play.original, play.finalArabic,
          play.similarity, play.createdAt, play.translationSource]);
        await client.query(`
          UPDATE player_attempts SET player_name = $2, completed = completed + 1,
            active_round_token = NULL, active_round_expires_at = NULL, updated_at = NOW()
          WHERE player_id = $1
        `, [playerId, playerName]);
      });
    },
    async waitForWrites() {},
    async close() {
      if (!suppliedPool) await pool.end();
    },
  };
}
