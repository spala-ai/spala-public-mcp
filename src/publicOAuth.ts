import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import { PUBLIC_MCP_RESOURCE, PUBLIC_MCP_SCOPE } from './publicMcpContract.js';

type ClientRegistration = {
  kind: 'client';
  clientId: string;
  redirectUris: string[];
  tokenEndpointAuthMethod?: 'none' | 'client_secret_post';
  clientSecretHash?: string;
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
  scope: typeof PUBLIC_MCP_SCOPE;
  expiresAt: number;
};

type AuthorizationCode = Omit<AuthorizationTicket, 'kind' | 'expiresAt'> & {
  kind: 'code';
  codeId: string;
  platformGrantCode: string;
  retryExpiresAt: number;
  expiresAt: number;
};

type DelegatedAccessToken = {
  kind: 'delegated-access';
  platformAccessToken: string;
  clientHash: string;
  resource: string;
  scope: typeof PUBLIC_MCP_SCOPE;
  expiresAt: number;
};

type DelegatedRefreshToken = {
  kind: 'delegated-refresh';
  platformRefreshToken: string;
  clientHash: string;
  resource: string;
  scope: typeof PUBLIC_MCP_SCOPE;
  expiresAt: number;
};

type RefreshRetryResult = {
  kind: 'refresh-result';
  requestHash: string;
  clientHash: string;
  accessToken: `v1a.${string}`;
  refreshToken: `v1r.${string}`;
  expiresIn: number;
  expiresAt: number;
};

type EncryptedPayload =
  | ClientRegistration
  | AuthorizationTicket
  | AuthorizationCode
  | DelegatedAccessToken
  | DelegatedRefreshToken
  | RefreshRetryResult;
type ReplayKind = 'ticket' | 'code' | 'code-state' | 'refresh-result';
type RedemptionState = 'owner' | 'available' | 'complete';
type ReplayMarker = {
  version: 1;
  kind: ReplayKind;
  expiresAt: number;
  approvalProofHash?: string;
  approvedAt?: number;
  grantExpiresAt?: number;
  redemptionHash?: string;
  redemptionState?: RedemptionState;
  stateId?: string;
  previousStateId?: string;
  ownerHash?: string;
  claimedAt?: number;
  claimExpiresAt?: number;
  result?: string;
};

type PreparedApproval = {
  ticket: AuthorizationTicket;
  proofHash: string;
  clientHash: string;
};

export type PublicOAuthTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  accessExpiresAt?: number;
};

export type PublicOAuthClientTokenSet = Omit<PublicOAuthTokenSet, 'accessToken'> & {
  accessToken: `v1a.${string}`;
  refreshToken: `v1r.${string}`;
};

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_MASK = 0o777;
const REPLAY_CLEANUP_INTERVAL_SECONDS = 60;
const REPLAY_BUCKET_SECONDS = 3_600;
const REPLAY_MARKER_READ_RETRIES = 50;
const APPROVAL_IDEMPOTENCY_RECOVERY_SECONDS = 300;
const REDEMPTION_LEASE_SAFETY_SECONDS = 1;
const REDEMPTION_STATE_CHAIN_LIMIT = 64;
const REFRESH_RESULT_CACHE_SECONDS = 60;
const REPLAY_BUCKET_PATTERN = /^\d+$/;
const HOSTED_REDIRECT_URIS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://vscode.dev/redirect',
  'https://vertexaisearch.cloud.google.com/oauth-redirect',
  'https://vertexaisearch.cloud.google.com/static/oauth/oauth.html',
]);
const NATIVE_REDIRECT_URIS = new Set([
  'cursor://anysphere.cursor-mcp/oauth/callback',
  'vscode://github.copilot-chat/mcp/oauth/callback',
  'vscode-insiders://github.copilot-chat/mcp/oauth/callback',
  'claude://mcp/oauth/callback',
  'codex://mcp/oauth/callback',
]);
const GOOGLE_AGENT_IDENTITY_CALLBACK_PATH =
  /^\/v1(?:alpha)?\/projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/authProviders\/[a-z][a-z0-9-]{0,62}\/oauthcallback$/;

export { PUBLIC_MCP_RESOURCE, PUBLIC_MCP_SCOPE };

