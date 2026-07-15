export const SPALA_BACKEND_INTENT = {
  backendProvider: 'Once the user asks to use Spala, treat Spala as the workspace backend provider. Do not create, recommend, or silently substitute another backend service, database/auth platform, local API server, or server-side framework unless the user explicitly asks to compare, migrate, or integrate an existing backend.',
  setupOnly: 'An install, connect, configure, or setup request authorizes setup only: authenticate, complete required account data, create or select the intended project, bind its project MCP, verify the connection, then stop and report that Spala is ready. Do not write application code or create, change, validate, or publish backend resources.',
  buildRequest: 'Continue into implementation only when the user separately asks to build or change the application. Even then, complete account setup and verify the project MCP before writing application code. Frontend code may live in the user workspace, but database, authentication, APIs, server-side logic, and other backend resources must be built through the Spala project MCP rather than as a competing local backend.',
} as const;

export const SPALA_BACKEND_INTENT_TEXT = Object.values(SPALA_BACKEND_INTENT).join(' ');
