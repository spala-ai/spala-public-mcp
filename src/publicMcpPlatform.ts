import { createHash } from 'node:crypto';
import type { AppConfig } from './config.js';
import {
  PUBLIC_MCP_PLATFORM_ROUTES,
  PUBLIC_MCP_RESOURCE,
  PUBLIC_MCP_SERVICE_AUTH_HEADER,
  PUBLIC_MCP_SCOPE,
} from './publicMcpContract.js';

type FetchLike = typeof fetch;

export type PublicMcpTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  accessExpiresAt: number;
};

export type PublicMcpPlatformErrorCategory =
  | 'invalid_grant'
  | 'authentication'
  | 'insufficient_scope'
  | 'forbidden'
  | 'upstream_unavailable'
  | 'invalid_upstream_response';

export class PublicMcpPlatformError extends Error {
  constructor(
    readonly category: PublicMcpPlatformErrorCategory,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(
      category === 'upstream_unavailable' || category === 'invalid_upstream_response'
        ? 'The public MCP platform service is temporarily unavailable.'
        : 'The public MCP platform credential is invalid.',
    );
    this.name = 'PublicMcpPlatformError';
  }
}

export type PublicMcpPlatformClient = {
  consumeApproval(input: {
    request: string;
    approvalProof: string;
    clientHash: string;
  }): Promise<{ grantCode: string; expiresIn: number }>;
  issueTokens(input: {
    grantCode: string;
    clientHash: string;
  }): Promise<PublicMcpTokenSet>;
  refreshTokens(input: { refreshToken: string; clientHash: string }): Promise<PublicMcpTokenSet>;
  revokeToken(input: {
    token: string;
    clientHash: string;
  }): Promise<void>;
};

function opaqueCredential(value: unknown, maximum = 16_384): value is string {
  return typeof value === 'string'
    && value.length >= 16
    && value.length <= maximum
    && !/\s/.test(value);
}

function clientBinding(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new PublicMcpPlatformError('invalid_upstream_response');
  }
  return value;
}

function normalizedCode(value: unknown, sensitiveValues: readonly string[]): string | undefined {
  if (typeof value !== 'string' || sensitiveValues.some(secret => secret && value.includes(secret))) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 128);
  return normalized || undefined;
}

function errorCode(payload: unknown, sensitiveValues: readonly string[]): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const nested = record['error'];
  if (typeof nested === 'string') return normalizedCode(nested, sensitiveValues);
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return normalizedCode((nested as Record<string, unknown>)['code'], sensitiveValues);
  }
  return normalizedCode(record['code'], sensitiveValues);
}

function errorCategory(status: number, code: string | undefined): PublicMcpPlatformErrorCategory {
  if (status === 401 && code === 'invalid_service_auth') return 'upstream_unavailable';
  if (status === 401) return 'authentication';
  if (status === 403 && code === 'insufficient_scope') return 'insufficient_scope';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'upstream_unavailable';
  return 'invalid_grant';
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new PublicMcpPlatformError('invalid_upstream_response', response.status, 'upstream_response_too_large');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PublicMcpPlatformError('invalid_upstream_response', response.status, 'upstream_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseTokenSet(payload: unknown, sensitiveValues: readonly string[]): PublicMcpTokenSet {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PublicMcpPlatformError('invalid_upstream_response');
  }
  const record = payload as Record<string, unknown>;
  const accessToken = record['access_token'];
  const refreshToken = record['refresh_token'];
  const expiresIn = record['expires_in'];
  const accessExpiresAtValue = record['access_expires_at'];
  const accessExpiresAtMs = typeof accessExpiresAtValue === 'string'
    ? Date.parse(accessExpiresAtValue)
    : Number.NaN;
  const accessExpiresAt = Math.floor(accessExpiresAtMs / 1_000);
  const currentTime = Math.floor(Date.now() / 1_000);
  if (
    !opaqueCredential(accessToken, 8_192)
    || !opaqueCredential(refreshToken, 16_384)
    || accessToken === refreshToken
    || sensitiveValues.some(secret => accessToken.includes(secret) || refreshToken.includes(secret))
    || !Number.isSafeInteger(expiresIn)
    || (expiresIn as number) < 1
    || (expiresIn as number) > 86_400
    || typeof accessExpiresAtValue !== 'string'
    || !Number.isFinite(accessExpiresAtMs)
    || new Date(accessExpiresAtMs).toISOString() !== accessExpiresAtValue
    || !Number.isSafeInteger(accessExpiresAt)
    || accessExpiresAt <= currentTime
    || accessExpiresAt > currentTime + 86_401
    || record['resource'] !== PUBLIC_MCP_RESOURCE
    || record['audience'] !== PUBLIC_MCP_RESOURCE
    || record['scope'] !== PUBLIC_MCP_SCOPE
    || record['token_type'] !== 'Bearer'
  ) {
    throw new PublicMcpPlatformError('invalid_upstream_response');
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: expiresIn as number,
    accessExpiresAt,
  };
}

