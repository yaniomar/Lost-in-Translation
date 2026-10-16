import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBoothApp, loadConfig, normalizePlayerId, similarityPercent, translationStages } from './app.js';
import { AwsIdentityError, createAwsIdentityGuard } from './aws-identity.js';

const recordedOriginal = 'نزلت علامات المد والدكتور حكالي راجعني';
const devfestAccountId = '530702499288';
const baseDatabase = {
  presets: [{ id: 'preset-1', text: recordedOriginal, category: 'أكاديمي' }],
  offlineExamples: [{
    id: 'recorded-1',
    original: recordedOriginal,
    finalArabic: 'ظهرت العلامات وعاد الدكتور إليّ',
    similarity: 40,
    recordedAt: '2026-10-15T21:59:03.564Z',
  }],
  usage: { awsRequestsAttempted: 0, translatedCharactersSubmitted: 0 },
  playerAttempts: {},
  plays: [],
};

function config(overrides = {}) {
  return {
    ...loadConfig({
      OFFLINE_MODE: 'disabled',
      DEVFEST_AWS_ACCOUNT_ID: devfestAccountId,
      MAX_TOTAL_AWS_REQUESTS: '3000',
      MAX_TOTAL_TRANSLATED_CHARACTERS: '300000',
      MAX_ATTEMPTS_PER_PLAYER: '3',
      API_RATE_LIMIT_MAX: '1000',
      SENTENCE_BANK_RATE_LIMIT_MAX: '20',
    }),
    ...overrides,
  };
}

