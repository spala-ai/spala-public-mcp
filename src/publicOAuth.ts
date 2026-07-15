import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.js';

type ClientRegistration = {
  kind: 'client';
  clientId: string;
  redirectUris: string[];
  expiresAt: number;
};

type AuthorizationTicket = {
  kind: 'ticket';
  ticketId: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  scope: 'api';
  expiresAt: number;
};

type AuthorizationCode = Omit<AuthorizationTicket, 'kind' | 'expiresAt'> & {
  kind: 'code';
  codeId: string;
  dashboardToken: string;
  expiresAt: number;
};

type AccessToken = {
  kind: 'access';
  tokenId: string;
  dashboardToken: string;
  resource: string;
  scope: 'api';
  expiresAt: number;
};

type RefreshToken = {
  kind: 'refresh';
  refreshId: string;
  clientId: string;
  dashboardToken: string;
  resource: string;
  scope: 'api';
  expiresAt: number;
};

type EncryptedPayload = ClientRegistration | AuthorizationTicket | AuthorizationCode | AccessToken | RefreshToken;
type ReplayKind = 'ticket' | 'code' | 'refresh';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_MASK = 0o777;
const REPLAY_CLEANUP_INTERVAL_SECONDS = 60;
const REPLAY_BUCKET_SECONDS = 3_600;
const REPLAY_BUCKET_PATTERN = /^\d+$/;

export class PublicOAuthError extends Error {
  constructor(readonly error: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'PublicOAuthError';
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function publicResource(config: AppConfig): string {
  return `${config.publicBaseUrl}/mcp`;
}

function encryptionKey(config: AppConfig): Buffer {
  return createHash('sha256').update(`spala-public-mcp-oauth-v1:${config.publicOAuthEncryptionSecret}`, 'utf8').digest();
}

function encrypt(config: AppConfig, payload: EncryptedPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(config), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function decrypt(config: AppConfig, value: string): EncryptedPayload {
  if (typeof value !== 'string' || value.length < 32 || value.length > 16_384) {
    throw new PublicOAuthError('invalid_request', 'The OAuth request is invalid.');
  }
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new PublicOAuthError('invalid_request', 'The OAuth request is invalid.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(config), Buffer.from(parts[1]!, 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[3]!, 'base64url'));
    const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64url')), decipher.final()]).toString('utf8')) as EncryptedPayload;
    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed) || !('expiresAt' in parsed) || typeof parsed.expiresAt !== 'number') {
      throw new Error('invalid payload');
    }
    if (parsed.expiresAt <= nowSeconds()) throw new PublicOAuthError('invalid_request', 'The OAuth request has expired.');
    return parsed;
  } catch (error) {
    if (error instanceof PublicOAuthError) throw error;
    throw new PublicOAuthError('invalid_request', 'The OAuth request is invalid.');
  }
}

function randomId(): string {
  return randomBytes(24).toString('base64url');
}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new PublicOAuthError('invalid_request', `Invalid ${field}.`);
  }
  return value;
}

function validateRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicOAuthError('invalid_request', 'Invalid redirect_uri.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(hostname);
  if (!localHttp || url.username || url.password || url.hash || url.search) {
    throw new PublicOAuthError('invalid_request', 'Invalid redirect_uri.');
  }
  return url.toString();
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function equal(value: string, expected: string): boolean {
  const left = Buffer.from(value, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function stateUnavailable(): PublicOAuthError {
  return new PublicOAuthError('server_error', 'The OAuth service is temporarily unavailable.', 503);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

class DurableReplayStore {
  private nextCleanupAt = 0;

  constructor(private readonly statePath: string) {
    try {
      mkdirSync(statePath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      this.secureStateDirectory();
    } catch {
      throw new Error('OAuth replay state could not be initialized securely.');
    }
  }

  has(kind: ReplayKind, id: string, expiresAt: number): boolean {
    this.assertAvailable();
    try {
      lstatSync(this.markerPath(kind, id, expiresAt));
      return true;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false;
      throw stateUnavailable();
    }
  }

  claim(kind: ReplayKind, id: string, expiresAt: number): boolean {
    this.assertAvailable();
    const now = nowSeconds();
    if (expiresAt <= now) return false;
    this.cleanupExpired(now);
    const bucketPath = this.bucketPath(expiresAt);
    try {
      mkdirSync(bucketPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      this.secureDirectory(bucketPath);
      this.syncDirectory(this.statePath);
    } catch (error) {
      if (error instanceof PublicOAuthError) throw error;
      throw stateUnavailable();
    }

    const markerPath = this.markerPath(kind, id, expiresAt);
    let descriptor: number;
    try {
      descriptor = openSync(
        markerPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return false;
      throw stateUnavailable();
    }

    try {
      fchmodSync(descriptor, PRIVATE_FILE_MODE);
      const marker = `${JSON.stringify({ version: 1, kind, expiresAt })}\n`;
      writeFileSync(descriptor, marker, { encoding: 'utf8' });
      fsyncSync(descriptor);
      const markerState = fstatSync(descriptor);
      if (!markerState.isFile() || markerState.nlink !== 1 || (markerState.mode & PERMISSION_MASK) !== PRIVATE_FILE_MODE) {
        throw stateUnavailable();
      }
    } catch (error) {
      if (error instanceof PublicOAuthError) throw error;
      throw stateUnavailable();
    } finally {
      closeSync(descriptor);
    }

    this.syncDirectory(bucketPath);
    return true;
  }

  private markerPath(kind: ReplayKind, id: string, expiresAt: number): string {
    const digest = createHash('sha256').update(`${kind}:${id}`, 'utf8').digest('hex');
    return join(this.bucketPath(expiresAt), `${kind}.${digest}`);
  }

  private bucketPath(expiresAt: number): string {
    const bucketExpiresAt = Math.ceil(expiresAt / REPLAY_BUCKET_SECONDS) * REPLAY_BUCKET_SECONDS;
    return join(this.statePath, String(bucketExpiresAt));
  }

  private assertAvailable(): void {
    try {
      this.secureStateDirectory();
    } catch {
      throw stateUnavailable();
    }
  }

  private secureStateDirectory(): void {
    this.secureDirectory(this.statePath);
  }

  private secureDirectory(path: string): void {
    const initial = lstatSync(path);
    if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error('OAuth replay state is not a directory.');
    if (typeof process.getuid === 'function' && initial.uid !== process.getuid()) {
      throw new Error('OAuth replay state has an unexpected owner.');
    }
    if ((initial.mode & PERMISSION_MASK) !== PRIVATE_DIRECTORY_MODE) {
      throw new Error('OAuth replay state permissions are insecure.');
    }
  }

  private cleanupExpired(now: number): void {
    if (now < this.nextCleanupAt) return;

    let removed = false;
    try {
      for (const entry of readdirSync(this.statePath)) {
        if (!REPLAY_BUCKET_PATTERN.test(entry) || Number(entry) > now) continue;
        const expiredBucketPath = join(this.statePath, entry);
        try {
          const bucket = lstatSync(expiredBucketPath);
          if (!bucket.isDirectory() || bucket.isSymbolicLink()) throw new Error('Invalid OAuth replay bucket.');
          rmSync(expiredBucketPath, { recursive: true });
          removed = true;
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
        }
      }
      if (removed) this.syncDirectory(this.statePath);
      this.nextCleanupAt = now + REPLAY_CLEANUP_INTERVAL_SECONDS;
    } catch (error) {
      if (error instanceof PublicOAuthError) throw error;
      throw stateUnavailable();
    }
  }

  private syncDirectory(path: string): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const state = fstatSync(descriptor);
      if (!state.isDirectory() || (state.mode & PERMISSION_MASK) !== PRIVATE_DIRECTORY_MODE) throw stateUnavailable();
      if (typeof process.getuid === 'function' && state.uid !== process.getuid()) throw stateUnavailable();
      fsyncSync(descriptor);
    } catch {
      throw stateUnavailable();
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

export class PublicOAuthFacade {
  private readonly replayStore: DurableReplayStore;

  constructor(private readonly config: AppConfig) {
    this.replayStore = new DurableReplayStore(config.publicOAuthReplayStatePath);
  }

  register(input: unknown): { clientId: string; redirectUris: string[]; expiresAt: number } {
    const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
    const values = record?.['redirect_uris'];
    if (!Array.isArray(values) || values.length < 1 || values.length > 16) {
      throw new PublicOAuthError('invalid_client_metadata', 'Provide between one and sixteen redirect_uris.');
    }
    const redirectUris = [...new Set(values.map(value => validateRedirectUri(requiredString(value, 'redirect_uri', 2_048))))];
    const expiresAt = nowSeconds() + this.config.publicOAuthClientLifetimeSeconds;
    const clientId = encrypt(this.config, { kind: 'client', clientId: randomId(), redirectUris, expiresAt });
    return { clientId, redirectUris, expiresAt };
  }

  createAuthorizationTicket(input: Record<string, unknown>): string {
    const clientId = requiredString(input['client_id'], 'client_id', 16_384);
    const registration = decrypt(this.config, clientId);
    if (registration.kind !== 'client') throw new PublicOAuthError('invalid_client', 'The OAuth client is invalid.', 401);
    if (input['response_type'] !== 'code') throw new PublicOAuthError('unsupported_response_type', 'Only authorization code flow is supported.');
    if (input['resource'] !== publicResource(this.config)) throw new PublicOAuthError('invalid_target', 'The OAuth resource is invalid.');
    if (input['scope'] !== 'api') throw new PublicOAuthError('invalid_scope', 'The OAuth scope must be api.');
    if (input['code_challenge_method'] !== 'S256') throw new PublicOAuthError('invalid_request', 'PKCE S256 is required.');
    const codeChallenge = requiredString(input['code_challenge'], 'code_challenge', 128);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) throw new PublicOAuthError('invalid_request', 'Invalid code_challenge.');
    const state = requiredString(input['state'], 'state', 2_048);
    const redirectUri = validateRedirectUri(requiredString(input['redirect_uri'], 'redirect_uri', 2_048));
    if (!registration.redirectUris.includes(redirectUri)) throw new PublicOAuthError('invalid_request', 'The redirect_uri is not registered for this client.');
    return encrypt(this.config, {
      kind: 'ticket',
      ticketId: randomId(),
      clientId,
      redirectUri,
      state,
      codeChallenge,
      resource: publicResource(this.config),
      scope: 'api',
      expiresAt: nowSeconds() + this.config.publicOAuthTicketLifetimeSeconds,
    });
  }

  approve(ticketValue: string, dashboardToken: string): { callbackUrl: string } {
    const ticket = decrypt(this.config, ticketValue);
    if (ticket.kind !== 'ticket') throw new PublicOAuthError('invalid_request', 'The authorization request is invalid.');
    const dashboardCredential = requiredString(dashboardToken, 'dashboard credential', 8_192);
    if (!this.replayStore.claim('ticket', ticket.ticketId, ticket.expiresAt)) {
      throw new PublicOAuthError('invalid_request', 'The authorization request has already been used.');
    }
    const code = encrypt(this.config, {
      ...ticket,
      kind: 'code',
      codeId: randomId(),
      dashboardToken: dashboardCredential,
      expiresAt: nowSeconds() + this.config.publicOAuthCodeLifetimeSeconds,
    });
    const callback = new URL(ticket.redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', ticket.state);
    return { callbackUrl: callback.toString() };
  }

  private issueTokens(dashboardToken: string, resource: string, clientId: string): { accessToken: string; refreshToken: string; expiresIn: number } {
    const accessExpiresAt = nowSeconds() + this.config.publicOAuthAccessTokenLifetimeSeconds;
    const refreshExpiresAt = nowSeconds() + this.config.publicOAuthRefreshTokenLifetimeSeconds;
    return {
      accessToken: encrypt(this.config, {
        kind: 'access',
        tokenId: randomId(),
        dashboardToken,
        resource,
        scope: 'api',
        expiresAt: accessExpiresAt,
      }),
      refreshToken: encrypt(this.config, {
        kind: 'refresh',
        refreshId: randomId(),
        clientId,
        dashboardToken,
        resource,
        scope: 'api',
        expiresAt: refreshExpiresAt,
      }),
      expiresIn: this.config.publicOAuthAccessTokenLifetimeSeconds,
    };
  }

  redeem(input: Record<string, unknown>): { accessToken: string; refreshToken: string; expiresIn: number } {
    if (input['grant_type'] !== 'authorization_code') throw new PublicOAuthError('unsupported_grant_type', 'Only authorization_code is supported.');
    const codeValue = requiredString(input['code'], 'code', 16_384);
    const code = decrypt(this.config, codeValue);
    if (code.kind !== 'code') throw new PublicOAuthError('invalid_grant', 'The authorization code is invalid.');
    if (this.replayStore.has('code', code.codeId, code.expiresAt)) throw new PublicOAuthError('invalid_grant', 'The authorization code has already been used.');
    const clientId = requiredString(input['client_id'], 'client_id', 16_384);
    const redirectUri = validateRedirectUri(requiredString(input['redirect_uri'], 'redirect_uri', 2_048));
    const verifier = requiredString(input['code_verifier'], 'code_verifier', 128);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || input['resource'] !== code.resource || !equal(clientId, code.clientId) || redirectUri !== code.redirectUri || !equal(sha256Base64Url(verifier), code.codeChallenge)) {
      throw new PublicOAuthError('invalid_grant', 'The authorization code cannot be redeemed.');
    }
    if (!this.replayStore.claim('code', code.codeId, code.expiresAt)) {
      throw new PublicOAuthError('invalid_grant', 'The authorization code has already been used.');
    }
    return this.issueTokens(code.dashboardToken, code.resource, code.clientId);
  }

  refreshDashboardToken(input: Record<string, unknown>): string {
    if (input['grant_type'] !== 'refresh_token') throw new PublicOAuthError('unsupported_grant_type', 'Unsupported OAuth grant type.');
    const value = requiredString(input['refresh_token'], 'refresh_token', 16_384);
    const refresh = decrypt(this.config, value);
    if (refresh.kind !== 'refresh' || refresh.resource !== publicResource(this.config) || refresh.scope !== 'api') {
      throw new PublicOAuthError('invalid_grant', 'The refresh token is invalid.');
    }
    const clientId = requiredString(input['client_id'], 'client_id', 16_384);
    if ((input['resource'] !== undefined && input['resource'] !== refresh.resource) || !equal(clientId, refresh.clientId) || this.replayStore.has('refresh', refresh.refreshId, refresh.expiresAt)) {
      throw new PublicOAuthError('invalid_grant', 'The refresh token cannot be redeemed.');
    }
    return refresh.dashboardToken;
  }

  rotateRefresh(input: Record<string, unknown>): { accessToken: string; refreshToken: string; expiresIn: number } {
    const value = requiredString(input['refresh_token'], 'refresh_token', 16_384);
    const refresh = decrypt(this.config, value);
    if (refresh.kind !== 'refresh' || this.replayStore.has('refresh', refresh.refreshId, refresh.expiresAt)) {
      throw new PublicOAuthError('invalid_grant', 'The refresh token cannot be redeemed.');
    }
    if (!this.replayStore.claim('refresh', refresh.refreshId, refresh.expiresAt)) {
      throw new PublicOAuthError('invalid_grant', 'The refresh token cannot be redeemed.');
    }
    return this.issueTokens(refresh.dashboardToken, refresh.resource, refresh.clientId);
  }

  dashboardToken(accessToken: string): string {
    const token = decrypt(this.config, accessToken);
    if (token.kind !== 'access' || token.resource !== publicResource(this.config) || token.scope !== 'api') {
      throw new PublicOAuthError('invalid_token', 'The MCP access token is invalid.', 401);
    }
    return token.dashboardToken;
  }
}
