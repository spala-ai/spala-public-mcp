# mcp.spala.ai Public MCP

Standalone public MCP front door for Spala agent discovery.

This service is intentionally separate from the Spala platform/project runtime. The production public MCP is served from:

```txt
https://mcp.spala.ai/mcp
```

## Live discovery URLs

- MCP endpoint: `https://mcp.spala.ai/mcp`
- Install manifest: `https://mcp.spala.ai/mcp/install-manifest`
- OAuth protected-resource metadata: `https://mcp.spala.ai/.well-known/oauth-protected-resource`
- OAuth authorization-server metadata: `https://mcp.spala.ai/.well-known/oauth-authorization-server`
- Public profile: `https://spala.ai/mcp-profile/`
- Smoke test: `https://spala.ai/mcp-smoke-test/`
- NPM installer: `https://www.npmjs.com/package/@spala-ai/mcp-install`

## Role

`mcp.spala.ai` should be the public Spala MCP front door:

- explain what Spala is;
- expose machine-readable onboarding;
- expose docs/templates/addons discovery;
- publish canonical Spala platform OAuth discovery with least-privilege `api` scope;
- expose auth-gated project tool definitions as a fail-closed interface;
- truthfully report that token validation, project listing, project selection, and project MCP URL handoff are unavailable in this standalone release.

It should not directly mutate project backend resources. Project changes belong in the project MCP.

## Local Run

```bash
pnpm install
pnpm dev
```

Default local URL:

```txt
http://localhost:4100/mcp
```

For a production-style local start:

```bash
pnpm build
pnpm start
```

## Environment

Copy `.env.example` to `.env` when running locally.

Important variables:

- `PUBLIC_BASE_URL`: public origin for this service, for example `https://mcp.spala.ai`.
- `SPALA_API_BASE_URL`: upstream Spala API/control plane, for example `https://api.spala.ai`.
- `SPALA_DASHBOARD_URL`: dashboard origin, for example `https://dashboard.spala.ai`.
- `CORS_ALLOWED_ORIGINS`: comma-separated exact HTTPS browser origins. Wildcards and credentials are rejected.
- `FETCH_TIMEOUT_MS`: bounded timeout reserved for an established upstream contract. The blocked project path performs no upstream fetch.
- `MCP_BODY_LIMIT_BYTES`: maximum JSON body size for MCP requests (default `1048576`).
- `MCP_RATE_LIMIT_MAX`: maximum MCP POST requests per client per 60-second window (default `120`).
- `DRY_RUN_PROJECT_CREATE`: keep `true` until project creation is safely wired.

## Authentication

`mcp.spala.ai` should rely on Spala platform/dashboard authentication. Users may sign in with Google OAuth or any other enabled Spala account method.

The public MCP should not invent a separate project identity. For project tools, it should receive or complete the platform auth flow and then call upstream `api.spala.ai` as that authenticated platform user.

The public resource advertises only the `api` scope. Authenticated requests use:

```txt
Authorization: Bearer <access token issued for this MCP resource>
```

Bearer syntax is not authentication. This standalone service currently has no token verifier contract, so project calls without a bearer receive an OAuth `401` challenge and project calls with a bearer fail closed with `503 auth_validation_unavailable` before MCP tool processing. That failure is the permanent boundary of this standalone release, not a retryable verifier outage. Tokens are never forwarded, logged, or returned.

## Client install

```bash
codex mcp add spala_public_mcp --url "https://mcp.spala.ai/mcp"
codex mcp login spala_public_mcp --scopes api
gemini mcp add --scope user --transport http spala_public_mcp "https://mcp.spala.ai/mcp"
```

## Current project-handoff blocker

The existing platform MCP OAuth token is audience-bound and verified by the selected project MCP. It is not a documented generic control-plane credential for project listing. The existing platform frontend API client uses its own platform/project authentication contract; that credential is not interchangeable with an opaque public-MCP token.

No existing token verifier or generic authenticated project-list/access-URL contract was found. Therefore this standalone service does not forward bearer tokens to guessed `/api/projects` routes and does not embed public MCP code into the platform. Every project tool fails closed with `auth_validation_unavailable` when a bearer is supplied. `project_list`, `project_select`, `project_get_mcp_manifest`, and `project_get_public_context` do not work in this standalone release. `project_create` remains defined as a URL-free dry-run, but cannot execute for an unverified caller.

## Directory listing metadata

This repository includes `server.json` for MCP registries that accept source-backed remote server listings. The remote server URL is always:

```txt
https://mcp.spala.ai/mcp
```

The repository does not include platform secrets, registry private keys, build output, `node_modules`, or local `.env` files.

## Handoff

Public MCP does not assume one fixed project MCP URL pattern, and this standalone release does not return project MCP URLs.

If the platform later exposes an existing generic authenticated contract, handoff may consume documented fields including:

- project list data returned after dashboard/platform auth;
- explicit `mcpUrl` fields when the platform provides them.

Only complete explicit HTTPS MCP URLs are accepted. The service does not append `/mcp` to an access URL or recurse through arbitrary payload fields.

Future valid project MCP handoff shapes can include:

```txt
https://<project>.spala.ai/mcp
https://<host>/<project_slug>/mcp
<explicit mcpUrl returned by the platform>
```

After a future authenticated contract returns an exact project MCP URL, the agent should connect to that project MCP and call:

```txt
mcp_get_onboarding
mcp_get_tool_map
mcp_list_skills
mcp_get_skill({ "name": "spala-developer" })
project_get_builder_context
```