export function createPublicMcpPlatformClient(
  config: AppConfig,
  fetchImpl: FetchLike = fetch,
): PublicMcpPlatformClient {
  const serviceSecret = config.publicMcpPlatformServiceSecret;
  if (!opaqueCredential(serviceSecret, 4_096)) {
    throw new Error('Public MCP platform service authentication is not configured.');
  }

  const request = async (
    pathname: string,
    body: Record<string, unknown>,
    sensitiveValues: readonly string[],
  ): Promise<unknown> => {
    const url = new URL(pathname, config.spalaApiBaseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.publicMcpPlatformTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [PUBLIC_MCP_SERVICE_AUTH_HEADER]: serviceSecret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
      });
      const bodyText = await readBoundedBody(response, config.publicMcpPlatformResponseLimitBytes);
      let payload: unknown = null;
      if (bodyText) {
        try {
          payload = JSON.parse(bodyText);
        } catch {
          throw new PublicMcpPlatformError('invalid_upstream_response', response.status);
        }
      }
      if (!response.ok) {
        const sensitive = [serviceSecret, ...sensitiveValues];
        const code = errorCode(payload, sensitive);
        throw new PublicMcpPlatformError(errorCategory(response.status, code), response.status, code);
      }
      return payload;
    } catch (error) {
      if (error instanceof PublicMcpPlatformError) throw error;
      throw new PublicMcpPlatformError('upstream_unavailable');
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    async consumeApproval({ request: approvalRequest, approvalProof, clientHash }) {
      const binding = clientBinding(clientHash);
      const payload = await request(
        PUBLIC_MCP_PLATFORM_ROUTES.approvalConsume,
        {
          approvalProof,
          requestHash: createHash('sha256').update(approvalRequest, 'utf8').digest('hex'),
          clientHash: binding,
          resource: PUBLIC_MCP_RESOURCE,
          scope: PUBLIC_MCP_SCOPE,
        },
        [approvalRequest, approvalProof, binding],
      );
      const grantCode = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)['grantCode']
        : undefined;
      const expiresIn = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)['expiresIn']
        : undefined;
      if (
        !opaqueCredential(grantCode)
        || !Number.isSafeInteger(expiresIn)
        || (expiresIn as number) < 1
        || (expiresIn as number) > 86_400
      ) {
        throw new PublicMcpPlatformError('invalid_upstream_response');
      }
      return { grantCode, expiresIn: expiresIn as number };
    },

    async issueTokens({ grantCode, clientHash }) {
      const binding = clientBinding(clientHash);
      const payload = await request(
        PUBLIC_MCP_PLATFORM_ROUTES.tokenIssue,
        { grantCode, clientHash: binding, resource: PUBLIC_MCP_RESOURCE, scope: PUBLIC_MCP_SCOPE },
        [grantCode, binding],
      );
      return parseTokenSet(payload, [serviceSecret, grantCode, binding]);
    },

    async refreshTokens({ refreshToken, clientHash }) {
      const binding = clientBinding(clientHash);
      const payload = await request(
        PUBLIC_MCP_PLATFORM_ROUTES.tokenRefresh,
        { refreshToken, clientHash: binding, resource: PUBLIC_MCP_RESOURCE, scope: PUBLIC_MCP_SCOPE },
        [refreshToken, binding],
      );
      return parseTokenSet(payload, [serviceSecret, refreshToken, binding]);
    },

    async revokeToken({ token, clientHash }) {
      const binding = clientBinding(clientHash);
      await request(
        PUBLIC_MCP_PLATFORM_ROUTES.tokenRevoke,
        {
          token,
          clientHash: binding,
          resource: PUBLIC_MCP_RESOURCE,
        },
        [token, binding],
      );
    },
  };
}
