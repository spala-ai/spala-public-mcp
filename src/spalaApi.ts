import { isIP } from 'node:net';
import type { AppConfig } from './config.js';

export type SpalaUser = {
  id: string;
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
};

export type SpalaOrganization = {
  id: string;
  name?: string;
};

export type SpalaPrincipal = {
  subject: string;
  user: SpalaUser;
  organizations: SpalaOrganization[];
};

export type SpalaProject = {
  id: string;
  name: string;
  status: string;
  subdomain: string;
  organizationId?: string;
};

export type ProjectMcpHandoff = {
  projectId: string;
  projectName: string;
  status: string;
  projectUrl: string;
  mcpEnabled: boolean;
  mcpUrl?: string;
  manifestUrl?: string;
};

export type PreparedProjectMcpHandoff = ProjectMcpHandoff & {
  bootstrapConsumeUrl: string;
};

export type ProjectOrganizationInput = {
  organizationId?: string;
};

export type CreateProjectInput = ProjectOrganizationInput & {
  name: string;
};

export type SetupAccountInput = {
  firstName?: string;
  lastName?: string;
  companyName?: string;
};

export type SetupAccountResult = {
  principal: SpalaPrincipal;
  organization: SpalaOrganization;
  profileUpdated: boolean;
  organizationCreated: boolean;
};

export type CreateOrganizationInput = {
  name: string;
};

export type SpalaApiClient = {
  getPrincipal(): Promise<SpalaPrincipal>;
  setupAccount(input: SetupAccountInput): Promise<SetupAccountResult>;
  createOrganization(input: CreateOrganizationInput): Promise<SpalaOrganization>;
  listProjects(input?: ProjectOrganizationInput): Promise<{ organization: SpalaOrganization; projects: SpalaProject[] }>;
  createProject(input: CreateProjectInput): Promise<{ organization: SpalaOrganization; project: SpalaProject }>;
  getProjectHandoff(projectId: string): Promise<ProjectMcpHandoff>;
  prepareProjectMcp(projectId: string, client: 'codex' | 'roo'): Promise<PreparedProjectMcpHandoff>;
};

export type SpalaApiErrorCategory =
  | 'authentication'
  | 'insufficient_scope'
  | 'forbidden'
  | 'organization_selection_required'
  | 'payment_required'
  | 'plan_restricted'
  | 'not_found'
  | 'upstream_unavailable'
  | 'invalid_upstream_response'
  | 'request_failed';

export class SpalaApiError extends Error {
  readonly category: SpalaApiErrorCategory;
  readonly status?: number;
  readonly code?: string;
  readonly checkoutUrl?: string;
  readonly organizationChoices?: SpalaOrganization[];

  constructor(options: {
    category: SpalaApiErrorCategory;
    message: string;
    status?: number;
    code?: string;
    checkoutUrl?: string;
    organizationChoices?: SpalaOrganization[];
  }) {
    super(options.message);
    this.name = 'SpalaApiError';
    this.category = options.category;
    this.status = options.status;
    this.code = options.code;
    this.checkoutUrl = options.checkoutUrl;
    this.organizationChoices = options.organizationChoices?.map(organization => ({ ...organization }));
  }
}

type FetchLike = typeof fetch;


function stringField(record: Record<string, unknown>, key: string, maximum = 256): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : undefined;
}

function ipv4Octets(value: string): number[] | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map(part => Number(part));
  return octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? octets : undefined;
}

function isForbiddenIpv4(octets: number[]): boolean {
  return octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    octets[0] === 169 && octets[1] === 254 ||
    octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 ||
    octets[0] === 192 && octets[1] === 168 ||
    octets[0] >= 224;
}

function ipv4MappedOctets(normalizedIpv6: string): number[] | undefined {
  if (!normalizedIpv6.startsWith('::ffff:')) return undefined;
  const mapped = normalizedIpv6.slice('::ffff:'.length);
  const dotted = ipv4Octets(mapped);
  if (dotted) return dotted;

  const groups = mapped.split(':');
  if (groups.length !== 2) return undefined;
  const values = groups.map(group => Number.parseInt(group, 16));
  if (!values.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffff)) return undefined;
  return [values[0] >> 8, values[0] & 0xff, values[1] >> 8, values[1] & 0xff];
}

function isForbiddenHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1' || normalized.endsWith('.localhost')) return true;

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = ipv4Octets(normalized);
    return !octets || isForbiddenIpv4(octets);
  }
  if (ipVersion === 6) {
    if (normalized === '::') return true;
    const mapped = ipv4MappedOctets(normalized);
    if (mapped) return isForbiddenIpv4(mapped);
    return normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb');
  }

  return false;
}

function hasValidProjectScopeQuery(url: URL): boolean {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1) return false;
  const [key, value] = entries[0]!;
  if (key !== 'scope') return false;

  const scopes = value.split(',');
  const allowedScopes = new Set(['builder', 'project', 'data']);
  return scopes.length > 0
    && scopes.every(scope => scope.length > 0 && allowedScopes.has(scope))
    && new Set(scopes).size === scopes.length;
}

function parsePublicHttpsUrl(value: unknown, options: { allowProjectScope?: boolean; requireCanonical?: boolean } = {}): string | undefined {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 2_048) return undefined;
  const raw = value;
  if (/\/(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(raw)) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined;
  if (url.search) {
    if (!options.allowProjectScope || !hasValidProjectScopeQuery(url)) return undefined;
  }
  if (!url.hostname || isForbiddenHostname(url.hostname)) return undefined;
  if (url.pathname.includes('//') || /%2f|%5c/i.test(url.pathname)) return undefined;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (decodedPath.split('/').some(segment => segment === '.' || segment === '..')) return undefined;

  if (options.requireCanonical && url.toString() !== raw) return undefined;
  return raw;
}

/** Accept only a complete public HTTPS MCP endpoint explicitly returned by the platform. */
export function parseProjectMcpUrl(value: unknown): string | undefined {
  const parsed = parsePublicHttpsUrl(value, { allowProjectScope: true, requireCanonical: true });
  if (!parsed) return undefined;
  const url = new URL(parsed);
  if (!/\/mcp\/?$/.test(url.pathname)) return undefined;
  return parsed;
}

/** Parse only the documented project list/create fields. */
export function parseProjectRecord(raw: unknown): SpalaProject | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = stringField(record, 'id');
  const name = stringField(record, 'project_name');
  const status = stringField(record, 'status', 128);
  const subdomain = stringField(record, 'subdomain');
  if (!id || !name || !status || !subdomain) return undefined;
  return { id, name, status, subdomain };
}

export function parseProjectHandoff(raw: unknown): ProjectMcpHandoff | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const projectId = stringField(record, 'projectId');
  const projectName = stringField(record, 'projectName');
  const status = stringField(record, 'status', 128);
  const projectUrl = parsePublicHttpsUrl(record['projectUrl']);
  const mcpEnabled = record['mcpEnabled'];
  if (!projectId || !projectName || !status || !projectUrl || typeof mcpEnabled !== 'boolean') return undefined;

  const mcpUrl = record['mcpUrl'] == null ? undefined : parseProjectMcpUrl(record['mcpUrl']);
  const manifestUrl = record['manifestUrl'] == null
    ? undefined
    : parsePublicHttpsUrl(record['manifestUrl'], { allowProjectScope: true, requireCanonical: true });
  if (record['mcpUrl'] != null && !mcpUrl) return undefined;
  if (record['manifestUrl'] != null && !manifestUrl) return undefined;
  if (mcpEnabled && (!mcpUrl || !manifestUrl)) return undefined;
  return { projectId, projectName, status, projectUrl, mcpEnabled, mcpUrl, manifestUrl };
}

function parseOrganization(raw: unknown): SpalaOrganization | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = stringField(record, 'id') ?? stringField(record, 'organization_id');
  if (!id) return undefined;
  return { id, name: stringField(record, 'name') ?? stringField(record, 'organization_name') };
}

