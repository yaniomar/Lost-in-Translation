import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './app.js';
import { createPostgresStore } from './storage.js';

function quotaPool(initialUsage = { requests: 0, characters: 0 }) {
  const state = { ...initialUsage };
  const statements = [];
  let gate = Promise.resolve();

  return {
    state,
    statements,
    async connect() {
      let unlock;
      const prior = gate;
      gate = new Promise((resolve) => { unlock = resolve; });
      await prior;
      return {
        async query(sql, parameters = []) {
          const compact = sql.replace(/\s+/g, ' ').trim();
          statements.push(compact);
          if (compact === 'BEGIN') return { rows: [] };
          if (compact === 'COMMIT' || compact === 'ROLLBACK') {
            unlock();
            return { rows: [] };
          }
          if (compact.includes('FROM aws_usage WHERE id = 1 FOR UPDATE')) {
            return {
              rows: [{
                aws_requests_attempted: state.requests,
                translated_characters_submitted: state.characters,
              }],
            };
          }
          if (compact.startsWith('UPDATE aws_usage SET')) {
            state.requests += 1;
            state.characters += parameters[0];
            return { rows: [] };
          }
          throw new Error(`Unexpected test query: ${compact}`);
        },
        release() {},
      };
    },
    async query() {
      throw new Error('Unexpected non-transactional test query.');
    },
  };
}

function roundPool() {
  const state = { player: null, plays: [] };
  let gate = Promise.resolve();

  async function runQuery(sql, parameters = []) {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact === 'BEGIN' || compact === 'COMMIT' || compact === 'ROLLBACK') return { rows: [] };
    if (compact.startsWith('INSERT INTO player_attempts')) {
      state.player ||= { playerId: parameters[0], playerName: parameters[1], completed: 0, token: null };
      return { rows: [] };
    }
    if (compact.includes('SELECT completed, active_round_token')) {
      return { rows: [{
        completed: state.player.completed,
        active_round_token: state.player.token,
        round_active: Boolean(state.player.token),
      }] };
    }
    if (compact.startsWith('UPDATE player_attempts SET player_name') && compact.includes('active_round_token = $3')) {
      state.player.playerName = parameters[1];
      state.player.token = parameters[2];
      return { rows: [] };
    }
    if (compact.startsWith('SELECT active_round_token')) {
      return { rows: [{ active_round_token: state.player.token }] };
    }
    if (compact.startsWith('INSERT INTO plays')) {
      state.plays.push(parameters[0]);
      return { rows: [] };
    }
    if (compact.startsWith('UPDATE player_attempts SET player_name') && compact.includes('completed = completed + 1')) {
      state.player.completed += 1;
      state.player.token = null;
      return { rows: [] };
    }
    if (compact.startsWith('UPDATE player_attempts SET active_round_token = NULL')) {
      if (state.player?.token === parameters[1]) state.player.token = null;
      return { rows: [] };
    }
    throw new Error(`Unexpected test query: ${compact}`);
  }

  return {
    state,
    async connect() {
      let unlock;
      const prior = gate;
      gate = new Promise((resolve) => { unlock = resolve; });
      await prior;
      return {
        query: runQuery,
        release() { unlock(); },
      };
    },
    query: runQuery,
  };
}

test('PostgreSQL quota reservations serialize and cannot exceed the configured cap', async () => {
  const pool = quotaPool();
  const store = createPostgresStore({ connectionString: 'postgresql://test', pool });
  const limits = { maxTotalAwsRequests: 1, maxTotalTranslatedCharacters: 20 };

  const results = await Promise.all([
    store.reserveUsage(6, limits),
    store.reserveUsage(6, limits),
  ]);

  assert.deepEqual(results.sort(), [false, true]);
  assert.deepEqual(pool.state, { requests: 1, characters: 6 });
  assert.equal(pool.statements.filter((statement) => statement === 'BEGIN').length, 2);
  assert.equal(pool.statements.filter((statement) => statement.includes('FOR UPDATE')).length, 2);
  assert.equal(pool.statements.filter((statement) => statement === 'COMMIT').length, 2);
});

test('PostgreSQL player locks reject simultaneous rounds and complete one attempt atomically', async () => {
  const pool = roundPool();
  const store = createPostgresStore({ connectionString: 'postgresql://test', pool });
  const request = { playerId: 'player:alice', playerName: 'Alice', maxAttempts: 3 };
  const attempts = await Promise.allSettled([store.beginRound(request), store.beginRound(request)]);
  const fulfilled = attempts.find((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.find((attempt) => attempt.status === 'rejected');

  assert.ok(fulfilled);
  assert.equal(rejected.reason.code, 'ROUND_ALREADY_ACTIVE');

  await store.completeRound({
    playerId: request.playerId,
    playerName: request.playerName,
    token: fulfilled.value.token,
    play: {
      id: 'play-1', playerName: 'Alice', mode: 'guardian', original: 'أهلا',
      finalArabic: 'أهلا', similarity: 100, createdAt: new Date().toISOString(), translationSource: 'aws',
    },
  });

  assert.equal(pool.state.player.completed, 1);
  assert.equal(pool.state.player.token, null);
  assert.deepEqual(pool.state.plays, ['play-1']);
});

test('Vercel refuses the local JSON fallback when DATABASE_URL is missing', () => {
  assert.throws(() => loadConfig({
    VERCEL: '1',
    DEVFEST_AWS_ACCOUNT_ID: '530702499288',
  }), /DATABASE_URL is required on Vercel/);
});

test('Vercel accepts an explicitly configured server-side database URL', () => {
  const config = loadConfig({
    VERCEL: '1',
    DEVFEST_AWS_ACCOUNT_ID: '530702499288',
    DATABASE_URL: 'postgresql://example.invalid/devfest',
  });
  assert.equal(config.databaseUrl, 'postgresql://example.invalid/devfest');
});
