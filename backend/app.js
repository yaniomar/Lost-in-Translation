import cors from 'cors';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AwsIdentityError, createAwsIdentityGuard, createAwsTranslator } from './aws-identity.js';
import { createJsonStore, createPostgresStore, StorageError } from './storage.js';

export const translationStages = [
  { key: 'japanese', language: 'Japanese', flag: '🇯🇵', source: 'ar', target: 'ja' },
  { key: 'russian', language: 'Russian', flag: '🇷🇺', source: 'ja', target: 'ru' },
  { key: 'french', language: 'French', flag: '🇫🇷', source: 'ru', target: 'fr' },
  { key: 'english', language: 'English', flag: '🇬🇧', source: 'fr', target: 'en' },
  { key: 'arabic', language: 'Arabic', flag: '🇵🇸', source: 'en', target: 'ar' },
];

const defaultDataPath = fileURLToPath(new URL('./sentences_log.json', import.meta.url));
const validOfflineModes = new Set(['auto', 'always', 'disabled']);
const authorizedDevfestAwsAccountId = '530702499288';

class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', allowOffline = false } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.allowOffline = allowOffline;
  }
}

function integerSetting(env, name, fallback, { minimum = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return parsed;
}

function vercelHostnames(env) {
  return [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
    .map((hostname) => (hostname || '').trim().toLowerCase())
    .filter((hostname) => hostname && !hostname.includes('/') && !hostname.includes(':'));
}

export function loadConfig(env = process.env) {
  const offlineMode = (env.OFFLINE_MODE || 'auto').trim().toLowerCase();
  const devfestAwsAccountId = (env.DEVFEST_AWS_ACCOUNT_ID || '').trim();
  if (!validOfflineModes.has(offlineMode)) {
    throw new Error('OFFLINE_MODE must be auto, always, or disabled.');
  }
  if (!/^\d{12}$/.test(devfestAwsAccountId)) {
    throw new Error('DEVFEST_AWS_ACCOUNT_ID is required and must be a 12-digit AWS account ID.');
  }
  if (devfestAwsAccountId !== authorizedDevfestAwsAccountId) {
    throw new Error(`DEVFEST_AWS_ACCOUNT_ID must be the authorized DEVFEST account ${authorizedDevfestAwsAccountId}.`);
  }
  const databaseUrl = (env.DATABASE_URL || '').trim();
  if (env.VERCEL && !databaseUrl) {
    throw new Error('DATABASE_URL is required on Vercel. Local JSON persistence is not allowed in production.');
  }

  return {
    port: integerSetting(env, 'PORT', 5000, { minimum: 1 }),
    host: (env.HOST || '127.0.0.1').trim(),
    region: (env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1').trim(),
    devfestAwsAccountId,
    maxTotalAwsRequests: integerSetting(env, 'MAX_TOTAL_AWS_REQUESTS', 3000),
    maxTotalTranslatedCharacters: integerSetting(env, 'MAX_TOTAL_TRANSLATED_CHARACTERS', 300000),
    maxAttemptsPerPlayer: integerSetting(env, 'MAX_ATTEMPTS_PER_PLAYER', 3, { minimum: 1 }),
    awsRequestTimeoutMs: integerSetting(env, 'AWS_REQUEST_TIMEOUT_MS', 8000, { minimum: 100 }),
    apiRateLimitWindowMs: integerSetting(env, 'API_RATE_LIMIT_WINDOW_MS', 60000, { minimum: 1000 }),
    apiRateLimitMax: integerSetting(env, 'API_RATE_LIMIT_MAX', 120, { minimum: 1 }),
    sentenceRateLimitWindowMs: integerSetting(env, 'SENTENCE_BANK_RATE_LIMIT_WINDOW_MS', 3600000, { minimum: 1000 }),
    sentenceRateLimitMax: integerSetting(env, 'SENTENCE_BANK_RATE_LIMIT_MAX', 20, { minimum: 1 }),
    allowedOrigins: (env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    isVercel: env.VERCEL === '1',
    vercelHostnames: vercelHostnames(env),
    offlineMode,
    databaseUrl,
  };
}

function characterCount(value) {
  return Array.from(value).length;
}

export function normalizedText(value) {
  return value.normalize('NFC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/\s+/g, ' ').trim();
}

export function normalizePlayerId(value) {
  const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
  return `player:${normalized}`;
}

function levenshteinDistance(left, right) {
  const first = Array.from(normalizedText(left));
  const second = Array.from(normalizedText(right));
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);

  for (let row = 1; row <= first.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= second.length; column += 1) {
      const substitutionCost = first[row - 1] === second[column - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + substitutionCost,
      );
    }
    previous = current;
  }

  return previous[second.length];
}

export function similarityPercent(original, finalArabic) {
  const source = Array.from(normalizedText(original));
  const result = Array.from(normalizedText(finalArabic));
  const longest = Math.max(source.length, result.length);
  if (!longest) return 100;
  return Math.round((1 - levenshteinDistance(original, finalArabic) / longest) * 100);
}

function makeRateLimiter({ max, windowMs, code }) {
  const buckets = new Map();
  return (request, response, next) => {
    const now = Date.now();
    const key = request.ip || request.socket.remoteAddress || 'local';
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > max) {
      response.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return response.status(429).json({ error: 'Too many requests. Please wait and try again.', code });
    }
    return next();
  };
}

function awsTranslationError(cause) {
  const messages = {
    AccessDeniedException: ['AWS denied the Translate request. Check that the active identity allows translate:TranslateText.', 'AWS_ACCESS_DENIED', 503],
    UnrecognizedClientException: ['AWS rejected the configured credentials.', 'AWS_CREDENTIALS_REJECTED', 503],
    InvalidSignatureException: ['AWS rejected the configured credentials.', 'AWS_CREDENTIALS_REJECTED', 503],
    ExpiredTokenException: ['The AWS session credentials have expired.', 'AWS_CREDENTIALS_EXPIRED', 503],
    CredentialsProviderError: ['No usable AWS credentials were found.', 'AWS_CREDENTIALS_MISSING', 503],
    ResourceNotFoundException: ['Amazon Translate is unavailable in the configured region.', 'AWS_REGION_UNAVAILABLE', 502],
    UnsupportedLanguagePairException: ['Amazon Translate does not support one of the configured language pairs.', 'AWS_LANGUAGE_PAIR_UNSUPPORTED', 502],
    ThrottlingException: ['Amazon Translate throttled the request. Please try again shortly.', 'AWS_THROTTLED', 503],
    AbortError: ['The Amazon Translate request timed out.', 'AWS_TIMEOUT', 504],
  };
  const [message, code, statusCode] = messages[cause?.name] || [
    'Amazon Translate could not complete the translation.',
    'AWS_TRANSLATION_FAILED',
    502,
  ];
  return new AppError(message, { statusCode, code, allowOffline: true });
}

export async function createBoothApp(options = {}) {
  const config = options.config || loadConfig(options.env);
  const dataPath = options.dataPath || defaultDataPath;
  const store = options.store || (config.databaseUrl
    ? createPostgresStore({ connectionString: config.databaseUrl })
    : await createJsonStore({ dataPath, normalizeText: normalizedText, now: options.now || (() => new Date()) }));
  const database = store.database;
  const verifyAwsIdentity = options.verifyAwsIdentity
    || createAwsIdentityGuard(config, { env: options.env || process.env });
  const translateStageOverride = options.translateStage;
  const translatorFactory = options.translatorFactory || ((credentials) => createAwsTranslator(config, credentials));
  const now = options.now || (() => new Date());

  const quotaLimits = {
    maxTotalAwsRequests: config.maxTotalAwsRequests,
    maxTotalTranslatedCharacters: config.maxTotalTranslatedCharacters,
  };

  async function reserveAwsUsage(text) {
    const characters = characterCount(text);
    if (!await store.reserveUsage(characters, quotaLimits)) {
      throw new AppError('The booth Amazon Translate quota is exhausted. Use a prerecorded offline example or ask an organizer.', {
        statusCode: 429,
        code: 'AWS_QUOTA_EXHAUSTED',
        allowOffline: true,
      });
    }
    return { characters };
  }

  async function hasQuotaFor(text) {
    return store.canReserveUsage(characterCount(text), quotaLimits);
  }

  async function translateText(text, sourceLanguage, targetLanguage, translateStage) {
    await reserveAwsUsage(text);
    try {
      return await translateStage({ text, sourceLanguage, targetLanguage });
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw awsTranslationError(cause);
    }
  }

  async function createPipeline(original, translateStage) {
    const steps = [];
    let text = original;
    for (const stage of translationStages) {
      try {
        text = await translateText(text, stage.source, stage.target, translateStage);
      } catch (error) {
        error.completedStages = steps.length;
        throw error;
      }
      steps.push({ key: stage.key, language: stage.language, flag: stage.flag, text });
    }
    return { finalArabic: text, steps };
  }

  async function getLeaderboard() {
    return store.getLeaderboard();
  }

  async function findOfflineExample(original) {
    const match = await store.findOfflineExample(normalizedText(original));
    if (!match) return null;
    return {
      id: `offline-${match.id}`,
      original: match.original,
      finalArabic: match.finalArabic,
      similarity: Number.isFinite(match.similarity) ? match.similarity : similarityPercent(match.original, match.finalArabic),
      recordedAt: match.recordedAt,
    };
  }

  async function offlineResponse({ example, mode, playerName }) {
    return {
      play: {
        ...example,
        playerName,
        mode,
        createdAt: now().toISOString(),
        translationSource: 'offline',
        competitive: false,
      },
      steps: [],
      leaderboard: await getLeaderboard(),
      offline: {
        active: true,
        label: 'Prerecorded offline demonstration',
        message: 'This saved example did not call AWS and was not added to the competitive leaderboard.',
      },
    };
  }

  async function usageSummary() {
    const usage = await store.getUsage();
    return {
      awsRequestsAttempted: usage.awsRequestsAttempted,
      translatedCharactersSubmitted: usage.translatedCharactersSubmitted,
      remainingAwsRequests: Math.max(0, config.maxTotalAwsRequests - usage.awsRequestsAttempted),
      remainingTranslatedCharacters: Math.max(0,
        config.maxTotalTranslatedCharacters - usage.translatedCharactersSubmitted),
    };
  }

  const app = express();
  app.disable('x-powered-by');
  const allowedOrigins = new Set(config.allowedOrigins);
  const allowedVercelHostnames = new Set(config.vercelHostnames || []);
  function isOriginAllowed(request, origin = request.get('Origin')) {
    if (!origin || allowedOrigins.has(origin)) return true;
    if (!allowedVercelHostnames.size && !config.isVercel) return false;

    try {
      const originUrl = new URL(origin);
      const requestHost = (request.get('Host') || '').toLowerCase();
      const isSameOrigin = originUrl.protocol === 'https:'
        && !originUrl.port
        && originUrl.host.toLowerCase() === requestHost;
      const originHostname = originUrl.hostname.toLowerCase();
      return isSameOrigin && (allowedVercelHostnames.has(originHostname)
        || (config.isVercel && originHostname.endsWith('.vercel.app')));
    } catch {
      return false;
    }
  }
  app.use('/api', (request, response, next) => {
    const origin = request.get('Origin');
    if (!isOriginAllowed(request, origin)) {
      return response.status(403).json({ error: 'This origin is not allowed.', code: 'ORIGIN_NOT_ALLOWED' });
    }
    return next();
  });
  app.use(cors((request, callback) => callback(null, {
    origin: isOriginAllowed(request),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    maxAge: 600,
  })));
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use('/api', makeRateLimiter({
    max: config.apiRateLimitMax,
    windowMs: config.apiRateLimitWindowMs,
    code: 'API_RATE_LIMITED',
  }));

  app.get('/api/status', async (_request, response, next) => {
    try {
      response.json({
        region: config.region,
        offlineMode: config.offlineMode,
        storage: store.kind,
        limits: {
          maxTotalAwsRequests: config.maxTotalAwsRequests,
          maxTotalTranslatedCharacters: config.maxTotalTranslatedCharacters,
          maxAttemptsPerPlayer: config.maxAttemptsPerPlayer,
        },
        usage: await usageSummary(),
        offlineExamples: await store.countOfflineExamples(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/presets', async (_request, response, next) => {
    try {
      response.json(await store.listPresets());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/log-sentence', makeRateLimiter({
    max: config.sentenceRateLimitMax,
    windowMs: config.sentenceRateLimitWindowMs,
    code: 'SENTENCE_BANK_RATE_LIMITED',
  }), async (request, response, next) => {
    try {
      const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
      const category = typeof request.body?.category === 'string' ? request.body.category.trim().slice(0, 24) : 'Team';
      if (!text || characterCount(text) > 150) {
        throw new AppError('Enter a sentence of up to 150 characters.', { statusCode: 400, code: 'INVALID_SENTENCE' });
      }
      if (!/[\u0600-\u06ff]/u.test(text)) {
        throw new AppError('Sentence-bank entries must contain Arabic text.', { statusCode: 400, code: 'ARABIC_REQUIRED' });
      }
      const sentence = await store.addPreset({
        id: randomUUID(),
        text,
        normalizedText: normalizedText(text),
        category: category || 'Team',
      });
      return response.status(201).json(sentence);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/leaderboard', async (_request, response, next) => {
    try {
      response.json(await getLeaderboard());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/play', async (request, response, next) => {
    const mode = request.body?.mode;
    const original = typeof request.body?.sentence === 'string' ? request.body.sentence.trim() : '';
    const rawPlayerName = typeof request.body?.playerName === 'string' ? request.body.playerName.trim() : '';
    const playerName = rawPlayerName.slice(0, 30);
    const playerId = normalizePlayerId(playerName);
    let round;

    try {
      if (!['guardian', 'glitcher'].includes(mode)) {
        throw new AppError('Choose a game mode first.', { statusCode: 400, code: 'INVALID_MODE' });
      }
      if (!original || characterCount(original) > 150) {
        throw new AppError('Enter a sentence between 1 and 150 characters.', { statusCode: 400, code: 'INVALID_SENTENCE' });
      }
      if (!playerName) {
        throw new AppError('Enter a player name.', { statusCode: 400, code: 'PLAYER_NAME_REQUIRED' });
      }
      if (characterCount(rawPlayerName) > 30) {
        throw new AppError('Player names must be 30 characters or fewer.', { statusCode: 400, code: 'PLAYER_NAME_TOO_LONG' });
      }
      if (/[\u0000-\u001f\u007f]/u.test(rawPlayerName)) {
        throw new AppError('Player names cannot contain control characters.', { statusCode: 400, code: 'INVALID_PLAYER_NAME' });
      }
      round = await store.beginRound({
        playerId,
        playerName,
        maxAttempts: config.maxAttemptsPerPlayer,
      });

      const offlineExample = await findOfflineExample(original);
      if (config.offlineMode === 'always') {
        if (!offlineExample) {
          throw new AppError('No prerecorded offline demonstration matches this sentence. Choose a supported sentence from the sentence bank.', {
            statusCode: 404,
            code: 'OFFLINE_EXAMPLE_NOT_FOUND',
          });
        }
        return response.status(200).json(await offlineResponse({ example: offlineExample, mode, playerName }));
      }
      if (config.offlineMode === 'auto' && !await hasQuotaFor(original) && offlineExample) {
        return response.status(200).json(await offlineResponse({ example: offlineExample, mode, playerName }));
      }

      let pipeline;
      let translator;
      try {
        const identity = await verifyAwsIdentity();
        if (identity?.account !== config.devfestAwsAccountId) {
          throw new AwsIdentityError(
            'The authenticated AWS identity is not authorized for this DEVFEST project.',
            'AWS_ACCOUNT_MISMATCH',
          );
        }
        translator = translateStageOverride
          ? { translate: translateStageOverride, destroy() {} }
          : translatorFactory(identity.credentials);
        pipeline = await createPipeline(original, translator.translate.bind(translator));
      } catch (error) {
        if (config.offlineMode === 'auto'
          && error?.code === 'AWS_QUOTA_EXHAUSTED'
          && error.completedStages === 0
          && offlineExample) {
          return response.status(200).json(await offlineResponse({ example: offlineExample, mode, playerName }));
        }
        throw error;
      } finally {
        translator?.destroy();
      }

      const play = {
        id: randomUUID(),
        playerName,
        mode,
        original,
        finalArabic: pipeline.finalArabic,
        similarity: similarityPercent(original, pipeline.finalArabic),
        createdAt: now().toISOString(),
        translationSource: 'aws',
        competitive: true,
      };
      await store.completeRound({
        playerId,
        playerName,
        token: round.token,
        play,
      });
      return response.status(201).json({
        play,
        steps: pipeline.steps,
        leaderboard: await getLeaderboard(),
        offline: { active: false },
      });
    } catch (error) {
      return next(error);
    } finally {
      if (round) await store.releaseRound({ playerId, token: round.token }).catch(() => undefined);
    }
  });

  app.use((error, _request, response, _next) => {
    if (error?.type === 'entity.parse.failed') {
      return response.status(400).json({ error: 'Invalid JSON request body.', code: 'INVALID_JSON' });
    }
    if (error?.type === 'entity.too.large') {
      return response.status(413).json({ error: 'Request body is too large.', code: 'REQUEST_TOO_LARGE' });
    }
    if (error instanceof StorageError) {
      const statusByCode = {
        DUPLICATE_SENTENCE: 409,
        ROUND_ALREADY_ACTIVE: 409,
        ROUND_LOCK_EXPIRED: 409,
        PLAYER_ATTEMPT_LIMIT: 429,
        DATABASE_NOT_INITIALIZED: 503,
      };
      return response.status(statusByCode[error.code] || 503).json({ error: error.message, code: error.code });
    }
    if (error instanceof AppError || error instanceof AwsIdentityError) {
      return response.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const incidentId = randomUUID();
    console.error(`Request failed (${incidentId})`, error);
    return response.status(500).json({
      error: 'The local server could not complete the request.',
      code: 'INTERNAL_ERROR',
      incidentId,
    });
  });

  return {
    app,
    config,
    database,
    store,
    getLeaderboard,
    usageSummary,
    waitForWrites: () => store.waitForWrites(),
  };
}