function parsePrincipal(raw: unknown): SpalaPrincipal | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const userRaw = record['user'];
  const organizationsRaw = record['organizations'];
  if (!userRaw || typeof userRaw !== 'object' || Array.isArray(userRaw) || !Array.isArray(organizationsRaw)) return undefined;
  const userRecord = userRaw as Record<string, unknown>;
  const id = stringField(userRecord, 'id');
  if (!id) return undefined;
  const organizations = organizationsRaw.map(parseOrganization);
  if (organizations.some(organization => !organization)) return undefined;
  const user: SpalaUser = {
    id,
    email: stringField(userRecord, 'email', 320),
    name: stringField(userRecord, 'name'),
    firstName: stringField(userRecord, 'first_name') ?? stringField(userRecord, 'firstName'),
    lastName: stringField(userRecord, 'last_name') ?? stringField(userRecord, 'lastName'),
  };
  return { subject: id, user, organizations: organizations as SpalaOrganization[] };
}

function parseProjectCollection(raw: unknown): SpalaProject[] | undefined {
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as Record<string, unknown>)['projects'])
      ? (raw as Record<string, unknown>)['projects'] as unknown[]
      : undefined;
  if (!values) return undefined;
  const projects = values.map(parseProjectRecord);
  return projects.some(project => !project) ? undefined : projects as SpalaProject[];
}

function parseCreatedProject(raw: unknown): SpalaProject | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return parseProjectRecord(record['project'] ?? record);
}

function parseCreatedOrganization(raw: unknown): SpalaOrganization | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return parseOrganization(record['organization'] ?? record['data'] ?? record);
}

function normalizedCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 128);
  return normalized || undefined;
}

function safeErrorPayload(raw: unknown, sensitiveTokens: readonly string[]): {
  code?: string;
  message?: string;
  checkoutUrl?: string;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const nested = record['error'];
  const nestedRecord = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : undefined;
  const containsSensitiveToken = (value: string): boolean => sensitiveTokens.some(token => token && value.includes(token));
  const rawCode = typeof nested === 'string' ? nested : nestedRecord?.['code'] ?? record['code'];
  const code = typeof rawCode === 'string' && !containsSensitiveToken(rawCode)
    ? normalizedCode(rawCode)
    : undefined;
  const rawMessage = (nestedRecord ? stringField(nestedRecord, 'message', 1_000) : undefined)
    ?? stringField(record, 'message', 1_000);
  const message = rawMessage
    ? sensitiveTokens.reduce((value, token) => token ? value.split(token).join('[redacted]') : value, rawMessage)
    : undefined;
  const rawCheckoutUrl = nestedRecord?.['checkoutUrl'] ?? nestedRecord?.['checkout_url'] ?? record['checkoutUrl'] ?? record['checkout_url'];
  const checkoutUrl = typeof rawCheckoutUrl === 'string' && !containsSensitiveToken(rawCheckoutUrl)
    ? parsePublicHttpsUrl(rawCheckoutUrl)
    : undefined;
  return { code, message, checkoutUrl };
}

function errorCategory(status: number, code?: string, message?: string): SpalaApiErrorCategory {
  if (status === 401) return 'authentication';
  if (status === 402) return 'payment_required';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'upstream_unavailable';
  if (/(?:free[ _-]?plan|plan[ _-]?restricted|payment|billing|subscription|upgrade|quota)/i.test(`${code || ''} ${message || ''}`)) {
    return 'plan_restricted';
  }
  if (status === 403) return 'forbidden';
  return 'request_failed';
}

function defaultErrorMessage(category: SpalaApiErrorCategory): string {
  if (category === 'authentication') return 'The Spala MCP access token is invalid or expired.';
  if (category === 'insufficient_scope') return 'The Spala MCP access token does not include the required api scope.';
  if (category === 'organization_selection_required') return 'Select an organization before continuing.';
  if (category === 'payment_required' || category === 'plan_restricted') return 'This operation requires an eligible Spala plan or completed payment.';
  if (category === 'forbidden') return 'The authenticated user is not allowed to perform this project operation.';
  if (category === 'not_found') return 'The requested Spala resource was not found.';
  if (category === 'upstream_unavailable') return 'The Spala control plane is temporarily unavailable.';
  return 'The Spala control-plane request failed.';
}

async function readBoundedResponseBody(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SpalaApiError({
      category: 'invalid_upstream_response',
      status: response.status,
      code: 'upstream_response_too_large',
      message: 'The Spala control plane returned a response that exceeds the allowed size.',
    });
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
        throw new SpalaApiError({
          category: 'invalid_upstream_response',
          status: response.status,
          code: 'upstream_response_too_large',
          message: 'The Spala control plane returned a response that exceeds the allowed size.',
        });
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

function validBearerToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8_192 && !/\s/.test(value);
}

