import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { createHash } from 'node:crypto';

export class AwsIdentityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AwsIdentityError';
    this.statusCode = 503;
    this.code = code;
  }
}

function credentialSource(config, env) {
  const profile = (env.AWS_PROFILE || '').trim();
  const accessKeyId = (env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (env.AWS_SECRET_ACCESS_KEY || '').trim();
  const hasAnyEnvironmentCredential = Boolean(accessKeyId || secretAccessKey || env.AWS_SESSION_TOKEN);
  const hasCompleteEnvironmentCredential = Boolean(accessKeyId && secretAccessKey);

  if (profile && hasAnyEnvironmentCredential) {
    throw new AwsIdentityError(
      'Configure either AWS_PROFILE or server-side AWS environment credentials, not both.',
      'AWS_CREDENTIAL_SOURCES_CONFLICT',
    );
  }
  if (profile) return { profile, label: `profile:${profile}` };
  if (hasAnyEnvironmentCredential && !hasCompleteEnvironmentCredential) {
    throw new AwsIdentityError(
      'Server-side AWS environment credentials are incomplete.',
      'AWS_CREDENTIALS_INCOMPLETE',
    );
  }
  if (hasCompleteEnvironmentCredential) return { profile: undefined, label: 'environment' };
  throw new AwsIdentityError(
    'No explicit DEVFEST AWS credential source is configured. Set AWS_PROFILE locally or server-side AWS credentials on Vercel.',
    'AWS_CREDENTIAL_SOURCE_REQUIRED',
  );
}

function credentialFingerprint(credentials, sourceLabel) {
  return createHash('sha256')
    .update(sourceLabel)
    .update('\0')
    .update(credentials.accessKeyId)
    .update('\0')
    .update(credentials.sessionToken || '')
    .update('\0')
    .update(credentials.expiration?.toISOString?.() || '')
    .digest('hex');
}

function normalizeCredentials(credentials) {
  const accessKeyId = credentials.accessKeyId?.trim();
  const secretAccessKey = credentials.secretAccessKey?.trim();
  const sessionToken = credentials.sessionToken?.trim() || undefined;
  if (accessKeyId === credentials.accessKeyId
    && secretAccessKey === credentials.secretAccessKey
    && sessionToken === credentials.sessionToken) return credentials;
  return { ...credentials, accessKeyId, secretAccessKey, sessionToken };
}

function safeCredentialError(source, cause) {
  const code = source.profile ? 'AWS_PROFILE_UNAVAILABLE' : 'AWS_CREDENTIALS_UNAVAILABLE';
  const message = source.profile
    ? `AWS profile "${source.profile}" could not be loaded or is not authenticated.`
    : 'The configured server-side AWS credentials could not be loaded.';
  const error = new AwsIdentityError(message, code);
  error.cause = cause;
  return error;
}

function diagnosticToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function awsFailureDiagnostic(cause, context) {
  const metadata = cause?.$metadata || {};
  return {
    operation: context.operation,
    region: diagnosticToken(context.region),
    credentialSource: context.credentialSource,
    hasSessionToken: context.hasSessionToken,
    environmentCredentialWhitespace: context.environmentCredentialWhitespace,
    timeoutMs: context.timeoutMs,
    timedOut: context.timedOut,
    errorName: diagnosticToken(cause?.name),
    errorCode: diagnosticToken(cause?.Code || cause?.code),
    networkErrorCode: diagnosticToken(cause?.cause?.code),
    httpStatusCode: Number.isSafeInteger(metadata.httpStatusCode) ? metadata.httpStatusCode : undefined,
    requestId: diagnosticToken(metadata.requestId),
    attempts: Number.isSafeInteger(metadata.attempts) ? metadata.attempts : undefined,
  };
}

function logAwsFailure(logger, event, cause, context) {
  try {
    logger.error(event, awsFailureDiagnostic(cause, context));
  } catch {
    // Diagnostics must never replace the safe application error.
  }
}

export function createAwsIdentityGuard(config, options = {}) {
  const env = options.env || process.env;
  const credentialProviderFactory = options.credentialProviderFactory
    || ((source) => defaultProvider({ profile: source.profile }));
  const stsClientFactory = options.stsClientFactory
    || ((clientConfig) => new STSClient(clientConfig));
  const cache = new Map();
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  const now = options.now || (() => Date.now());
  const logger = options.logger || console;
  const environmentCredentialWhitespace = [
    env.AWS_ACCESS_KEY_ID,
    env.AWS_SECRET_ACCESS_KEY,
    env.AWS_SESSION_TOKEN,
  ].some((value) => typeof value === 'string' && value !== value.trim());

  return async function verifyAwsIdentity() {
    const source = credentialSource(config, env);
    let credentials;
    try {
      credentials = await credentialProviderFactory(source)();
      credentials = normalizeCredentials(credentials);
    } catch (cause) {
      logAwsFailure(logger, 'AWS credential resolution failed', cause, {
        operation: 'ResolveCredentials',
        region: config.region,
        credentialSource: source.profile ? 'profile' : 'environment',
        hasSessionToken: Boolean(env.AWS_SESSION_TOKEN),
        environmentCredentialWhitespace,
        timeoutMs: undefined,
        timedOut: false,
      });
      throw safeCredentialError(source, cause);
    }

    const fingerprint = credentialFingerprint(credentials, source.label);
    const cached = cache.get(fingerprint);
    if (cached && cached.validUntil > now()) {
      return { account: cached.account, credentials, credentialSource: source.label };
    }

    const client = stsClientFactory({
      region: config.region,
      credentials,
      maxAttempts: 1,
    });
    let identity;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.awsRequestTimeoutMs);
    timeout.unref?.();
    try {
      identity = await client.send(new GetCallerIdentityCommand({}), {
        abortSignal: controller.signal,
      });
    } catch (cause) {
      logAwsFailure(logger, 'AWS STS identity verification failed', cause, {
        operation: 'GetCallerIdentity',
        region: config.region,
        credentialSource: source.profile ? 'profile' : 'environment',
        hasSessionToken: Boolean(credentials.sessionToken),
        environmentCredentialWhitespace,
        timeoutMs: config.awsRequestTimeoutMs,
        timedOut: controller.signal.aborted,
      });
      const error = new AwsIdentityError(
        'The configured AWS identity could not be verified with STS.',
        'AWS_IDENTITY_UNVERIFIED',
      );
      error.cause = cause;
      throw error;
    } finally {
      clearTimeout(timeout);
      client.destroy?.();
    }

    if (!identity?.Account) {
      throw new AwsIdentityError('AWS STS did not return an account ID.', 'AWS_IDENTITY_UNVERIFIED');
    }
    if (identity.Account !== config.devfestAwsAccountId) {
      throw new AwsIdentityError(
        'The authenticated AWS identity is not authorized for this DEVFEST project.',
        'AWS_ACCOUNT_MISMATCH',
      );
    }

    const credentialExpiry = credentials.expiration?.getTime?.();
    const validUntil = Math.min(
      now() + cacheTtlMs,
      credentialExpiry ? Math.max(now(), credentialExpiry - 60_000) : Number.POSITIVE_INFINITY,
    );
    cache.clear();
    cache.set(fingerprint, { account: identity.Account, validUntil });
    return { account: identity.Account, credentials, credentialSource: source.label };
  };
}

export function createAwsTranslator(config, credentials, options = {}) {
  const translateClientFactory = options.translateClientFactory
    || ((clientConfig) => new TranslateClient(clientConfig));
  const client = translateClientFactory({
    region: config.region,
    credentials,
    maxAttempts: 1,
  });

  return {
    async translate({ text, sourceLanguage, targetLanguage }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.awsRequestTimeoutMs);
      timeout.unref?.();
      try {
        const result = await client.send(new TranslateTextCommand({
          Text: text,
          SourceLanguageCode: sourceLanguage,
          TargetLanguageCode: targetLanguage,
        }), { abortSignal: controller.signal });
        if (typeof result.TranslatedText !== 'string' || !result.TranslatedText.trim()) {
          throw new Error('Amazon Translate returned an empty translation.');
        }
        return result.TranslatedText.trim();
      } finally {
        clearTimeout(timeout);
      }
    },
    destroy() {
      client.destroy?.();
    },
  };
}
