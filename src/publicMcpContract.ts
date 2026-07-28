export const PUBLIC_MCP_RESOURCE = 'https://mcp.spala.ai/mcp';
export const PUBLIC_MCP_SCOPE = 'api';
export const PUBLIC_MCP_SERVICE_AUTH_HEADER = 'x-spala-public-mcp-service-secret';

const INTERNAL_PREFIX = '/api/__internal/public-mcp/v1';

export const PUBLIC_MCP_PLATFORM_ROUTES = {
  approvalConsume: `${INTERNAL_PREFIX}/approvals/consume`,
  tokenIssue: `${INTERNAL_PREFIX}/token`,
  tokenRefresh: `${INTERNAL_PREFIX}/token/refresh`,
  tokenRevoke: `${INTERNAL_PREFIX}/token/revoke`,
  principal: `${INTERNAL_PREFIX}/principal`,
  users: `${INTERNAL_PREFIX}/users`,
  organizations: `${INTERNAL_PREFIX}/organizations`,
  projects: `${INTERNAL_PREFIX}/projects`,
  projectHandoff: (projectId: string) => `${INTERNAL_PREFIX}/projects/${encodeURIComponent(projectId)}/mcp-handoff`,
  projectAccessUrl: (projectId: string) => `${INTERNAL_PREFIX}/projects/${encodeURIComponent(projectId)}/access-url`,
} as const;
