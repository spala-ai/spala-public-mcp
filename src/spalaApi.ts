import type { AppConfig } from './config.js';
import { isIP } from 'node:net';

export type SpalaProject = {
  id: string;
  name: string;
  slug?: string;
  status?: string;
  dashboardUrl?: string;
  mcpUrl?: string;
  template?: string;
  description?: string;
  dryRunOnly?: boolean;
  note?: string;
};

export type CreateProjectInput = {
  name: string;
  template?: string;
  description?: string;
};

export type SpalaApiClient = {
  listProjects(): Promise<SpalaProject[]>;
  createProject(input: CreateProjectInput): Promise<SpalaProject>;
  resolveProjectAccess(project: SpalaProject): Promise<SpalaProject>;
};

export class ProjectHandoffUnavailableError extends Error {
  readonly code = 'project_handoff_unavailable';

  constructor() {
    super('Authenticated project lookup is unavailable because project handoff is not enabled for this public MCP release.');
    this.name = 'ProjectHandoffUnavailableError';
  }
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
  return [
    values[0] >> 8,
    values[0] & 0xff,
    values[1] >> 8,
    values[1] & 0xff,
  ];
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

/** Accept only a complete public HTTPS MCP endpoint explicitly returned by the platform. */
export function parseProjectMcpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) return undefined;
  const raw = value.trim();
  if (/\/(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(raw)) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
  if (!url.hostname || isForbiddenHostname(url.hostname)) return undefined;
  if (url.pathname.includes('//') || /%2f|%5c/i.test(url.pathname)) return undefined;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (decodedPath.split('/').some(segment => segment === '.' || segment === '..')) return undefined;

  const normalizedPath = url.pathname.replace(/\/+$/, '');
  if (!normalizedPath.endsWith('/mcp')) return undefined;
  url.pathname = normalizedPath;
  return url.toString();
}

/** Parse only documented top-level project fields. Never recurse into arbitrary payloads or derive URLs. */
export function parseProjectRecord(raw: unknown): SpalaProject | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (!id || !name || id.length > 256 || name.length > 256) return undefined;

  const slug = typeof record['slug'] === 'string' && record['slug'].trim()
    ? record['slug'].trim()
    : undefined;
  const status = typeof record['status'] === 'string' && record['status'].trim()
    ? record['status'].trim()
    : undefined;
  const mcpUrl = parseProjectMcpUrl(record['mcpUrl'] ?? record['mcp_url']);
  return { id, name, slug, status, mcpUrl };
}

function dryRunProject(config: AppConfig, input: CreateProjectInput): SpalaProject {
  const name = input.name.trim();
  const template = input.template?.trim();
  const description = input.description?.trim();
  if (!name || name.length > 120) throw new Error('Dry-run project name must be between 1 and 120 characters.');
  if (template !== undefined && (!template || template.length > 128)) {
    throw new Error('Dry-run project template must be between 1 and 128 characters.');
  }
  if (description !== undefined && (!description || description.length > 2_000)) {
    throw new Error('Dry-run project description must be between 1 and 2000 characters.');
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project';
  return {
    id: `dry-run-${slug}`,
    name,
    slug,
    status: 'dry-run',
    dashboardUrl: config.dashboardUrl,
    template,
    description,
    dryRunOnly: true,
    note: 'Planning preview only. No project was created and no project MCP URL was resolved.',
  };
}

export function createSpalaApiClient(config: AppConfig): SpalaApiClient {
  return {
    async listProjects() {
      throw new ProjectHandoffUnavailableError();
    },

    async createProject(input) {
      return dryRunProject(config, input);
    },

    async resolveProjectAccess(project) {
      if (project.dryRunOnly) return project;
      throw new ProjectHandoffUnavailableError();
    },
  };
}
