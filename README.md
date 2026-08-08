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
- Native agent integrations: `https://github.com/spala-ai/agent-integrations`
- NPM installer: `https://www.npmjs.com/package/@spala-ai/mcp-install`
- Postman workspace: `https://www.postman.com/paul-8c16afeb-1705125/spala-public-mcp/overview`
- Postman documentation: `https://documenter.getpostman.com/view/54332390/2sBY4QtKjd`

## Tools

The server exposes 16 tools. Every tool publishes a display title, description, input schema, and behavioral annotations through `tools/list`.

- spala_help: explains what Spala is, what the public MCP does, and where agents should start.
- spala_get_onboarding: returns first-call onboarding for agents, including public MCP vs project MCP boundaries.
- spala_get_tool_map: returns machine-readable routing, OAuth metadata URLs, and tool availability.
- docs_search: searches public Spala agent-facing docs for setup, OAuth, MCP, security, limits, and platform questions.
- template_list: lists public Spala backend templates so agents can plan backend shape before using a project MCP.
- addon_list: lists public Spala addons and integrations so agents can plan backend workflows.
- spala_start: protected startup gate. Product mentions, factual questions, comparisons, research, and tests performed through another client must not start OAuth. Call this first only after the user explicitly asks the current MCP client to access their Spala account/project and OAuth completes. It returns the one next account, organization, project, billing, or handoff action.
- account_status: compatibility readiness tool. `spala_start` absorbs this status for the normal agent workflow.
- account_setup: fills missing first/last name and creates the first company/workspace organization from real values supplied by the user or explicit context.
- organization_create: creates an additional company/workspace organization for the signed-in account.
- project_list: lists projects available to the signed-in account.
- project_create: creates a real project for the signed-in account.
- project_connect: reuses the dashboard's authenticated project-entry handoff, enables MCP directly on the selected project backend, then returns exact clean handoff URLs and a workspace-only installer plan.
- project_select: compatibility alias for `project_connect`, with the same idempotent write behavior.
- project_get_mcp_manifest: prepares the selected project's MCP and returns exact MCP and manifest URLs plus a workspace-only installer plan.
- project_get_public_context: read-only project and handoff context without requiring a client or returning installer argv.

The first six tools are public. The remaining tools require a public MCP bearer with scope `api`. The public MCP validates access and delegates project requests securely server-side; credentials are never shown in tool results or error messages.

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

To run the optional cross-repository contract smoke against a local installer
checkout while keeping ordinary CI self-contained:

```bash
SPALA_MCP_INSTALLER_ROOT=/path/to/npmjs-minimal pnpm test
```

The smokes pass generated `project bind` argv to the installer module directly,
verify the scoped `/<slug>/mcp` binding, confirm one-time POST consumption for
bootstrap clients, and confirm Claude Code binds successfully with empty stdin.

## Environment

Copy `.env.example` to `.env` when running locally.

Important variables:

- `PUBLIC_BASE_URL`: public origin for this service, for example `https://mcp.spala.ai`.
- `SPALA_API_BASE_URL`: validated platform API origin, for example `https://api.spala.ai`. Public MCP clients cannot override it.
- `PUBLIC_OAUTH_ENCRYPTION_SECRET`: required dedicated AES-GCM key material with at least 32 characters and UTF-8 bytes; never expose this value.
- `PUBLIC_OAUTH_REPLAY_STATE_PATH`: absolute path to a dedicated persistent OAuth replay-state directory below the filesystem root. Required whenever `PUBLIC_BASE_URL` is hosted on HTTPS. Every service worker must use the same path.
- `PUBLIC_OAUTH_TICKET_LIFETIME_SECONDS` and `PUBLIC_OAUTH_CODE_LIFETIME_SECONDS`: bounded lifetimes for encrypted local OAuth request mechanics.
- `PUBLIC_OAUTH_RATE_LIMIT_MAX`: maximum requests across all OAuth endpoints per client per 60-second window (default `120`).
- `PUBLIC_OAUTH_BODY_LIMIT_BYTES`: maximum JSON or form body size accepted by OAuth endpoints (default `32768`).
- `PUBLIC_MCP_PLATFORM_SERVICE_SECRET`: required dedicated service credential for the fixed internal public-MCP lifecycle and typed-operation API; never print or expose this value.
- `PUBLIC_MCP_PLATFORM_TIMEOUT_MS`: bounded timeout for fixed platform lifecycle and operation requests (default `8000`).
- `PUBLIC_MCP_PLATFORM_RESPONSE_LIMIT_BYTES`: maximum streamed response body accepted from fixed platform and project-runtime requests (default `1048576`).
- `PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS`: optional comma-separated allowlist of exact HTTPS origins that may receive project-entry credentials for authoritative `/<slug>/mcp` shared-runtime mounts. Wildcards, paths, queries, credentials, and HTTP origins are rejected. Leave it empty when project MCPs use their authenticated project URL.
- `SPALA_DASHBOARD_URL`: dashboard origin, for example `https://dashboard.spala.ai`.
- `SPALA_PRICING_URL`: pricing page used for plan and payment recovery actions, for example `https://spala.ai/pricing/`.
- `CORS_ALLOWED_ORIGINS`: comma-separated exact HTTPS browser origins. Wildcards and credentials are rejected.
- `MCP_BODY_LIMIT_BYTES`: maximum JSON body size for MCP requests (default `1048576`).
- `MCP_RATE_LIMIT_MAX`: maximum MCP POST requests per client per 60-second window (default `120`).