type ProjectAccess = {
  projectUrl: string;
  token: string;
};

function parseProjectBaseUrl(value: unknown): string | undefined {
  const parsed = parsePublicHttpsUrl(value);
  if (!parsed) return undefined;
  const url = new URL(parsed);
  if (url.search || url.hash) return undefined;
  return url.toString().replace(/\/$/, '');
}

function decodeBase64Url(value: string): string | undefined {
  if (!value || value.length > 4_096 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const canonicalInput = value.replace(/=+$/, '');
    const canonicalOutput = Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '');
    return canonicalInput === canonicalOutput ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function parseProjectAccess(raw: unknown, expectedProjectUrlValue: string): ProjectAccess | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const data = record['data'];
  const dataRecord = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const candidates = [
    stringField(record, 'url', 16_384),
    stringField(record, 'accessUrl', 16_384),
    dataRecord ? stringField(dataRecord, 'url', 16_384) : undefined,
  ].filter((value): value is string => Boolean(value));
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length !== 1) return undefined;
  const accessUrlValue = uniqueCandidates[0]!;

  let accessUrl: URL;
  try {
    accessUrl = new URL(accessUrlValue);
  } catch {
    return undefined;
  }
  if (
    accessUrl.origin !== 'https://app.spala.ai'
    || accessUrl.pathname !== '/'
    || accessUrl.hash
    || accessUrl.username
    || accessUrl.password
  ) return undefined;
  const entries = [...accessUrl.searchParams.entries()];
  if (entries.length !== 2 || new Set(entries.map(([key]) => key)).size !== 2) return undefined;
  if (!accessUrl.searchParams.has('url') || !accessUrl.searchParams.has('auth_token')) return undefined;

  const encodedProjectUrl = accessUrl.searchParams.get('url');
  const token = accessUrl.searchParams.get('auth_token');
  if (!encodedProjectUrl || !validBearerToken(token)) return undefined;
  const decodedProjectUrl = decodeBase64Url(encodedProjectUrl);
  const projectUrl = parseProjectBaseUrl(decodedProjectUrl);
  const expectedProjectUrl = parseProjectBaseUrl(expectedProjectUrlValue);
  if (!projectUrl || !expectedProjectUrl || projectUrl !== expectedProjectUrl) return undefined;
  return { projectUrl, token };
}

function parseAgentInstructionBootstrap(raw: unknown, projectUrl: string): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const consumeUrlValue = stringField(raw as Record<string, unknown>, 'consumeUrl', 4_096);
  const consumeUrl = parsePublicHttpsUrl(consumeUrlValue, { requireCanonical: true });
  if (!consumeUrl) return undefined;
  const parsed = new URL(consumeUrl);
  const expectedPrefix = `${projectUrl}/mcp/agent-instructions/`;
  if (!consumeUrl.startsWith(expectedPrefix) || !parsed.pathname.endsWith('/consume')) return undefined;
  return consumeUrl;
}

function rethrowProjectStage(error: unknown, code: string): never {
  if (error instanceof SpalaApiError) {
    throw new SpalaApiError({
      category: error.category,
      status: error.status,
      code,
      message: error.message,
      checkoutUrl: error.checkoutUrl,
      organizationChoices: error.organizationChoices,
    });
  }
  throw error;
}

