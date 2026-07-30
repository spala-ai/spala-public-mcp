import { isAbsolute, parse, resolve } from 'node:path';

export type AppConfig = {
  port: number | string;
  publicBaseUrl: string;
  spalaApiBaseUrl: string;
  publicOAuthEncryptionSecret: string;
  publicOAuthReplayStatePath: string;
  publicOAuthTicketLifetimeSeconds: number;
  publicOAuthCodeLifetimeSeconds: number;
  publicOAuthClientLifetimeSeconds: number;
  publicOAuthRateLimitMax: number;
  publicOAuthBodyLimitBytes: number;
  publicMcpPlatformServiceSecret: string;
  publicMcpPlatformTimeoutMs: number;
  publicMcpPlatformResponseLimitBytes: number;
  publicMcpTrustedSharedRuntimeOrigins: readonly string[];
  spalaAgentA2aResourceUrl: string | null;
  dashboardUrl: string;
  pricingUrl: string;
  docsUrl: string;
  corsAllowedOrigins: readonly string[];
  mcpBodyLimitBytes: number;
  mcpRateLimitMax: number;
  telemetryStatePath: string | null;
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

function requiredOriginUrl(
  env: Environment,
  name: string,
  options: { allowHttpLocalhost?: boolean } = {},
): string {
  const value = env[name]?.trim();
  if (!value) configError(name, 'is required');
  return absoluteUrl(env, name, value, { originOnly: true, ...options });
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

function trustedSharedRuntimeOrigins(env: Environment): readonly string[] {
  const raw = env['PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS']?.trim();
  if (!raw) return [];

  const values = raw.split(',').map(value => value.trim());
  if (values.some(value => !value)) {
    configError('PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS', 'contains an empty entry');
  }
  if (values.includes('*')) {
    configError('PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS', 'wildcards are not allowed');
  }

  return [...new Set(values.map(value => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return configError(
        'PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS',
        'entries must be exact HTTPS origins',
      );
    }
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      configError(
        'PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS',
        'entries must be exact HTTPS origins without credentials, paths, queries, or fragments',
      );
    }
    return url.origin;
  }))];
}

function oauthEncryptionSecret(env: Environment): string {
  const value = env['PUBLIC_OAUTH_ENCRYPTION_SECRET'] || '';
  if (!value) configError('PUBLIC_OAUTH_ENCRYPTION_SECRET', 'is required');
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (value.length < 32 || byteLength < 32 || byteLength > 4_096 || /[\0\r\n]/.test(value)) {
    configError('PUBLIC_OAUTH_ENCRYPTION_SECRET', 'must contain at least 32 characters and between 32 and 4096 UTF-8 bytes without control line breaks');
  }
  return value;
}

function platformServiceSecret(env: Environment): string {
  const value = env['PUBLIC_MCP_PLATFORM_SERVICE_SECRET'] || '';
  if (!value) configError('PUBLIC_MCP_PLATFORM_SERVICE_SECRET', 'is required');
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (value.length < 32 || byteLength < 32 || byteLength > 4_096 || /\s/.test(value)) {
    configError('PUBLIC_MCP_PLATFORM_SERVICE_SECRET', 'must contain at least 32 characters and between 32 and 4096 UTF-8 bytes without whitespace');
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

function telemetryStatePath(env: Environment): string | null {
  const disabled = (env['TELEMETRY_DISABLED'] ?? '').trim().toLowerCase();
  if (disabled === '1' || disabled === 'true') return null;
  const value = env['TELEMETRY_STATE_PATH']?.trim();
  if (!value) return resolve('.state/telemetry');
  if (!isAbsolute(value) || value.length > 1_024 || /[\0\r\n]/.test(value)) {
    configError('TELEMETRY_STATE_PATH', 'must be an absolute filesystem path without control line breaks');
  }
  const normalized = resolve(value);
  if (normalized === parse(normalized).root) {
    configError('TELEMETRY_STATE_PATH', 'must be a dedicated directory below the filesystem root');
  }
  return normalized;
}

function optionalA2aResourceUrl(env: Environment): string | null {
  const value = env['SPALA_AGENT_A2A_RESOURCE_URL']?.trim();
  if (!value) return null;
  const normalized = absoluteUrl(env, 'SPALA_AGENT_A2A_RESOURCE_URL', value, {
    allowHttpLocalhost: true,
  });
  const url = new URL(normalized);
  if (url.search || url.pathname !== '/a2a/jsonrpc') {
    configError('SPALA_AGENT_A2A_RESOURCE_URL', 'must be an exact /a2a/jsonrpc resource URL without a query');
  }
  return normalized;
}

export function loadConfig(env: Environment = process.env): AppConfig {
  const publicBaseUrl = absoluteUrl(env, 'PUBLIC_BASE_URL', 'http://localhost:4100', {
    originOnly: true,
    allowHttpLocalhost: true,
  });
  const spalaApiBaseUrl = requiredOriginUrl(env, 'SPALA_API_BASE_URL', {
    allowHttpLocalhost: true,
  });
  const hostedPublicService = new URL(publicBaseUrl).protocol === 'https:';

  return {
    port: listenTargetEnv(env, 'PORT', 4100, 1, 65_535),
    publicBaseUrl,
    spalaApiBaseUrl,
    publicOAuthEncryptionSecret: oauthEncryptionSecret(env),
    publicOAuthReplayStatePath: oauthReplayStatePath(env, hostedPublicService),
    publicOAuthTicketLifetimeSeconds: integerEnv(env, 'PUBLIC_OAUTH_TICKET_LIFETIME_SECONDS', 300, 30, 900),
    publicOAuthCodeLifetimeSeconds: integerEnv(env, 'PUBLIC_OAUTH_CODE_LIFETIME_SECONDS', 60, 15, 300),
    publicOAuthClientLifetimeSeconds: integerEnv(env, 'PUBLIC_OAUTH_CLIENT_LIFETIME_SECONDS', 2_592_000, 3_600, 31_536_000),
    publicOAuthRateLimitMax: integerEnv(env, 'PUBLIC_OAUTH_RATE_LIMIT_MAX', 120, 1, 10_000),
    publicOAuthBodyLimitBytes: integerEnv(env, 'PUBLIC_OAUTH_BODY_LIMIT_BYTES', 32_768, 4_096, 1_048_576),
    publicMcpPlatformServiceSecret: platformServiceSecret(env),
    publicMcpPlatformTimeoutMs: integerEnv(env, 'PUBLIC_MCP_PLATFORM_TIMEOUT_MS', 8_000, 100, 60_000),
    publicMcpPlatformResponseLimitBytes: integerEnv(env, 'PUBLIC_MCP_PLATFORM_RESPONSE_LIMIT_BYTES', 1_048_576, 1_024, 10_485_760),
    publicMcpTrustedSharedRuntimeOrigins: trustedSharedRuntimeOrigins(env),
    spalaAgentA2aResourceUrl: optionalA2aResourceUrl(env),
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
    mcpBodyLimitBytes: integerEnv(env, 'MCP_BODY_LIMIT_BYTES', 1_048_576, 16_384, 10_485_760),
    mcpRateLimitMax: integerEnv(env, 'MCP_RATE_LIMIT_MAX', 120, 1, 10_000),
    telemetryStatePath: telemetryStatePath(env),
  };
}