## Authentication

`mcp.spala.ai` is the only MCP URL agents configure. Browser authorization starts at the public OAuth endpoint and redirects to `dashboard.spala.ai`, where the human signs in or creates an account.

The public MCP does not invent a separate project identity. The dashboard uses its normal authenticated API to create a one-time approval proof, then submits only that proof and the encrypted public authorization request to `mcp.spala.ai`. The normal dashboard bearer is never submitted to the public service.

The public resource continues to advertise only the compatible `api` scope. Authenticated requests use:

```txt
Authorization: Bearer <access token issued for this MCP resource>
```

Bearer syntax is not authentication. Access is scoped to the exact canonical resource `https://mcp.spala.ai/mcp` with `api`. The public OAuth metadata, authorization, token, revocation, and registration endpoints are served from `mcp.spala.ai`. Dynamic registration accepts loopback HTTP callbacks, the exact hosted Claude and VS Code callbacks, and the existing validated native callback schemes; arbitrary web origins, wildcard hosts, callback queries, and callback fragments remain rejected. Authorization creates an encrypted request ticket and redirects to `dashboard.spala.ai/mcp/authorize`; the dashboard obtains `approvalProof` from its normal authenticated API and submits JSON `{ "request": "...", "approvalProof": "..." }` without `Authorization` to `/oauth/dashboard/approve`. The public service consumes that proof through its service-authenticated fixed platform API, and the local authorization code carries only the resulting one-time platform grant code. The platform issues opaque short access and rotating refresh credentials bound to the canonical resource. The public service encrypts the opaque platform access credential inside the public access token, unwraps it only for fixed typed platform operations, and never stores it in replay state. Upstream 5xx, network, timeout, and malformed-success failures return retryable `temporarily_unavailable` errors; exact approval, code-exchange, and refresh retries remain recoverable without allowing changed bindings. Invalid grants return `400`; invalid protected access returns a reliable `401` Bearer challenge, while anonymous `initialize`, `tools/list`, and the six public discovery tools remain usable even when a stale credential is presented. An invalid scope returns `403 insufficient_scope`, and OAuth rate limits return `429`. Credentials are never logged, placed in public URLs or manifests, or returned by MCP tools.

Single-binding ticket and authorization-code claims are stored as hash-only markers under `PUBLIC_OAUTH_REPLAY_STATE_PATH`; exact duplicates reuse the same result, changed replays are rejected, and request contents and platform grant codes are not written there. Refresh rotation and replay protection are atomic on the platform issuer. The service requires `0700` on an existing state directory, creates new state and expiration-bucket directories with `0700`, writes markers with `0600`, creates each claim with atomic exclusive file creation, syncs it before returning credentials, and removes expired buckets during later claims. Pre-provision a dedicated production path or volume below the filesystem root with that mode and ownership by the service account. The path must persist across restarts and deployments. Multiple workers must share a filesystem with atomic cross-process `O_EXCL` behavior and run as the same service account. Hosted configuration refuses to start without an explicit path or platform service secret, and replay-state initialization or runtime I/O failures fail closed instead of falling back to process memory. Local HTTP development defaults to the gitignored `.state/public-oauth-replay` directory when no path is supplied. Legacy encrypted public-MCP refresh credentials are not rotated; this migration can require one final interactive reauthentication.

## Client install

```bash
npx --yes @spala-ai/mcp-install@0.1.18 init --client codex --yes --json
```

For Codex this safely writes the user-scoped MCP configuration and a managed
Spala routing skill, owns one native browser OAuth flow when first configured,
then requires a new or resumed session. Do not run a second login, manually
open its authorization URL, inspect client credential stores, or hand-roll MCP
HTTP calls to bypass the reload boundary.

## Project-handoff contract

The public MCP accepts an issued MCP OAuth token for `https://mcp.spala.ai/mcp` with scope `api`. Project listing and creation select a sole organization automatically; when multiple organizations are available, callers must provide one of the returned `organizationId` choices. Access checks remain enforced by Spala.

