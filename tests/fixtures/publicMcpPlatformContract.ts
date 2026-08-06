const projectUrl = 'https://contract-project.example';
const projectAccessToken = 'contract-project-access-token';
const externalAuthHandoff = 'contract-external-auth-handoff-token';

export const publicMcpPlatformContract = {
  responseFields: {
    principal: ['user', 'organizations'],
    project: ['id', 'project_name', 'status', 'subdomain'],
    handoff: [
      'projectId',
      'projectName',
      'status',
      'projectUrl',
      'mcpEnabled',
      'mcpUrl',
      'manifestUrl',
    ],
    accessUrl: ['url'],
  },
  principal: {
    user: {
      id: 'contract-user',
      email: 'contract@example.test',
      first_name: 'Contract',
      last_name: 'User',
    },
    organizations: [{ id: 'contract-org', name: 'Contract organization' }],
  },
  projects: {
    projects: [{
      id: 'contract-project',
      project_name: 'Contract Project',
      status: 'ready',
      subdomain: 'contract-project',
    }],
  },
  handoff: {
    projectId: 'contract-project',
    projectName: 'Contract Project',
    status: 'ready',
    projectUrl,
    mcpEnabled: true,
    mcpUrl: `${projectUrl}/mcp`,
    manifestUrl: `${projectUrl}/mcp/install-manifest`,
  },
  accessUrl: {
    url: `https://app.spala.ai/?handoff=${externalAuthHandoff}&auth_token=${projectAccessToken}`,
  },
  projectUrl,
  projectAccessToken,
  externalAuthHandoff,
  builderToken: 'contract-project-builder-token',
} as const;