export class PublicOAuthError extends Error {
  constructor(readonly error: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'PublicOAuthError';
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
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

function encryptDeterministic(
  config: AppConfig,
  payload: AuthorizationCode | DelegatedAccessToken | DelegatedRefreshToken,
  domain: 'authorization-code' | 'delegated-access' | 'delegated-refresh',
  prefix: 'v1d' | 'v1a' | 'v1r',
): string {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const rootKey = encryptionKey(config);
  const fingerprint = createHmac('sha256', rootKey)
    .update(`${domain}-fingerprint\0`, 'utf8')
    .update(plaintext)
    .digest();
  const key = createHmac('sha256', rootKey)
    .update(`${domain}-key\0`, 'utf8')
    .update(fingerprint)
    .digest();
  const iv = createHmac('sha256', rootKey)
    .update(`${domain}-iv\0`, 'utf8')
    .update(fingerprint)
    .digest()
    .subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${prefix}.${fingerprint.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function decrypt(config: AppConfig, value: string, allowExpired = false): EncryptedPayload {
  if (typeof value !== 'string' || value.length < 32 || value.length > 16_384) {
    throw new PublicOAuthError('invalid_request', 'The OAuth request is invalid.');
  }
  const parts = value.split('.');
  if (parts.length !== 4 || !['v1', 'v1d', 'v1a', 'v1r'].includes(parts[0]!)) {
    throw new PublicOAuthError('invalid_request', 'The OAuth request is invalid.');
  }
  try {
    const deterministicDomain = parts[0] === 'v1d'
      ? 'authorization-code'
      : parts[0] === 'v1a'
        ? 'delegated-access'
        : parts[0] === 'v1r'
          ? 'delegated-refresh'
          : undefined;
    const deterministic = Boolean(deterministicDomain);
    const fingerprint = deterministic ? Buffer.from(parts[1]!, 'base64url') : undefined;
    if (deterministic && fingerprint?.byteLength !== 32) throw new Error('invalid fingerprint');
    const key = deterministic
      ? createHmac('sha256', encryptionKey(config))
          .update(`${deterministicDomain}-key\0`, 'utf8')
          .update(fingerprint!)
          .digest()
      : encryptionKey(config);
    const iv = deterministic
      ? createHmac('sha256', encryptionKey(config))
          .update(`${deterministicDomain}-iv\0`, 'utf8')
          .update(fingerprint!)
          .digest()
          .subarray(0, 12)
      : Buffer.from(parts[1]!, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(parts[3]!, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parts[2]!, 'base64url')),
      decipher.final(),
    ]);
    if (deterministic) {
      const expectedFingerprint = createHmac('sha256', encryptionKey(config))
        .update(`${deterministicDomain}-fingerprint\0`, 'utf8')
        .update(plaintext)
        .digest();
      if (!timingSafeEqual(fingerprint!, expectedFingerprint)) throw new Error('invalid fingerprint');
    }
    const parsed = JSON.parse(plaintext.toString('utf8')) as EncryptedPayload;
    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed) || !('expiresAt' in parsed) || typeof parsed.expiresAt !== 'number') {
      throw new Error('invalid payload');
    }
    if (!allowExpired && parsed.expiresAt <= nowSeconds()) {
      throw new PublicOAuthError('invalid_request', 'The OAuth request has expired.');
    }
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
  const hosted = HOSTED_REDIRECT_URIS.has(value) && url.toString() === value;
  const googleAgentIdentity = (
    url.protocol === 'https:'
    && hostname === 'agentidentitycredentials.googleapis.com'
    && url.port === ''
    && GOOGLE_AGENT_IDENTITY_CALLBACK_PATH.test(url.pathname)
    && url.toString() === value
  );
  const native = NATIVE_REDIRECT_URIS.has(value) && url.toString() === value;
  if (
    (!localHttp && !hosted && !googleAgentIdentity && !native)
    || url.username
    || url.password
    || url.hash
    || url.search
  ) {
    throw new PublicOAuthError('invalid_request', 'Invalid redirect_uri.');
  }
  return url.toString();
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function publicMcpClientHash(clientId: string): string {
  return createHash('sha256').update(clientId, 'utf8').digest('hex');
}

function requestFingerprint(config: AppConfig, purpose: string, values: readonly string[]): string {
  return createHmac('sha256', encryptionKey(config))
    .update(`${purpose}\0`, 'utf8')
    .update(values.join('\0'), 'utf8')
    .digest('base64url');
}

function approvalReplayExpiresAt(expiresAt: number): number {
  return expiresAt + APPROVAL_IDEMPOTENCY_RECOVERY_SECONDS;
}

function equal(value: string, expected: string): boolean {
  const left = Buffer.from(value, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function stateUnavailable(): PublicOAuthError {
  return new PublicOAuthError('server_error', 'The OAuth service is temporarily unavailable.', 503);
}

function authorizationCodeUsed(): PublicOAuthError {
  return new PublicOAuthError(
    'invalid_grant',
    'The authorization code has already been used. Revoke the existing grant and reauthorize.',
  );
}

function authorizationCodeInProgress(): PublicOAuthError {
  return new PublicOAuthError(
    'temporarily_unavailable',
    'The authorization code is already being redeemed. Retry after the current exchange finishes.',
    503,
  );
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

  approval(
    id: string,
    expiresAt: number,
    expectedProofHash: string,
  ): { approvedAt: number; grantExpiresAt: number } | undefined {
    this.assertAvailable();
    let marker: ReplayMarker;
    try {
      marker = this.readMarker(this.markerPath('ticket', id, expiresAt));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      if (error instanceof PublicOAuthError) throw error;
      throw stateUnavailable();
    }
    if (
      marker.kind !== 'ticket'
      || marker.expiresAt !== expiresAt
      || typeof marker.approvalProofHash !== 'string'
      || typeof marker.approvedAt !== 'number'
      || !Number.isSafeInteger(marker.approvedAt)
      || typeof marker.grantExpiresAt !== 'number'
      || !Number.isSafeInteger(marker.grantExpiresAt)
      || marker.grantExpiresAt <= marker.approvedAt
      || !equal(marker.approvalProofHash, expectedProofHash)
    ) {
      throw new PublicOAuthError('invalid_request', 'The authorization request has already been used.');
    }
    return { approvedAt: marker.approvedAt, grantExpiresAt: marker.grantExpiresAt };
  }

  claimApproval(
    id: string,
    expiresAt: number,
    proofHash: string,
    approvedAt: number,
    grantExpiresAt: number,
  ): { approvedAt: number; grantExpiresAt: number } {
    const created = this.createMarker('ticket', id, expiresAt, {
      version: 1,
      kind: 'ticket',
      expiresAt,
      approvalProofHash: proofHash,
      approvedAt,
      grantExpiresAt,
    });
    if (created) return { approvedAt, grantExpiresAt };
    const existing = this.approval(id, expiresAt, proofHash);
    if (!existing) throw stateUnavailable();
    return existing;
  }

  claimRedemption(
    id: string,
    expiresAt: number,
    redemptionHash: string,
    allowInitialClaim: boolean,
    leaseSeconds: number,
  ): string {
    this.assertAvailable();
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) throw stateUnavailable();
    const ownerHash = createHash('sha256').update(randomBytes(32)).digest('hex');

    for (let transition = 0; transition < REDEMPTION_STATE_CHAIN_LIMIT; transition += 1) {
      const leaf = this.redemptionLeaf(id, expiresAt, redemptionHash);
      const now = nowSeconds();
      if (!leaf) {
        if (!allowInitialClaim || expiresAt <= now) {
          throw new PublicOAuthError('invalid_grant', 'The authorization code has expired.');
        }
        const marker = this.redemptionMarker('code', expiresAt, redemptionHash, 'owner', {
          ownerHash,
          claimedAt: now,
          claimExpiresAt: Math.min(expiresAt, now + leaseSeconds),
        });
        if (this.createMarker('code', id, expiresAt, marker)) return ownerHash;
        continue;
      }

      if (leaf.marker.redemptionState === 'complete') throw authorizationCodeUsed();
      if (
        leaf.marker.redemptionState === 'owner'
        && leaf.marker.claimExpiresAt! > now
      ) {
        throw authorizationCodeInProgress();
      }
      if (expiresAt <= now) {
        throw new PublicOAuthError('invalid_grant', 'The authorization code has expired.');
      }

      const marker = this.redemptionMarker('code-state', expiresAt, redemptionHash, 'owner', {
        previousStateId: leaf.marker.stateId,
        ownerHash,
        claimedAt: now,
        claimExpiresAt: Math.min(expiresAt, now + leaseSeconds),
      });
      if (this.createMarkerAt(
        this.redemptionSuccessorPath(id, expiresAt, leaf.marker.stateId!),
        expiresAt,
        marker,
      )) {
        return ownerHash;
      }
    }
    throw stateUnavailable();
  }

  releaseRedemption(
    id: string,
    expiresAt: number,
    redemptionHash: string,
    ownerHash: string,
  ): void {
    const leaf = this.redemptionLeaf(id, expiresAt, redemptionHash);
    if (
      !leaf
      || leaf.marker.redemptionState !== 'owner'
      || !equal(leaf.marker.ownerHash!, ownerHash)
    ) {
      return;
    }
    const marker = this.redemptionMarker('code-state', expiresAt, redemptionHash, 'available', {
      previousStateId: leaf.marker.stateId,
    });
    this.createMarkerAt(
      this.redemptionSuccessorPath(id, expiresAt, leaf.marker.stateId!),
      expiresAt,
      marker,
    );
  }

  completeRedemption(
    id: string,
    expiresAt: number,
    redemptionHash: string,
    ownerHash: string,
  ): void {
    const leaf = this.redemptionLeaf(id, expiresAt, redemptionHash);
    if (!leaf) throw stateUnavailable();
    if (leaf.marker.redemptionState === 'complete') throw authorizationCodeUsed();
    if (
      leaf.marker.redemptionState !== 'owner'
      || !equal(leaf.marker.ownerHash!, ownerHash)
    ) {
      throw authorizationCodeInProgress();
    }
    const marker = this.redemptionMarker('code-state', expiresAt, redemptionHash, 'complete', {
      previousStateId: leaf.marker.stateId,
    });
    if (this.createMarkerAt(
      this.redemptionSuccessorPath(id, expiresAt, leaf.marker.stateId!),
      expiresAt,
      marker,
    )) {
      return;
    }
    const raced = this.redemptionLeaf(id, expiresAt, redemptionHash);
    if (raced?.marker.redemptionState === 'complete') throw authorizationCodeUsed();
    throw authorizationCodeInProgress();
  }

  refreshResult(id: string, expiresAt: number): string | undefined {
    this.assertAvailable();
    let marker: ReplayMarker;
    try {
      marker = this.readMarker(this.markerPath('refresh-result', id, expiresAt));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      if (error instanceof PublicOAuthError) throw error;
      throw stateUnavailable();
    }
    if (
      marker.kind !== 'refresh-result'
      || marker.expiresAt !== expiresAt
      || typeof marker.result !== 'string'
    ) {
      throw stateUnavailable();
    }
    return marker.result;
  }

  claimRefreshResult(id: string, expiresAt: number, result: string): string {
    const created = this.createMarker('refresh-result', id, expiresAt, {
      version: 1,
      kind: 'refresh-result',
      expiresAt,
      result,
    });
    if (created) return result;
    const existing = this.refreshResult(id, expiresAt);
    if (!existing) throw stateUnavailable();
    return existing;
  }

  private redemptionLeaf(
    id: string,
    expiresAt: number,
    expectedHash: string,
  ): { marker: ReplayMarker } | undefined {
    this.assertAvailable();
    let marker: ReplayMarker;
    try {
      marker = this.readMarker(this.markerPath('code', id, expiresAt));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      if (error instanceof PublicOAuthError) throw error;
      throw stateUnavailable();
    }
    this.validateRedemptionMarker(marker, 'code', expiresAt, expectedHash);

    for (let transition = 0; transition < REDEMPTION_STATE_CHAIN_LIMIT; transition += 1) {
      const successorPath = this.redemptionSuccessorPath(id, expiresAt, marker.stateId!);
      let successor: ReplayMarker;
      try {
        successor = this.readMarker(successorPath);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return { marker };
        if (error instanceof PublicOAuthError) throw error;
        throw stateUnavailable();
      }
      this.validateRedemptionMarker(successor, 'code-state', expiresAt, expectedHash, marker.stateId);
      marker = successor;
    }
    throw stateUnavailable();
  }

  private validateRedemptionMarker(
    marker: ReplayMarker,
    kind: 'code' | 'code-state',
    expiresAt: number,
    expectedHash: string,
    previousStateId?: string,
  ): void {
    const state = marker.redemptionState;
    const ownerState = state === 'owner';
    if (
      marker.kind !== kind
      || marker.expiresAt !== expiresAt
      || typeof marker.redemptionHash !== 'string'
      || !equal(marker.redemptionHash, expectedHash)
      || !/^[a-f0-9]{64}$/.test(marker.stateId || '')
      || (kind === 'code' && marker.previousStateId !== undefined)
      || (kind === 'code-state' && marker.previousStateId !== previousStateId)
      || (state !== 'owner' && state !== 'available' && state !== 'complete')
      || (
        ownerState
          ? (
              !/^[a-f0-9]{64}$/.test(marker.ownerHash || '')
              || !Number.isSafeInteger(marker.claimedAt)
              || !Number.isSafeInteger(marker.claimExpiresAt)
              || marker.claimedAt! >= marker.claimExpiresAt!
              || marker.claimExpiresAt! > expiresAt
            )
          : (
              marker.ownerHash !== undefined
              || marker.claimedAt !== undefined
              || marker.claimExpiresAt !== undefined
            )
      )
    ) {
      throw authorizationCodeUsed();
    }
  }

  private redemptionMarker(
    kind: 'code' | 'code-state',
    expiresAt: number,
    redemptionHash: string,
    redemptionState: RedemptionState,
    fields: Pick<ReplayMarker, 'previousStateId' | 'ownerHash' | 'claimedAt' | 'claimExpiresAt'>,
  ): ReplayMarker {
    return {
      version: 1,
      kind,
      expiresAt,
      redemptionHash,
      redemptionState,
      stateId: createHash('sha256').update(randomBytes(32)).digest('hex'),
      ...fields,
    };
  }

  private createMarker(
    kind: ReplayKind,
    id: string,
    expiresAt: number,
    marker: ReplayMarker,
  ): boolean {
    return this.createMarkerAt(this.markerPath(kind, id, expiresAt), expiresAt, marker);
  }

  private createMarkerAt(
    markerPath: string,
    expiresAt: number,
    marker: ReplayMarker,
  ): boolean {
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
      writeFileSync(descriptor, `${JSON.stringify(marker)}\n`, { encoding: 'utf8' });
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

  private readMarker(path: string): ReplayMarker {
    for (let attempt = 0; attempt <= REPLAY_MARKER_READ_RETRIES; attempt += 1) {
      let descriptor: number | undefined;
      try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const state = fstatSync(descriptor);
        if (
          !state.isFile()
          || state.nlink !== 1
          || (state.mode & PERMISSION_MASK) !== PRIVATE_FILE_MODE
          || (typeof process.getuid === 'function' && state.uid !== process.getuid())
          || state.size < 1
          || state.size > 65_536
        ) {
          throw stateUnavailable();
        }
        const parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as ReplayMarker;
        if (
          !parsed
          || parsed.version !== 1
          || (
            parsed.kind !== 'ticket'
            && parsed.kind !== 'code'
            && parsed.kind !== 'code-state'
            && parsed.kind !== 'refresh-result'
          )
          || !Number.isSafeInteger(parsed.expiresAt)
        ) {
          throw stateUnavailable();
        }
        return parsed;
      } catch (error) {
        if (isErrno(error, 'ENOENT')) throw error;
        if (attempt === REPLAY_MARKER_READ_RETRIES) {
          if (error instanceof PublicOAuthError) throw error;
          throw stateUnavailable();
        }
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
    throw stateUnavailable();
  }

  private markerPath(kind: ReplayKind, id: string, expiresAt: number): string {
    const digest = createHash('sha256').update(`${kind}:${id}`, 'utf8').digest('hex');
    return join(this.bucketPath(expiresAt), `${kind}.${digest}`);
  }

  private redemptionSuccessorPath(id: string, expiresAt: number, stateId: string): string {
    const digest = createHash('sha256')
      .update(`code-state:${id}:${stateId}`, 'utf8')
      .digest('hex');
    return join(this.bucketPath(expiresAt), `code-state.${digest}`);
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

  private isAllowedResource(value: unknown): value is string {
    return value === PUBLIC_MCP_RESOURCE
      || (this.config.spalaAgentA2aResourceUrl !== null
        && value === this.config.spalaAgentA2aResourceUrl);
  }

  private requireAllowedResource(value: unknown, error = 'invalid_target'): string {
    if (!this.isAllowedResource(value)) {
      throw new PublicOAuthError(error, 'The OAuth resource is invalid.');
    }
    return value;
  }

  register(input: unknown): {
    clientId: string;
    clientSecret?: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: 'none' | 'client_secret_post';
    expiresAt: number;
  } {
    const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
    const values = record?.['redirect_uris'];
    if (!Array.isArray(values) || values.length < 1 || values.length > 16) {
      throw new PublicOAuthError('invalid_client_metadata', 'Provide between one and sixteen redirect_uris.');
    }
    const redirectUris = [...new Set(values.map(value => validateRedirectUri(requiredString(value, 'redirect_uri', 2_048))))];
    const tokenEndpointAuthMethod = record?.['token_endpoint_auth_method'] ?? 'none';
    if (tokenEndpointAuthMethod !== 'none' && tokenEndpointAuthMethod !== 'client_secret_post') {
      throw new PublicOAuthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method.');
    }
    const expiresAt = nowSeconds() + this.config.publicOAuthClientLifetimeSeconds;
    const clientSecret = tokenEndpointAuthMethod === 'client_secret_post' ? randomId() : undefined;
    const clientId = encrypt(this.config, {
      kind: 'client',
      clientId: randomId(),
      redirectUris,
      tokenEndpointAuthMethod,
      ...(clientSecret ? { clientSecretHash: sha256Base64Url(clientSecret) } : {}),
      expiresAt,
    });
    return { clientId, clientSecret, redirectUris, tokenEndpointAuthMethod, expiresAt };
  }

  private authenticateTokenClient(input: Record<string, unknown>): {
    clientId: string;
    registration: ClientRegistration;
  } {
    const clientId = requiredString(input['client_id'], 'client_id', 16_384);
    let registration: EncryptedPayload;
    try {
      registration = decrypt(this.config, clientId);
    } catch {
      throw new PublicOAuthError('invalid_client', 'The OAuth client is invalid.', 401);
    }
    if (registration.kind !== 'client') {
      throw new PublicOAuthError('invalid_client', 'The OAuth client is invalid.', 401);
    }
    const method = registration.tokenEndpointAuthMethod ?? 'none';
    if (method === 'client_secret_post') {
      let clientSecret: string;
      try {
        clientSecret = requiredString(input['client_secret'], 'client_secret', 512);
      } catch {
        throw new PublicOAuthError('invalid_client', 'The OAuth client is invalid.', 401);
      }
      if (
        typeof registration.clientSecretHash !== 'string'
        || !equal(sha256Base64Url(clientSecret), registration.clientSecretHash)
      ) {
        throw new PublicOAuthError('invalid_client', 'The OAuth client is invalid.', 401);
      }
    }
    return { clientId, registration };
  }

  createAuthorizationTicket(input: Record<string, unknown>): string {
    const clientId = requiredString(input['client_id'], 'client_id', 16_384);
    let registration: EncryptedPayload;
    try {
      registration = decrypt(this.config, clientId);
    } catch {
      throw new PublicOAuthError('invalid_client', 'The OAuth client is invalid.', 401);
    }
    if (registration.kind !== 'client') throw new PublicOAuthError('invalid_client', 'The OAuth client is invalid.', 401);
    const redirectUri = validateRedirectUri(requiredString(input['redirect_uri'], 'redirect_uri', 2_048));
    if (!registration.redirectUris.includes(redirectUri)) {
      throw new PublicOAuthError('invalid_request', 'The redirect_uri is not registered for this client.');
    }
    if (input['response_type'] !== 'code') throw new PublicOAuthError('unsupported_response_type', 'Only authorization code flow is supported.');
    const resource = this.requireAllowedResource(input['resource']);
    if (input['scope'] !== PUBLIC_MCP_SCOPE) {
      throw new PublicOAuthError('invalid_scope', `The OAuth scope must be ${PUBLIC_MCP_SCOPE}.`);
    }
    if (input['code_challenge_method'] !== 'S256') throw new PublicOAuthError('invalid_request', 'PKCE S256 is required.');
    const codeChallenge = requiredString(input['code_challenge'], 'code_challenge', 128);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) throw new PublicOAuthError('invalid_request', 'Invalid code_challenge.');
    const state = requiredString(input['state'], 'state', 2_048);
    return encrypt(this.config, {
      kind: 'ticket',
      ticketId: randomId(),
      clientId,
      redirectUri,
      state,
      codeChallenge,
      resource,
      scope: PUBLIC_MCP_SCOPE,
      expiresAt: nowSeconds() + this.config.publicOAuthTicketLifetimeSeconds,
    });
  }

  authorizationErrorRedirect(input: Record<string, unknown>, error: unknown): string | undefined {
    let redirectUri: string;
    try {
      const clientId = requiredString(input['client_id'], 'client_id', 16_384);
      const registration = decrypt(this.config, clientId);
      if (registration.kind !== 'client') return undefined;
      redirectUri = validateRedirectUri(requiredString(input['redirect_uri'], 'redirect_uri', 2_048));
      if (!registration.redirectUris.includes(redirectUri)) return undefined;
    } catch {
      return undefined;
    }
    const oauthError = error instanceof PublicOAuthError
      ? error
      : new PublicOAuthError('server_error', 'The OAuth service is temporarily unavailable.', 503);
    const callback = new URL(redirectUri);
    callback.searchParams.set('error', oauthError.error);
    callback.searchParams.set('error_description', oauthError.message);
    const state = input['state'];
    if (typeof state === 'string' && state.length > 0 && state.length <= 2_048 && !/[\0\r\n]/.test(state)) {
      callback.searchParams.set('state', state);
    }
    return callback.toString();
  }

  prepareApproval(ticketValue: string, approvalProofValue: string): PreparedApproval {
    const ticket = decrypt(this.config, ticketValue, true);
    if (ticket.kind !== 'ticket') throw new PublicOAuthError('invalid_request', 'The authorization request is invalid.');
    const approvalProof = requiredString(approvalProofValue, 'approval proof', 16_384);
    if (/\s/.test(approvalProof)) throw new PublicOAuthError('invalid_request', 'Invalid approval proof.');
    const proofHash = requestFingerprint(this.config, 'approval-proof-v1', [ticketValue, approvalProof]);
    const existing = this.replayStore.approval(
      ticket.ticketId,
      approvalReplayExpiresAt(ticket.expiresAt),
      proofHash,
    );
    if (!existing && ticket.expiresAt <= nowSeconds()) {
      throw new PublicOAuthError('invalid_request', 'The OAuth request has expired.');
    }
    return {
      ticket,
      proofHash,
      clientHash: publicMcpClientHash(ticket.clientId),
    };
  }

  approve(
    approval: PreparedApproval,
    platformGrantCode: string,
    platformGrantExpiresIn: number,
  ): { callbackUrl: string } {
    const { ticket, proofHash } = approval;
    const grantCode = requiredString(platformGrantCode, 'platform grant code', 16_384);
    const approvedNow = nowSeconds();
    if (
      /\s/.test(grantCode)
      || !Number.isSafeInteger(platformGrantExpiresIn)
      || platformGrantExpiresIn < 1
      || platformGrantExpiresIn > 86_400
    ) {
      throw new PublicOAuthError('invalid_request', 'Invalid platform grant code.');
    }
    const markerExpiresAt = approvalReplayExpiresAt(ticket.expiresAt);
    const { approvedAt, grantExpiresAt } = this.replayStore.claimApproval(
      ticket.ticketId,
      markerExpiresAt,
      proofHash,
      approvedNow,
      approvedNow + platformGrantExpiresIn,
    );
    const code = encryptDeterministic(this.config, {
      ...ticket,
      kind: 'code',
      codeId: requestFingerprint(this.config, 'authorization-code-id-v1', [ticket.ticketId, proofHash]),
      platformGrantCode: grantCode,
      retryExpiresAt: grantExpiresAt,
      expiresAt: Math.min(
        approvedAt + this.config.publicOAuthCodeLifetimeSeconds,
        grantExpiresAt,
      ),
    }, 'authorization-code', 'v1d');
    return { callbackUrl: this.callbackUrl(ticket, code) };
  }

  async redeem(
    input: Record<string, unknown>,
    exchange: (grant: {
      platformGrantCode: string;
      clientHash: string;
    }) => Promise<PublicOAuthTokenSet>,
    isRetryableExchangeError: (error: unknown) => boolean = () => true,
  ): Promise<{
    tokenSet: PublicOAuthTokenSet;
    clientId: string;
    clientHash: string;
    resource: string;
    complete: () => void;
  }> {
    if (input['grant_type'] !== 'authorization_code') throw new PublicOAuthError('unsupported_grant_type', 'Only authorization_code is supported.');
    const codeValue = requiredString(input['code'], 'code', 16_384);
    const code = decrypt(this.config, codeValue, true);
    if (code.kind !== 'code') throw new PublicOAuthError('invalid_grant', 'The authorization code is invalid.');
    const { clientId } = this.authenticateTokenClient(input);
    const redirectUri = input['redirect_uri'] === undefined
      ? code.redirectUri
      : validateRedirectUri(requiredString(input['redirect_uri'], 'redirect_uri', 2_048));
    const verifier = requiredString(input['code_verifier'], 'code_verifier', 128);
    const requestedResource = input['resource'];
    if (
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
      || (requestedResource !== undefined && requestedResource !== code.resource)
      || !equal(clientId, code.clientId)
      || redirectUri !== code.redirectUri
      || !equal(sha256Base64Url(verifier), code.codeChallenge)
    ) {
      throw new PublicOAuthError('invalid_grant', 'The authorization code cannot be redeemed.');
    }
    const bindingHash = publicMcpClientHash(code.clientId);
    const redemptionHash = requestFingerprint(this.config, 'authorization-code-redemption', [
      codeValue,
      bindingHash,
      redirectUri,
      sha256Base64Url(verifier),
      code.resource,
    ]);
    const redemptionExpiresAt = code.retryExpiresAt;
    if (
      !Number.isSafeInteger(redemptionExpiresAt)
      || redemptionExpiresAt < code.expiresAt
      || redemptionExpiresAt > code.expiresAt + 86_400
    ) {
      throw new PublicOAuthError('invalid_grant', 'The authorization code is invalid.');
    }
    if (redemptionExpiresAt <= nowSeconds()) {
      throw new PublicOAuthError('invalid_grant', 'The authorization code has expired.');
    }
    const ownerHash = this.replayStore.claimRedemption(
      code.codeId,
      redemptionExpiresAt,
      redemptionHash,
      code.expiresAt > nowSeconds(),
      Math.ceil(this.config.publicMcpPlatformTimeoutMs / 1_000) + REDEMPTION_LEASE_SAFETY_SECONDS,
    );
    let tokenSet: PublicOAuthTokenSet;
    try {
      tokenSet = await exchange({
        platformGrantCode: code.platformGrantCode,
        clientHash: bindingHash,
      });
    } catch (error) {
      try {
        if (isRetryableExchangeError(error)) {
          this.replayStore.releaseRedemption(
            code.codeId,
            redemptionExpiresAt,
            redemptionHash,
            ownerHash,
          );
        } else {
          this.replayStore.completeRedemption(
            code.codeId,
            redemptionExpiresAt,
            redemptionHash,
            ownerHash,
          );
        }
      } catch {
        // Preserve the upstream result; ownership transitions fail closed on the next redemption.
      }
      throw error;
    }
    return {
      tokenSet,
      clientId: code.clientId,
      clientHash: bindingHash,
      resource: code.resource,
      complete: () => this.replayStore.completeRedemption(
        code.codeId,
        redemptionExpiresAt,
        redemptionHash,
        ownerHash,
      ),
    };
  }

  validateRefresh(input: Record<string, unknown>): {
    refreshToken: string;
    clientId: string;
    clientHash: string;
    resultId: string;
    resultExpiresAt: number;
    resource: string;
  } {
    if (input['grant_type'] !== 'refresh_token') throw new PublicOAuthError('unsupported_grant_type', 'Unsupported OAuth grant type.');
    const refreshToken = requiredString(input['refresh_token'], 'refresh_token', 16_384);
    if (/\s/.test(refreshToken)) throw new PublicOAuthError('invalid_grant', 'The refresh token is invalid.');
    const { clientId } = this.authenticateTokenClient(input);
    if (input['scope'] !== undefined && input['scope'] !== PUBLIC_MCP_SCOPE) {
      throw new PublicOAuthError('invalid_scope', `The OAuth scope must be ${PUBLIC_MCP_SCOPE}.`);
    }
    const clientHash = publicMcpClientHash(clientId);
    const delegated = this.readDelegatedRefreshToken(refreshToken, false);
    if (
      !equal(delegated.clientHash, clientHash)
      || (input['resource'] !== undefined && input['resource'] !== delegated.resource)
    ) {
      throw new PublicOAuthError('invalid_grant', 'The refresh token cannot be redeemed.');
    }
    return {
      refreshToken: delegated.platformRefreshToken,
      clientId,
      clientHash,
      resultId: requestFingerprint(this.config, 'refresh-result-v1', [
        refreshToken,
        clientHash,
        delegated.resource,
        PUBLIC_MCP_SCOPE,
      ]),
      resultExpiresAt: delegated.expiresAt,
      resource: delegated.resource,
    };
  }

  wrapRefreshTokenSet(
    tokenSet: PublicOAuthTokenSet,
    refresh: ReturnType<PublicOAuthFacade['validateRefresh']>,
  ): PublicOAuthClientTokenSet {
    const wrapped = this.wrapTokenSet(tokenSet, refresh.clientId, refresh.resource);
    const cacheExpiresAt = Math.min(
      refresh.resultExpiresAt,
      nowSeconds() + REFRESH_RESULT_CACHE_SECONDS,
    );
    const stored = this.replayStore.claimRefreshResult(
      refresh.resultId,
      refresh.resultExpiresAt,
      encrypt(this.config, {
        kind: 'refresh-result',
        requestHash: refresh.resultId,
        clientHash: refresh.clientHash,
        accessToken: wrapped.accessToken,
        refreshToken: wrapped.refreshToken,
        expiresIn: wrapped.expiresIn,
        expiresAt: cacheExpiresAt,
      }),
    );
    let result: EncryptedPayload;
    try {
      result = decrypt(this.config, stored);
    } catch {
      throw stateUnavailable();
    }
    if (
      result.kind !== 'refresh-result'
      || !equal(result.requestHash, refresh.resultId)
      || !equal(result.clientHash, refresh.clientHash)
      || !equal(result.accessToken, wrapped.accessToken)
      || !equal(result.refreshToken, wrapped.refreshToken)
      || !result.accessToken.startsWith('v1a.')
      || !result.refreshToken.startsWith('v1r.')
      || !Number.isSafeInteger(result.expiresIn)
      || result.expiresIn < 1
      || result.expiresIn > 86_400
    ) {
      throw stateUnavailable();
    }
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    };
  }

  validateRevocation(input: Record<string, unknown>): {
    token?: string;
    clientHash: string;
    tokenTypeHint?: 'access_token' | 'refresh_token';
  } {
    let token: string | undefined = requiredString(input['token'], 'token', 16_384);
    if (/\s/.test(token)) throw new PublicOAuthError('invalid_request', 'Invalid token.');
    const clientId = requiredString(input['client_id'], 'client_id', 16_384);
    const registration = decrypt(this.config, clientId);
    if (registration.kind !== 'client') throw new PublicOAuthError('invalid_client', 'The OAuth client is invalid.', 401);
    const hint = input['token_type_hint'];
    if (hint !== undefined && hint !== 'access_token' && hint !== 'refresh_token') {
      throw new PublicOAuthError('unsupported_token_type', 'Unsupported token_type_hint.');
    }
    const bindingHash = publicMcpClientHash(clientId);
    if (token.startsWith('v1a.')) {
      const delegated = this.readDelegatedAccessToken(token, true);
      if (!equal(delegated.clientHash, bindingHash)) {
        throw new PublicOAuthError('invalid_client', 'The OAuth client is invalid.', 401);
      }
      token = delegated.platformAccessToken;
    } else if (token.startsWith('v1r.')) {
      const delegated = this.readDelegatedRefreshToken(token, true);
      if (!equal(delegated.clientHash, bindingHash)) {
        throw new PublicOAuthError('invalid_client', 'The OAuth client is invalid.', 401);
      }
      token = delegated.platformRefreshToken;
    } else {
      token = undefined;
    }
    return {
      token,
      clientHash: bindingHash,
      tokenTypeHint: hint,
    };
  }

  wrapTokenSet(
    tokenSet: PublicOAuthTokenSet,
    clientIdValue: string,
    resourceValue: string = PUBLIC_MCP_RESOURCE,
  ): PublicOAuthClientTokenSet {
    const clientId = requiredString(clientIdValue, 'client_id', 16_384);
    const registration = decrypt(this.config, clientId);
    if (registration.kind !== 'client') throw new PublicOAuthError('invalid_grant', 'The OAuth client is invalid.');
    const resource = this.requireAllowedResource(resourceValue, 'invalid_grant');
    const platformAccessToken = requiredString(tokenSet.accessToken, 'platform access token', 8_192);
    const refreshToken = requiredString(tokenSet.refreshToken, 'refresh token', 16_384);
    const currentTime = nowSeconds();
    const accessExpiresAt = tokenSet.accessExpiresAt ?? currentTime + tokenSet.expiresIn;
    if (
      /\s/.test(platformAccessToken)
      || /\s/.test(refreshToken)
      || platformAccessToken === refreshToken
      || !Number.isSafeInteger(tokenSet.expiresIn)
      || tokenSet.expiresIn < 1
      || tokenSet.expiresIn > 86_400
      || !Number.isSafeInteger(accessExpiresAt)
      || accessExpiresAt <= currentTime
      || accessExpiresAt > currentTime + 86_401
    ) {
      throw new PublicOAuthError('server_error', 'The OAuth service is temporarily unavailable.', 503);
    }
    return {
      accessToken: encryptDeterministic(this.config, {
        kind: 'delegated-access',
        platformAccessToken,
        clientHash: publicMcpClientHash(clientId),
        resource,
        scope: PUBLIC_MCP_SCOPE,
        expiresAt: accessExpiresAt,
      }, 'delegated-access', 'v1a') as `v1a.${string}`,
      refreshToken: encryptDeterministic(this.config, {
        kind: 'delegated-refresh',
        platformRefreshToken: refreshToken,
        clientHash: publicMcpClientHash(clientId),
        resource,
        scope: PUBLIC_MCP_SCOPE,
        expiresAt: registration.expiresAt,
      }, 'delegated-refresh', 'v1r') as `v1r.${string}`,
      expiresIn: tokenSet.expiresIn,
    };
  }

  delegatedAccessToken(value: string): { platformAccessToken: string; clientHash: string; resource: string } {
    return this.readDelegatedAccessToken(value, false);
  }

  private readDelegatedAccessToken(
    value: string,
    allowExpired: boolean,
  ): { platformAccessToken: string; clientHash: string; resource: string } {
    let token: EncryptedPayload;
    try {
      token = decrypt(this.config, value, allowExpired);
    } catch {
      throw new PublicOAuthError('invalid_token', 'The MCP access token is invalid or expired.', 401);
    }
    if (
      !value.startsWith('v1a.')
      || token.kind !== 'delegated-access'
      || !this.isAllowedResource(token.resource)
      || token.scope !== PUBLIC_MCP_SCOPE
      || !/^[a-f0-9]{64}$/.test(token.clientHash)
      || typeof token.platformAccessToken !== 'string'
      || !token.platformAccessToken
      || token.platformAccessToken.length > 8_192
      || /\s/.test(token.platformAccessToken)
    ) {
      throw new PublicOAuthError('invalid_token', 'The MCP access token is invalid or expired.', 401);
    }
    return {
      platformAccessToken: token.platformAccessToken,
      clientHash: token.clientHash,
      resource: token.resource,
    };
  }

  private readDelegatedRefreshToken(
    value: string,
    allowExpired: boolean,
  ): { platformRefreshToken: string; clientHash: string; resource: string; expiresAt: number } {
    let token: EncryptedPayload;
    try {
      token = decrypt(this.config, value, allowExpired);
    } catch {
      throw new PublicOAuthError('invalid_grant', 'The refresh token is invalid or expired.');
    }
    if (
      !value.startsWith('v1r.')
      || token.kind !== 'delegated-refresh'
      || !this.isAllowedResource(token.resource)
      || token.scope !== PUBLIC_MCP_SCOPE
      || !/^[a-f0-9]{64}$/.test(token.clientHash)
      || typeof token.platformRefreshToken !== 'string'
      || !token.platformRefreshToken
      || token.platformRefreshToken.length > 16_384
      || /\s/.test(token.platformRefreshToken)
    ) {
      throw new PublicOAuthError('invalid_grant', 'The refresh token is invalid or expired.');
    }
    return {
      platformRefreshToken: token.platformRefreshToken,
      clientHash: token.clientHash,
      resource: token.resource,
      expiresAt: token.expiresAt,
    };
  }

  private callbackUrl(ticket: AuthorizationTicket, code: string): string {
    const callback = new URL(ticket.redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', ticket.state);
    return callback.toString();
  }
}