The upstream origin is configuration-only and never caller-controlled. Responses are parsed from documented fields; the service does not search arbitrary payloads for URLs or credentials.

After public MCP OAuth, call `spala_start` as the protected first call. If it reports missing account data, ask the human one concise terminal question for exactly those fields and call `account_setup`; never invent placeholder names. Then ask for or confidently derive the real project name. Reuse the project recorded in the current workspace's `.spala/project.json` when it exists. Otherwise call `project_list`, and call `project_create` only when the intended project does not already exist. Then call `project_connect` with the project and one of `codex`, `roo`, `claude-code`, or `cursor`. Public MCP requests the existing dashboard project access URL, keeps its temporary project-entry credential server-side, and calls that exact project backend directly. The project backend performs its normal permission checks and enables MCP through the existing project settings API. Codex, Roo, and Cursor receive a short-lived one-time bootstrap-consumption URL. Claude Code first creates a local verifier, then calls `project_connect` again with its non-secret request ID and S256 challenge; the returned one-time claim can only be redeemed with that local verifier. No second browser OAuth is required.

## Directory listing metadata

This repository includes `server.json` for MCP registries that accept source-backed remote server listings. The remote server URL is always:

```txt
https://mcp.spala.ai/mcp
```

The repository does not include platform secrets, registry private keys, build output, `node_modules`, or local `.env` files.

`package.json` versions the Node service implementation. `server.json` versions
the independently published MCP Registry listing. They are intentionally
separate release channels; update `server.json` only when publishing new
registry metadata.

## Handoff

Public MCP accepts only the complete public HTTPS `mcpUrl` and `manifestUrl` returned by the authenticated project handoff. Before sending the reusable project-entry credential to a runtime builder-auth endpoint, it requires the MCP mount base to match the authenticated `projectUrl` origin and path exactly. This supports standalone deployments and custom domains without extra configuration. A distinct shared-runtime origin is fail-closed unless it appears exactly in `PUBLIC_MCP_TRUSTED_SHARED_RUNTIME_ORIGINS`, and configured shared runtimes must use the authoritative `/<slug>/mcp` mount shape. Project MCP URLs may contain one canonical `scope` query composed only of `builder`, `project`, and `data`; arbitrary queries, credentials, fragments, duplicate scopes, and noncanonical URLs are rejected. The exact accepted string, including `/mcp/` and scope query, is preserved.

Agentic workspace binding currently supports four client identifiers: `codex`, `roo`, `claude-code`, and `cursor`. Other applications may connect to the public MCP through their own MCP configuration, but `project_connect` does not return an executable project-binding plan for them. Without `client`, install-capable tools return `client_selection_required` and no executable plan.

Successful Codex, Roo, and Cursor connections return a protected-bootstrap argv. The Codex shape is:

```txt
npx --yes @spala-ai/mcp-install@0.1.18 project bind --project-id <project-id> --project-url <exact-project-url> --url <exact-scoped-mcp-url> --name <deterministic-server-name> --client codex --install-scope workspace --bootstrap-stdin --exact-url --yes --json
```

Run the argv immediately as a direct process from the intended project root with `tty:true` and `shell:false`. Wait for the process tool to report a running process, then use the process stdin tool to send `bootstrap.consumeUrl` plus a newline. Never interpolate the capability into shell text or process arguments. The capability is short-lived and one-time. The installer consumes it and configures a local credential proxy, then creates or updates `.spala/project.json`. Do not run native or manual project OAuth for this agentic flow; manual UI OAuth is unrelated. Never install a project MCP globally. The handoff, top-level response, install plan, and bootstrap exchange use the same authorized scoped MCP endpoint; subset scopes are never widened. The remote `manifestUrl` is informational and must not be fetched or passed to the installer. Follow the installer JSON reload instruction for the selected client.

Claude Code uses two generated commands without `--bootstrap-stdin`. The first command creates a verifier in the user's protected credential store and returns only a non-secret request ID and S256 challenge:

```txt
npx --yes @spala-ai/mcp-install@0.1.18 project prepare --project-id <project-id> --project-url <exact-project-url> --url <exact-scoped-mcp-url> --name <deterministic-server-name> --client claude-code --install-scope workspace --exact-url --yes --json
```

Call `project_connect` again with those two non-secret values. Run the returned `project bind` argv immediately; it contains the one-time claim and request ID, but never the verifier. The installer redeems the claim, stores the project credential outside the workspace, and configures the project-scoped local proxy. Reload Claude Code and call `spala_start` on the new project MCP. Do not start native project OAuth for this flow.

After the authenticated contract returns an exact project MCP URL, the agent should connect to that project MCP and call:

```txt
spala_start
mcp_get_skill({ "name": "spala-developer" })
project_get_builder_context
```