async function withServer(t, { database = baseDatabase, appOptions = {} } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lost-in-translation-'));
  const dataPath = path.join(directory, 'database.json');
  await writeFile(dataPath, JSON.stringify(database), 'utf8');
  const booth = await createBoothApp({
    dataPath,
    verifyAwsIdentity: async () => ({ account: devfestAccountId, credentials: {} }),
    ...appOptions,
  });
  const server = booth.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  t.after(async () => {
    server.close();
    await once(server, 'close');
    await booth.waitForWrites();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...booth, dataPath, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function postPlay(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/api/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('preserves scoring and the five-stage language route', async (t) => {
  const calls = [];
  const { baseUrl } = await withServer(t, {
    appOptions: {
      config: config(),
      translateStage: async (call) => {
        calls.push(call);
        return call.text;
      },
    },
  });
  const response = await postPlay(baseUrl, { mode: 'guardian', sentence: 'مرحبا', playerName: 'Route Test' });
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.play.similarity, 100);
  assert.deepEqual(calls.map(({ sourceLanguage, targetLanguage }) => [sourceLanguage, targetLanguage]),
    translationStages.map(({ source, target }) => [source, target]));
  assert.equal(similarityPercent('نَصّ', 'نص'), 100);
});

test('blocks an incorrect AWS account before quota reservation or TranslateText', async (t) => {
  let translateCalls = 0;
  const { baseUrl, database } = await withServer(t, {
    appOptions: {
      config: config(),
      verifyAwsIdentity: async () => ({ account: '968234051239', credentials: {} }),
      translateStage: async ({ text }) => { translateCalls += 1; return text; },
    },
  });
  const response = await postPlay(baseUrl, { mode: 'guardian', sentence: 'مرحبا', playerName: 'Account Guard' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'AWS_ACCOUNT_MISMATCH');
  assert.equal(translateCalls, 0);
  assert.equal(database.usage.awsRequestsAttempted, 0);
});

test('refuses startup when the configured account is not the DEVFEST account', () => {
  assert.throws(
    () => loadConfig({ DEVFEST_AWS_ACCOUNT_ID: '968234051239' }),
    /must be the authorized DEVFEST account/,
  );
});

test('blocks missing AWS credentials before quota reservation or TranslateText', async (t) => {
  let translateCalls = 0;
  const { baseUrl, database } = await withServer(t, {
    appOptions: {
      config: config(),
      verifyAwsIdentity: async () => {
        throw new AwsIdentityError('No explicit DEVFEST AWS credential source is configured.', 'AWS_CREDENTIAL_SOURCE_REQUIRED');
      },
      translateStage: async ({ text }) => { translateCalls += 1; return text; },
    },
  });
  const response = await postPlay(baseUrl, { mode: 'guardian', sentence: 'مرحبا', playerName: 'Credential Guard' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'AWS_CREDENTIAL_SOURCE_REQUIRED');
  assert.equal(translateCalls, 0);
  assert.equal(database.usage.awsRequestsAttempted, 0);
});

test('never falls back to the default AWS profile when no explicit source is configured', async () => {
  let stsCalls = 0;
  const guard = createAwsIdentityGuard(config(), {
    env: {},
    stsClientFactory: () => ({
      async send() { stsCalls += 1; return { Account: devfestAccountId }; },
      destroy() {},
    }),
  });
  await assert.rejects(guard, (error) => error.code === 'AWS_CREDENTIAL_SOURCE_REQUIRED');
  assert.equal(stsCalls, 0);
});

test('returns a clear error when the named profile cannot be loaded', async () => {
  let stsCalls = 0;
  const guard = createAwsIdentityGuard(config(), {
    env: { AWS_PROFILE: 'devfest-translate' },
    credentialProviderFactory: () => async () => { throw new Error('private provider detail'); },
    stsClientFactory: () => ({
      async send() { stsCalls += 1; return { Account: devfestAccountId }; },
      destroy() {},
    }),
  });
  await assert.rejects(guard, (error) => error.code === 'AWS_PROFILE_UNAVAILABLE'
    && !error.message.includes('private provider detail'));
  assert.equal(stsCalls, 0);
});

test('caches only the same verified credential identity and rechecks changed credentials', async () => {
  let accessKeyId = 'DEVFESTKEYONE';
  let stsCalls = 0;
  const guard = createAwsIdentityGuard(config(), {
    env: { AWS_PROFILE: 'devfest-translate' },
    credentialProviderFactory: () => async () => ({ accessKeyId, secretAccessKey: 'not-logged' }),
    stsClientFactory: () => ({
      async send() { stsCalls += 1; return { Account: devfestAccountId }; },
      destroy() {},
    }),
  });
  assert.equal((await guard()).account, devfestAccountId);
  assert.equal((await guard()).account, devfestAccountId);
  assert.equal(stsCalls, 1);
  accessKeyId = 'DEVFESTKEYTWO';
  assert.equal((await guard()).account, devfestAccountId);
  assert.equal(stsCalls, 2);
});

test('enforces quota before a call and never exceeds the cap', async (t) => {
  let calls = 0;
  const { baseUrl, database } = await withServer(t, {
    appOptions: {
      config: config({ maxTotalAwsRequests: 0 }),
      translateStage: async ({ text }) => { calls += 1; return text; },
    },
  });
  const response = await postPlay(baseUrl, { mode: 'guardian', sentence: 'مرحبا', playerName: 'Quota Test' });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'AWS_QUOTA_EXHAUSTED');
  assert.equal(calls, 0);
  assert.equal(database.usage.awsRequestsAttempted, 0);
});

test('enforces the total translated-character quota before a call', async (t) => {
  let calls = 0;
  const { baseUrl, database } = await withServer(t, {
    appOptions: {
      config: config({ maxTotalTranslatedCharacters: 4 }),
      translateStage: async ({ text }) => { calls += 1; return text; },
    },
  });
  const response = await postPlay(baseUrl, { mode: 'guardian', sentence: 'مرحبا', playerName: 'Character Quota' });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'AWS_QUOTA_EXHAUSTED');
  assert.equal(calls, 0);
  assert.equal(database.usage.translatedCharactersSubmitted, 0);
});

test('serializes concurrent quota reservations', async (t) => {
  let releaseFirst;
  const firstCallBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const { baseUrl, database } = await withServer(t, {
    appOptions: {
      config: config({ maxTotalAwsRequests: 1 }),
      translateStage: async ({ text }) => {
        calls += 1;
        if (calls === 1) await firstCallBlocked;
        return text;
      },
    },
  });
  const first = postPlay(baseUrl, { mode: 'guardian', sentence: 'أول', playerName: 'One' });
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = postPlay(baseUrl, { mode: 'guardian', sentence: 'ثاني', playerName: 'Two' });
  const secondResponse = await second;
  releaseFirst();
  const firstResponse = await first;
  assert.equal(secondResponse.status, 429);
  assert.equal(firstResponse.status, 429);
  assert.equal(database.usage.awsRequestsAttempted, 1);
  assert.equal(calls, 1);
});

test('tracks attempted calls and characters when a pipeline partially fails', async (t) => {
  let calls = 0;
  const { baseUrl, dataPath } = await withServer(t, {
    appOptions: {
      config: config(),
      translateStage: async () => {
        calls += 1;
        if (calls === 1) return '一';
        const error = new Error('private upstream detail');
        error.name = 'ThrottlingException';
        throw error;
      },
    },
  });
  const response = await postPlay(baseUrl, { mode: 'guardian', sentence: 'مرحبا', playerName: 'Partial Test' });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.code, 'AWS_THROTTLED');
  assert.doesNotMatch(payload.error, /private upstream detail/);
  const persisted = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.equal(persisted.usage.awsRequestsAttempted, 2);
  assert.equal(persisted.usage.translatedCharactersSubmitted, 6);
  const restarted = await createBoothApp({
    dataPath,
    config: config(),
    translateStage: async ({ text }) => text,
  });
  assert.equal((await restarted.usageSummary()).awsRequestsAttempted, 2);
  assert.equal((await restarted.usageSummary()).translatedCharactersSubmitted, 6);
});

test('limits completed attempts by normalized player name', async (t) => {
  const { baseUrl, database } = await withServer(t, {
    appOptions: {
      config: config({ maxAttemptsPerPlayer: 1 }),
      translateStage: async ({ text }) => text,
    },
  });
  const first = await postPlay(baseUrl, { mode: 'guardian', sentence: 'مرحبا', playerName: '  Alice  ' });
  const second = await postPlay(baseUrl, { mode: 'glitcher', sentence: 'مرحبا', playerName: 'alice' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).code, 'PLAYER_ATTEMPT_LIMIT');
  assert.equal(database.playerAttempts[normalizePlayerId('Alice')].completed, 1);
});

test('rejects a repeated submission while the same player round is active', async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { baseUrl } = await withServer(t, {
    appOptions: {
      config: config(),
      translateStage: async ({ text }) => {
        calls += 1;
        if (calls === 1) await blocked;
        return text;
      },
    },
  });
  const first = postPlay(baseUrl, { mode: 'guardian', sentence: 'مرحبا', playerName: 'Same Player' });
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await postPlay(baseUrl, { mode: 'guardian', sentence: 'مرحبا', playerName: ' same   player ' });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'ROUND_ALREADY_ACTIVE');
  release();
  assert.equal((await first).status, 201);
});

