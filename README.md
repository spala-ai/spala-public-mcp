# mcp.spala.ai Public MCP

Standalone public MCP front door for Spala agent discovery.

## Agent intent boundary

- Once a user asks to use Spala, Spala is the workspace backend provider. Do not scaffold or substitute another backend, database/auth platform, or local API server unless the user explicitly requests comparison, migration, or integration with an existing backend.
- An install/connect/configure/setup request is setup only. Complete authentication, account data, project creation or selection, project MCP binding, and connection verification, then stop. Do not write application code or mutate backend resources.
- Continue into implementation only after a separate build/change request and after account setup plus project MCP verification are complete. Until then, do not inspect application files or perform planning, design generation, scaffolding, coding, testing, or QA. Frontend code may be local after the gate; database, auth, APIs, and server-side logic must use the Spala project MCP.

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

## Tools

### Public discovery tools

- `spala_help`: explains what Spala is, what the public MCP does, and where agents should start.
- `spala_get_onboarding`: returns first-call onboarding for agents, including public MCP vs project MCP boundaries.
- `spala_get_tool_map`: returns machine-readable routing, OAuth metadata URLs, and tool availability.
- `docs_search`: searches public Spala agent-facing docs for setup, OAuth, MCP, security, limits, and platform questions.
- `template_list`: lists public Spala backend templates so agents can plan backend shape before using a project MCP.
- `addon_list`: lists public Spala addons and integrations so agents can plan backend workflows.

### Auth-gated project handoff tools

These tools require a public MCP bearer with scope `api`. The public MCP validates access and delegates project requests securely server-side; credentials are never shown in tool results or error messages.

- `spala_start`: protected startup gate. Call this first after OAuth whenever the user asks to use, install, connect, configure, or build with Spala. It returns the one next account, organization, project, billing, or handoff action.
- `account_status`: compatibility readiness tool. `spala_start` absorbs this status for the normal agent workflow.
- `account_setup`: fills missing first/last name and creates the first company/workspace organization from real values supplied by the user or explicit context.
- `project_list`: lists projects available to the signed-in account.
- `project_create`: creates a real project for the signed-in account.
- `project_connect`: reuses the dashboard's authenticated project-entry handoff, enables MCP directly on the selected project backend, then returns exact clean handoff URLs and a workspace-only installer plan.
- `project_select`: compatibility alias for `project_connect`, with the same idempotent write behavior.
- `project_get_mcp_manifest`: prepares the selected project's MCP and returns exact MCP and manifest URLs plus a workspace-only installer plan.
- `project_get_public_context`: read-only project and handoff context without requiring a client or returning installer argv.

## Role

`mcp.spala.ai` should be the public Spala MCP front door:

- explain what Spala is;
- expose machine-readable onboarding;
- expose docs/templates/addons discovery;
- publish public-origin OAuth discovery with least-privilege `api` scope and dashboard browser authorization;
- securely delegate authenticated project callers server-side;
- list and create projects and return exact project MCP handoff URLs supplied by that control plane.

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
- `SPALA_API_BASE_URL`: internal control-plane origin supplied by the hosted deployment; never expose it in public MCP output or metadata.
- `PUBLIC_OAUTH_ENCRYPTION_SECRET`: dedicated AES-GCM key material with at least 32 characters and UTF-8 bytes. Required whenever `PUBLIC_BASE_URL` is hosted on HTTPS; never expose this value.
- `PUBLIC_OAUTH_REPLAY_STATE_PATH`: absolute path to a dedicated persistent OAuth replay-state directory below the filesystem root. Required whenever `PUBLIC_BASE_URL` is hosted on HTTPS. Every service worker must use the same path.
- `PUBLIC_OAUTH_TICKET_LIFETIME_SECONDS`, `PUBLIC_OAUTH_CODE_LIFETIME_SECONDS`, `PUBLIC_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS`, and `PUBLIC_OAUTH_REFRESH_TOKEN_LIFETIME_SECONDS`: bounded lifetimes for encrypted OAuth artifacts.
- `PUBLIC_OAUTH_RATE_LIMIT_MAX`: maximum requests across all OAuth endpoints per client per 60-second window (default `120`).
- `SPALA_DASHBOARD_URL`: dashboard origin, for example `https://dashboard.spala.ai`.
- `SPALA_PRICING_URL`: pricing page used for plan and payment recovery actions, for example `https://spala.ai/pricing/`.
- `CORS_ALLOWED_ORIGINS`: comma-separated exact HTTPS browser origins. Wildcards and credentials are rejected.
- `FETCH_TIMEOUT_MS`: bounded timeout for authenticated internal requests.
- `SPALA_API_RESPONSE_LIMIT_BYTES`: maximum streamed response body size accepted from the control plane (default `1048576`).
- `MCP_BODY_LIMIT_BYTES`: maximum JSON body size for MCP requests (default `1048576`).
- `MCP_RATE_LIMIT_MAX`: maximum MCP POST requests per client per 60-second window (default `120`).

## Authentication

`mcp.spala.ai` is the only MCP URL agents configure. Browser authorization starts at the public OAuth endpoint and redirects to `dashboard.spala.ai`, where the human signs in or creates an account.

The public MCP does not invent a separate project identity. It handles secure server-side validation and delegation for project tools. The dashboard browser route remains part of public MCP login because the dashboard bearer is held in browser storage; the user may sign in or sign up there, then the MCP client completes OAuth automatically.

The public resource advertises only the `api` scope. Authenticated requests use:

```txt
Authorization: Bearer <access token issued for this MCP resource>
```

