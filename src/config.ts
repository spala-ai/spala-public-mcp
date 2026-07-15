import { isAbsolute, parse, resolve } from 'node:path';

export type AppConfig = {
  port: number | string;
  publicBaseUrl: string;
  spalaApiBaseUrl: string;
  publicOAuthEncryptionSecret: string;
  publicOAuthReplayStatePath: string;
  publicOAuthTicketLifetimeSeconds: number;
  publicOAuthCodeLifetimeSeconds: number;
  publicOAuthAccessTokenLifetimeSeconds: number;
  publicOAuthRefreshTokenLifetimeSeconds: number;
  publicOAuthClientLifetimeSeconds: number;
  publicOAuthRateLimitMax: number;
  dashboardUrl: string;
  pricingUrl: string;
  docsUrl: string;
  corsAllowedOrigins: readonly string[];
  fetchTimeoutMs: number;
  spalaApiResponseLimitBytes: number;
  mcpBodyLimitBytes: number;
  mcpRateLimitMax: number;
};

type Environment = Record<string, string | undefined>;

function configError(name: string, message: string): never {
  throw new Error(`Invalid ${name}: ${message}`);
}

function integerEnv(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim() || String(fallback);
  if (!/^\d+$/.test(raw)) configError(name, 'must be an integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    configError(name, `must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function listenTargetEnv(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number | string {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      configError(name, `must be between ${minimum} and ${maximum}`);
    }
    return value;
  }
  if (raw.startsWith('/') && raw.length <= 512 && !/[\0\r\n]/.test(raw)) return raw;
  return configError(name, 'must be an integer TCP port or absolute Unix socket path');
}

function absoluteUrl(
  env: Environment,
  name: string,
  fallback: string,
  options: { originOnly?: boolean; allowHttpLocalhost?: boolean } = {},
): string {
  const raw = env[name]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return configError(name, 'must be an absolute URL');
  }

  const localHttp = options.allowHttpLocalhost
    && url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !localHttp) {
    configError(name, 'must use HTTPS (HTTP is allowed only for localhost)');
  }
  if (url.username || url.password) configError(name, 'must not contain credentials');
  if (url.hash) configError(name, 'must not contain a fragment');
  if (options.originOnly && (url.pathname !== '/' || url.search)) {
    configError(name, 'must be an origin without a path or query');
  }

  return options.originOnly ? url.origin : url.toString().replace(/\/+$/, '');
}

function corsOrigins(env: Environment): readonly string[] {
  const raw = env['CORS_ALLOWED_ORIGINS']?.trim();
  if (!raw) return [];

  const values = raw.split(',').map(value => value.trim());
  if (values.some(value => !value)) configError('CORS_ALLOWED_ORIGINS', 'contains an empty entry');
  if (values.includes('*')) configError('CORS_ALLOWED_ORIGINS', 'wildcards are not allowed');

  return [...new Set(values.map(value => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return configError('CORS_ALLOWED_ORIGINS', `${JSON.stringify(value)} is not an absolute origin`);
    }
    const localHttp = url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase());
    if (url.protocol !== 'https:' && !localHttp) {
      configError('CORS_ALLOWED_ORIGINS', `${JSON.stringify(value)} must use HTTPS or localhost HTTP`);
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      configError('CORS_ALLOWED_ORIGINS', `${JSON.stringify(value)} must be an origin only`);
    }
    return url.origin;
  }))];
}

function oauthEncryptionSecret(env: Environment, required: boolean): string {
  const value = env['PUBLIC_OAUTH_ENCRYPTION_SECRET'] || '';
  if (!value && required) configError('PUBLIC_OAUTH_ENCRYPTION_SECRET', 'is required for a hosted public MCP service');
  if (!value) return '';
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (value.length < 32 || byteLength < 32 || byteLength > 4_096 || /[\0\r\n]/.test(value)) {
    configError('PUBLIC_OAUTH_ENCRYPTION_SECRET', 'must contain at least 32 characters and between 32 and 4096 UTF-8 bytes without control line breaks');
  }
  return value;
}