export function createSpalaApiClient(
  config: AppConfig,
  controlPlaneAccessToken: string,
  fetchImpl: FetchLike = fetch,
): SpalaApiClient {
  if (!validBearerToken(controlPlaneAccessToken)) {
    throw new SpalaApiError({ category: 'authentication', message: 'The Spala MCP access token is invalid.' });
  }

  let principalPromise: Promise<SpalaPrincipal> | undefined;

  const requestJson = async (method: 'GET' | 'POST' | 'PATCH', pathname: string, options?: {
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  }): Promise<unknown> => {
    const url = new URL(pathname, config.spalaApiBaseUrl);
    for (const [key, value] of Object.entries(options?.query || {})) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${controlPlaneAccessToken}`,
          ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
        },
        body: options?.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
      });
      const bodyText = await readBoundedResponseBody(response, config.spalaApiResponseLimitBytes);
      let payload: unknown;
      try {
        payload = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        if (response.ok) {
          throw new SpalaApiError({
            category: 'invalid_upstream_response',
            status: response.status,
            message: 'The Spala control plane returned an invalid response.',
          });
        }
      }

      if (!response.ok) {
        const parsed = safeErrorPayload(payload, [controlPlaneAccessToken]);
        const category = errorCategory(response.status, parsed.code, parsed.message);
        throw new SpalaApiError({
          category,
          status: response.status,
          code: parsed.code,
          message: parsed.message || defaultErrorMessage(category),
          checkoutUrl: parsed.checkoutUrl,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof SpalaApiError) throw error;
      throw new SpalaApiError({
        category: 'upstream_unavailable',
        message: 'The Spala control plane is temporarily unavailable.',
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const requestProjectJson = async (
    projectUrl: string,
    projectAccessToken: string,
    method: 'POST',
    pathname: '/api/__internal/builder-auth/external' | '/api/__internal/project/config' | '/mcp/agent-instructions',
    body?: Record<string, unknown>,
    options: { authorization?: boolean; sensitiveTokens?: string[] } = {},
  ): Promise<unknown> => {
    const url = new URL(`${projectUrl}${pathname}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          ...(options.authorization === false ? {} : { authorization: `Bearer ${projectAccessToken}` }),
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
      });
      const bodyText = await readBoundedResponseBody(response, config.spalaApiResponseLimitBytes);
      let payload: unknown;
      try {
        payload = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        if (response.ok) {
          throw new SpalaApiError({
            category: 'invalid_upstream_response',
            status: response.status,
            message: 'The project backend returned an invalid response.',
          });
        }
      }
      if (!response.ok) {
        const parsed = safeErrorPayload(payload, [projectAccessToken, ...(options.sensitiveTokens || [])]);
        const category = errorCategory(response.status, parsed.code, parsed.message);
        throw new SpalaApiError({
          category,
          status: response.status,
          code: parsed.code,
          message: parsed.message || defaultErrorMessage(category),
          checkoutUrl: parsed.checkoutUrl,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof SpalaApiError) throw error;
      throw new SpalaApiError({
        category: 'upstream_unavailable',
        message: 'The project backend is temporarily unavailable.',
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const getPrincipal = (): Promise<SpalaPrincipal> => {
    principalPromise ??= requestJson('GET', '/api/me').then(payload => {
      const principal = parsePrincipal(payload);
      if (!principal) {
        throw new SpalaApiError({
          category: 'invalid_upstream_response',
          message: 'The Spala control plane returned an invalid identity response.',
        });
      }
      return principal;
    });
    return principalPromise;
  };

  const resolveOrganization = async (organizationId?: string): Promise<SpalaOrganization> => {
    const principal = await getPrincipal();
    const requestedId = organizationId?.trim();
    if (requestedId) {
      const organization = principal.organizations.find(candidate => candidate.id === requestedId);
      if (organization) return organization;
      throw new SpalaApiError({
        category: 'forbidden',
        status: 403,
        code: 'organization_access_denied',
        message: 'The requested organization is not available to the authenticated user.',
      });
    }
    if (principal.organizations.length === 0) {
      throw new SpalaApiError({
        category: 'forbidden',
        status: 403,
        code: 'organization_required',
        message: 'The authenticated user does not have an available Spala organization.',
      });
    }
    if (principal.organizations.length > 1) {
      throw new SpalaApiError({
        category: 'organization_selection_required',
        code: 'organization_selection_required',
        message: 'Multiple organizations are available. Provide organizationId to select one.',
        organizationChoices: principal.organizations,
      });
    }
    return principal.organizations[0]!;
  };

  const normalizeProjectId = (value: string): string => {
    const id = value.trim();
    if (!id || id.length > 256) {
      throw new SpalaApiError({ category: 'request_failed', message: 'Project ID must be between 1 and 256 characters.' });
    }
    return id;
  };

  const verifiedProjectHandoff = (payload: unknown, expectedProjectId: string): ProjectMcpHandoff => {
    const handoff = parseProjectHandoff(payload);
    const containsAccessToken = handoff && Object.values(handoff).some(value =>
      typeof value === 'string' && value.includes(controlPlaneAccessToken)
    );
    if (!handoff || handoff.projectId !== expectedProjectId || containsAccessToken) {
      throw new SpalaApiError({
        category: 'invalid_upstream_response',
        message: 'Spala returned an invalid project MCP handoff.',
      });
    }
    return handoff;
  };

  return {
    getPrincipal,

    async setupAccount(input) {
      principalPromise = undefined;
      const principal = await getPrincipal();
      const firstName = principal.user.firstName || input.firstName?.trim();
      const lastName = principal.user.lastName || input.lastName?.trim();
      const companyName = input.companyName?.trim();
      const missingFields = [
        ...(!firstName ? ['firstName'] : []),
        ...(!lastName ? ['lastName'] : []),
        ...(principal.organizations.length === 0 && !companyName ? ['companyName'] : []),
      ];
      if (missingFields.length > 0) {
        throw new SpalaApiError({
          category: 'request_failed',
          code: 'account_data_required',
          message: `Account setup requires: ${missingFields.join(', ')}.`,
        });
      }
      if (firstName!.length > 120 || lastName!.length > 120 || (companyName?.length || 0) > 120) {
        throw new SpalaApiError({
          category: 'request_failed',
          code: 'account_data_too_long',
          message: 'Account names must be between 1 and 120 characters.',
        });
      }

      const profileUpdated = !principal.user.firstName || !principal.user.lastName;
      if (profileUpdated) {
        const profileBody: Record<string, unknown> = {};
        if (!principal.user.firstName) profileBody['first_name'] = firstName;
        if (!principal.user.lastName) profileBody['last_name'] = lastName;
        await requestJson('PATCH', '/api/users', {
          body: profileBody,
        });
      }

      let organization: SpalaOrganization | undefined = principal.organizations[0];
      let organizationCreated = false;
      if (!organization) {
        organization = await this.createOrganization({ name: companyName! });
        organizationCreated = true;
      }

      const updatedPrincipal: SpalaPrincipal = {
        ...principal,
        user: { ...principal.user, firstName, lastName },
        organizations: organizationCreated ? [organization] : principal.organizations,
      };
      principalPromise = Promise.resolve(updatedPrincipal);
      return { principal: updatedPrincipal, organization, profileUpdated, organizationCreated };
    },

    async createOrganization(input) {
      const name = input.name.trim();
      if (!name || name.length > 120) {
        throw new SpalaApiError({
          category: 'request_failed',
          code: 'organization_name_invalid',
          message: 'Organization names must be between 1 and 120 characters.',
        });
      }
      const payload = await requestJson('POST', '/api/organizations', { body: { name } });
      const organization = parseCreatedOrganization(payload);
      if (!organization) {
        throw new SpalaApiError({
          category: 'invalid_upstream_response',
          message: 'The Spala control plane returned an invalid created organization.',
        });
      }
      principalPromise = undefined;
      return organization;
    },

    async listProjects(input = {}) {
      const organization = await resolveOrganization(input.organizationId);
      const payload = await requestJson('GET', '/api/projects', {
        query: { organizationId: organization.id },
      });
      const projects = parseProjectCollection(payload);
      if (!projects) {
        throw new SpalaApiError({
          category: 'invalid_upstream_response',
          message: 'The Spala control plane returned an invalid project list.',
        });
      }
      return {
        organization,
        projects: projects.map(project => ({ ...project, organizationId: organization.id })),
      };
    },

    async createProject(input) {
      const name = input.name.trim();
      if (!name || name.length > 120) {
        throw new SpalaApiError({ category: 'request_failed', message: 'Project name must be between 1 and 120 characters.' });
      }
      const organization = await resolveOrganization(input.organizationId);
      const payload = await requestJson('POST', '/api/projects', {
        body: { project_name: name, organization_id: organization.id },
      });
      const project = parseCreatedProject(payload);
      if (!project) {
        throw new SpalaApiError({
          category: 'invalid_upstream_response',
          message: 'The Spala control plane returned an invalid created project.',
        });
      }
      return { organization, project: { ...project, organizationId: organization.id } };
    },

    async getProjectHandoff(projectId) {
      const id = normalizeProjectId(projectId);
      const payload = await requestJson('GET', `/api/projects/${encodeURIComponent(id)}/mcp-handoff`);
      return verifiedProjectHandoff(payload, id);
    },

    async prepareProjectMcp(projectIdValue, client) {
      const id = normalizeProjectId(projectIdValue);
      let projectHandoff: ProjectMcpHandoff;
      try {
        const handoffPayload = await requestJson('GET', `/api/projects/${encodeURIComponent(id)}/mcp-handoff`);
        projectHandoff = verifiedProjectHandoff(handoffPayload, id);
      } catch (error) {
        rethrowProjectStage(error, 'invalid_project_mcp_handoff');
      }

      const accessPayload = await requestJson('GET', `/api/projects/${encodeURIComponent(id)}/access-url`);
      const access = parseProjectAccess(accessPayload, projectHandoff.projectUrl);
      if (!access || access.token.includes(controlPlaneAccessToken)) {
        throw new SpalaApiError({
          category: 'invalid_upstream_response',
          code: 'invalid_project_access_handoff',
          message: 'The Spala control plane returned an invalid project access handoff.',
        });
      }

      let builderToken: string;
      try {
        const exchangePayload = await requestProjectJson(
          access.projectUrl,
          access.token,
          'POST',
          '/api/__internal/builder-auth/external',
          { token: access.token },
          { authorization: false, sensitiveTokens: [controlPlaneAccessToken] },
        );
        const exchangeRecord = exchangePayload && typeof exchangePayload === 'object' && !Array.isArray(exchangePayload)
          ? exchangePayload as Record<string, unknown>
          : undefined;
        const token = exchangeRecord ? stringField(exchangeRecord, 'token', 8_192) : undefined;
        if (!validBearerToken(token) || token === access.token || token.includes(controlPlaneAccessToken)) {
          throw new SpalaApiError({
            category: 'invalid_upstream_response',
            code: 'invalid_project_builder_token',
            message: 'The project backend returned an invalid builder authentication response.',
          });
        }
        builderToken = token;
      } catch (error) {
        rethrowProjectStage(error, 'project_token_exchange_failed');
      }

      try {
        await requestProjectJson(
          access.projectUrl,
          builderToken,
          'POST',
          '/api/__internal/project/config',
          { securityConfig: { mcpEnabled: true } },
          { sensitiveTokens: [access.token, controlPlaneAccessToken] },
        );
      } catch (error) {
        rethrowProjectStage(error, 'project_mcp_enable_failed');
      }

      let instructionSession: unknown;
      try {
        instructionSession = await requestProjectJson(
          access.projectUrl,
          builderToken,
          'POST',
          '/mcp/agent-instructions',
          {
            scope: 'builder,project,data',
            clientName: `Spala ${client} agent`,
            deliveryMode: 'one-time',
          },
          { sensitiveTokens: [access.token, controlPlaneAccessToken] },
        );
      } catch (error) {
        rethrowProjectStage(error, 'project_agent_instruction_failed');
      }
      const bootstrapConsumeUrl = parseAgentInstructionBootstrap(instructionSession, access.projectUrl);
      const mcpUrl = parseProjectMcpUrl(`${access.projectUrl}/mcp?scope=builder%2Cproject%2Cdata`);
      const manifestUrl = parsePublicHttpsUrl(
        `${access.projectUrl}/mcp/install-manifest?scope=builder%2Cproject%2Cdata`,
        { allowProjectScope: true, requireCanonical: true },
      );
      if (
        !bootstrapConsumeUrl
        || bootstrapConsumeUrl.includes(access.token)
        || bootstrapConsumeUrl.includes(controlPlaneAccessToken)
        || !mcpUrl
        || !manifestUrl
      ) {
        throw new SpalaApiError({
          category: 'invalid_upstream_response',
          code: 'invalid_project_bootstrap_material',
          message: 'The project backend returned invalid MCP bootstrap material.',
        });
      }

      return {
        projectId: projectHandoff.projectId,
        projectName: projectHandoff.projectName,
        status: projectHandoff.status,
        projectUrl: access.projectUrl,
        mcpEnabled: true,
        mcpUrl,
        manifestUrl,
        bootstrapConsumeUrl,
      };
    },
  };
}