Bearer syntax is not authentication. Access is scoped to `https://mcp.spala.ai/mcp` with `api`. The public OAuth metadata, authorization, token, and registration endpoints are served from `mcp.spala.ai`. Dynamic registration accepts only loopback HTTP callbacks (`localhost`, `127.0.0.1`, or `::1`), preventing automatic dashboard approval from authorizing arbitrary web origins. Authorization creates an encrypted request ticket and redirects to `dashboard.spala.ai/mcp/authorize`; the dashboard submits that ticket and the user's dashboard Bearer credential to `/oauth/dashboard/approve`, which returns `{ "redirectTo": "<client callback>" }`. Authorization codes and refresh tokens are encrypted, short-lived or bounded respectively, and single-use on redemption; refresh tokens rotate. Refresh validates the dashboard credential before issuing replacement tokens and returns `invalid_grant` when that session is no longer valid. Invalid access, including a revoked upstream dashboard session, returns a `401` Bearer challenge so the client can reauthenticate. An invalid scope returns `403 insufficient_scope`, OAuth rate limits return `429`, and temporary failures return a generic `503`. Tokens and dashboard credentials are never logged, cached, persisted, placed in URLs, or returned by MCP tools.

Single-use ticket, authorization-code, and refresh-token claims are stored as hash-only markers under `PUBLIC_OAUTH_REPLAY_STATE_PATH`; token contents and dashboard credentials are not written there. The service requires `0700` on an existing state directory, creates new state and expiration-bucket directories with `0700`, writes markers with `0600`, creates each claim with atomic exclusive file creation, syncs it before issuing replacement credentials, and removes expired buckets during later claims. Pre-provision a dedicated production path or volume below the filesystem root with that mode and ownership by the service account. The path must persist across restarts and deployments. Multiple workers must share a filesystem with atomic cross-process `O_EXCL` behavior and run as the same service account. Hosted configuration refuses to start without an explicit path, and replay-state initialization or runtime I/O failures fail closed instead of falling back to process memory. Local HTTP development defaults to the gitignored `.state/public-oauth-replay` directory when no path is supplied.

## Client install

```bash
npx --yes @spala-ai/mcp-install@0.1.12 init --client codex --yes --json
```

For Codex this safely writes the user-scoped MCP configuration and a managed
Spala routing skill, owns one native browser OAuth flow when first configured,
then requires a new or resumed session. Do not run a second login, manually
open its authorization URL, inspect client credential stores, or hand-roll MCP
HTTP calls to bypass the reload boundary.

## Project-handoff contract

The public MCP accepts an issued MCP OAuth token for `https://mcp.spala.ai/mcp` with scope `api`. Project listing and creation select a sole organization automatically; when multiple organizations are available, callers must provide one of the returned `organizationId` choices. Access checks remain enforced by Spala.

The upstream origin is configuration-only and never caller-controlled. Responses are parsed from documented fields; the service does not search arbitrary payloads for URLs or credentials.

After public MCP OAuth, call `spala_start` as the protected first call. If it reports missing account data, ask the human one concise terminal question for exactly those fields and call `account_setup`; never invent placeholder names. Then ask for or confidently derive the real project name. Reuse the project recorded in the current workspace's `.spala/project.json` when it exists. Otherwise call `project_list`, and call `project_create` only when the intended project does not already exist. Then call `project_connect` with the project and either `codex` or `roo`. Public MCP requests the existing dashboard project access URL, keeps its temporary project-entry credential server-side, and calls that exact project backend directly. The project backend performs its normal permission checks, enables MCP through the existing project settings API, and creates a short-lived one-time bootstrap-consumption URL. Public MCP never returns the dashboard or project-entry credential and treats the bootstrap URL as opaque.

## Directory listing metadata

This repository includes `server.json` for MCP registries that accept source-backed remote server listings. The remote server URL is always:

```txt
https://mcp.spala.ai/mcp
```

The repository does not include platform secrets, registry private keys, build output, `node_modules`, or local `.env` files.

## Handoff

Public MCP does not assume a project MCP URL pattern. It accepts only the complete public HTTPS `mcpUrl` and `manifestUrl` returned by the authenticated project handoff. Project MCP URLs may contain one canonical `scope` query composed only of `builder`, `project`, and `data`; arbitrary queries, credentials, fragments, duplicate scopes, and noncanonical URLs are rejected. The exact accepted string, including `/mcp/` and scope query, is preserved.

Agentic workspace binding currently supports two client identifiers: `codex` and `roo`. Other applications may connect to the public MCP through their own MCP configuration, but `project_connect` does not return an executable project-binding plan for them. Without `client`, install-capable tools return `client_selection_required` and no executable plan.

Successful Codex connection returns an argv with this contract:

```txt
npx --yes @spala-ai/mcp-install@0.1.12 project bind --project-id <project-id> --project-url <exact-project-url> --url <exact-mcp-url> --name <deterministic-server-name> --client codex --install-scope workspace --bootstrap-stdin --exact-url --yes --json
```

Run the argv immediately as a direct process from the intended project root with `tty:true` and `shell:false`. Wait for the process tool to report a running process, then use the process stdin tool to send `bootstrap.consumeUrl` plus a newline. Never interpolate the capability into shell text or process arguments. The capability is short-lived and one-time. The installer consumes it and configures a local credential proxy, then creates or updates `.spala/project.json`. Do not run native or manual project OAuth for this agentic flow; manual UI OAuth is unrelated. Never install a project MCP globally. `--exact-url` preserves the complete clean handoff URL without adding a default scope. The remote `manifestUrl` is informational and must not be fetched or passed to the installer. Follow the installer JSON reload instruction for the selected client.

After the authenticated contract returns an exact project MCP URL, the agent should connect to that project MCP and call:

```txt
mcp_get_onboarding
mcp_get_tool_map
mcp_list_skills
mcp_get_skill({ "name": "spala-developer" })
project_get_builder_context
```