test('offline mode replays only a recorded example without quota, attempts, or leaderboard writes', async (t) => {
  let calls = 0;
  let identityChecks = 0;
  const { baseUrl, database } = await withServer(t, {
    appOptions: {
      config: config({ offlineMode: 'always' }),
      verifyAwsIdentity: async () => { identityChecks += 1; throw new Error('offline must not verify AWS'); },
      translateStage: async ({ text }) => { calls += 1; return text; },
    },
  });
  const response = await postPlay(baseUrl, { mode: 'guardian', sentence: recordedOriginal, playerName: 'Offline Player' });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.offline.active, true);
  assert.equal(payload.play.translationSource, 'offline');
  assert.equal(payload.play.competitive, false);
  assert.equal(calls, 0);
  assert.equal(identityChecks, 0);
  assert.equal(database.usage.awsRequestsAttempted, 0);
  assert.equal(database.plays.length, 0);
  assert.deepEqual(database.playerAttempts, {});

  const missing = await postPlay(baseUrl, { mode: 'guardian', sentence: 'مثال غير مسجل', playerName: 'Offline Player' });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'OFFLINE_EXAMPLE_NOT_FOUND');
});

test('restricts origins, throttles APIs, and returns safe parser errors', async (t) => {
  const { baseUrl } = await withServer(t, {
    appOptions: {
      config: config({ apiRateLimitMax: 1 }),
      translateStage: async ({ text }) => text,
    },
  });
  const forbidden = await fetch(`${baseUrl}/api/presets`, { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, 'ORIGIN_NOT_ALLOWED');

  const malformed = await fetch(`${baseUrl}/api/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Invalid JSON request body.', code: 'INVALID_JSON' });

  const allowed = await fetch(`${baseUrl}/api/status`);
  assert.equal(allowed.status, 200);
  const limited = await fetch(`${baseUrl}/api/presets`);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, 'API_RATE_LIMITED');
});

test('protects sentence-bank mutation with validation, duplicate checks, and its own throttle', async (t) => {
  const { baseUrl } = await withServer(t, {
    appOptions: {
      config: config({ sentenceRateLimitMax: 2 }),
      translateStage: async ({ text }) => text,
    },
  });
  const english = await fetch(`${baseUrl}/api/log-sentence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'English only', category: 'Team' }),
  });
  assert.equal(english.status, 400);
  assert.equal((await english.json()).code, 'ARABIC_REQUIRED');

  const duplicate = await fetch(`${baseUrl}/api/log-sentence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: recordedOriginal, category: 'Team' }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'DUPLICATE_SENTENCE');

  const throttled = await fetch(`${baseUrl}/api/log-sentence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'جملة عربية جديدة', category: 'Team' }),
  });
  assert.equal(throttled.status, 429);
  assert.equal((await throttled.json()).code, 'SENTENCE_BANK_RATE_LIMITED');
});