function oauthReplayStatePath(env: Environment, required: boolean): string {
  const value = env['PUBLIC_OAUTH_REPLAY_STATE_PATH']?.trim();
  if (!value && required) {
    configError('PUBLIC_OAUTH_REPLAY_STATE_PATH', 'is required for a hosted public MCP service');
  }
  if (!value) return resolve('.state/public-oauth-replay');
  if (!isAbsolute(value) || value.length > 1_024 || /[\0\r\n]/.test(value)) {
    configError('PUBLIC_OAUTH_REPLAY_STATE_PATH', 'must be an absolute filesystem path without control line breaks');
  }
  const normalized = resolve(value);
  if (normalized === parse(normalized).root) {
    configError('PUBLIC_OAUTH_REPLAY_STATE_PATH', 'must be a dedicated directory below the filesystem root');
  }
  return normalized;
}

export function loadConfig(env: Environment = process.env): AppConfig {
  const publicBaseUrl = absoluteUrl(env, 'PUBLIC_BASE_URL', 'http://localhost:4100', {
    originOnly: true,
    allowHttpLocalhost: true,
  });
  const spalaApiBaseUrl = absoluteUrl(env, 'SPALA_API_BASE_URL', 'https://api.spala.ai', {
    originOnly: true,
  });
  const hostedPublicService = new URL(publicBaseUrl).protocol === 'https:';

  return {
    port: listenTargetEnv(env, 'PORT', 4100, 1, 65_535),
    publicBaseUrl,
    spalaApiBaseUrl,
    publicOAuthEncryptionSecret: oauthEncryptionSecret(env, hostedPublicService),
    publicOAuthReplayStatePath: oauthReplayStatePath(env, hostedPublicService),
    publicOAuthTicketLifetimeSeconds: integerEnv(env, 'PUBLIC_OAUTH_TICKET_LIFETIME_SECONDS', 300, 30, 900),
    publicOAuthCodeLifetimeSeconds: integerEnv(env, 'PUBLIC_OAUTH_CODE_LIFETIME_SECONDS', 60, 15, 300),
    publicOAuthAccessTokenLifetimeSeconds: integerEnv(env, 'PUBLIC_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS', 900, 60, 3_600),
    publicOAuthRefreshTokenLifetimeSeconds: integerEnv(env, 'PUBLIC_OAUTH_REFRESH_TOKEN_LIFETIME_SECONDS', 2_592_000, 3_600, 7_776_000),
    publicOAuthClientLifetimeSeconds: integerEnv(env, 'PUBLIC_OAUTH_CLIENT_LIFETIME_SECONDS', 2_592_000, 3_600, 31_536_000),
    publicOAuthRateLimitMax: integerEnv(env, 'PUBLIC_OAUTH_RATE_LIMIT_MAX', 120, 1, 10_000),
    dashboardUrl: absoluteUrl(env, 'SPALA_DASHBOARD_URL', 'https://dashboard.spala.ai', {
      originOnly: true,
      allowHttpLocalhost: true,
    }),
    pricingUrl: absoluteUrl(env, 'SPALA_PRICING_URL', 'https://spala.ai/pricing/', {
      allowHttpLocalhost: true,
    }),
    docsUrl: absoluteUrl(env, 'SPALA_DOCS_URL', 'https://docs.spala.ai/agents/mcp', {
      allowHttpLocalhost: true,
    }),
    corsAllowedOrigins: corsOrigins(env),
    fetchTimeoutMs: integerEnv(env, 'FETCH_TIMEOUT_MS', 8_000, 100, 60_000),
    spalaApiResponseLimitBytes: integerEnv(env, 'SPALA_API_RESPONSE_LIMIT_BYTES', 1_048_576, 1_024, 10_485_760),
    mcpBodyLimitBytes: integerEnv(env, 'MCP_BODY_LIMIT_BYTES', 1_048_576, 16_384, 10_485_760),
    mcpRateLimitMax: integerEnv(env, 'MCP_RATE_LIMIT_MAX', 120, 1, 10_000),
  };
}
