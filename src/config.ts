export type AppConfig = {
  port: number;
  publicBaseUrl: string;
  spalaApiBaseUrl: string;
  dashboardUrl: string;
  docsUrl: string;
  corsAllowedOrigins: readonly string[];
  fetchTimeoutMs: number;
  mcpBodyLimitBytes: number;
  mcpRateLimitMax: number;
  dryRunProjectCreate: true;
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

function booleanEnv(env: Environment, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return configError(name, 'must be exactly true or false');
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

export function loadConfig(env: Environment = process.env): AppConfig {
  const dryRunProjectCreate = booleanEnv(env, 'DRY_RUN_PROJECT_CREATE', true);
  if (!dryRunProjectCreate) {
    configError(
      'DRY_RUN_PROJECT_CREATE',
      'must remain true until the platform exposes an existing generic authenticated project-management contract',
    );
  }

  return {
    port: integerEnv(env, 'PORT', 4100, 1, 65_535),
    publicBaseUrl: absoluteUrl(env, 'PUBLIC_BASE_URL', 'http://localhost:4100', {
      originOnly: true,
      allowHttpLocalhost: true,
    }),
    spalaApiBaseUrl: absoluteUrl(env, 'SPALA_API_BASE_URL', 'https://api.spala.ai', {
      originOnly: true,
      allowHttpLocalhost: true,
    }),
    dashboardUrl: absoluteUrl(env, 'SPALA_DASHBOARD_URL', 'https://dashboard.spala.ai', {
      originOnly: true,
      allowHttpLocalhost: true,
    }),
    docsUrl: absoluteUrl(env, 'SPALA_DOCS_URL', 'https://docs.spala.ai/agents/mcp', {
      allowHttpLocalhost: true,
    }),
    corsAllowedOrigins: corsOrigins(env),
    fetchTimeoutMs: integerEnv(env, 'FETCH_TIMEOUT_MS', 8_000, 100, 60_000),
    mcpBodyLimitBytes: integerEnv(env, 'MCP_BODY_LIMIT_BYTES', 1_048_576, 16_384, 10_485_760),
    mcpRateLimitMax: integerEnv(env, 'MCP_RATE_LIMIT_MAX', 120, 1, 10_000),
    dryRunProjectCreate: true,
  };
}
