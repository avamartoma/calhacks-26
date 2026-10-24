# Architecture

## Components

| Area | Files | Responsibility |
| --- | --- | --- |
| Local companion | `server/index.mjs`, `server/codex.mjs` | Express app, Codex app-server connection and one-click sign-in, local session and agent lifecycle for both engines |
| Work graph | `server/domain.mjs`, `server/orchestration.mjs`, `server/tickets.mjs` | Roles, assignments, dependencies, scheduling and mode policies |
| Review | `server/evidence.mjs`, `server/workspace-check.mjs` | Evidence receipts, current-source checks and verification gates |
| Continuity | `server/checkpoints.mjs`, `server/peer-handoffs.mjs` | Checkpoints, replacement context and persistent messages |
| Team transport | `server/team.mjs` | Paired local offices, status exchange and cross-office handoffs |
| External execution | `server/cursor.mjs`, `server/office-mcp.mjs`, `scripts/cursor-mcp.mjs`, `scripts/claude-mcp.mjs` | Cursor and Claude Code session ownership and explicitly reported activity over MCP |
| Launched Cursor agents | `server/cursor-agent.mjs` | Office-owned Cursor SDK runs: runtime selection, observable stream and cancellation |
| Claude engine | `server/claude-agent.mjs`, `server/claude-office.mjs`, `server/claude-key.mjs` | Office agents run on Claude through the Claude Agent SDK: same instructions, office tools (as MCP), permissions, evidence and handoffs as Codex agents; sessions, steering, cancellation and the locally stored API key |
| Sign-in | `server/oauth.mjs` | Auth0 Authorization Code with PKCE, identity-token verification and local session storage |
| Agent identity | `server/identity.mjs` | Credential subjects and per-identity track records |
| Public runs | `server/run-doc.mjs` | Block projection, attribution labels, block-anchored comments and the run feed |
| Workspace UI | `src/App.tsx`, `src/Operations.tsx`, panel components | Project navigation, tickets, agents, permissions and evidence |
| Spatial view | `src/scene.ts`, `src/CityEnvironment.ts`, `src/TeamDistrict.ts` | Office, city, agents, rendering and nearby office detail |
| Alternative view | `src/CompactOffice.tsx`, `src/TeamMap.tsx` | Searchable project and team maps |

## Execution boundaries

The manager is the implementation owner. Specialists use a read-only sandbox for bounded research and review. Dependencies and declared file scopes coordinate assignments; they are not operating-system file locks. Office-wide permissions apply to subsequent turns. Approval requests remain explicit.

Published plans, status, commands, outputs and changes are observable work. Private reasoning is excluded. Model labels come from the connected catalog or are explicitly reported by an external provider.

Cursor reaches the office two ways, and they differ in who owns execution. A Cursor IDE session connects through MCP: it drives itself, reports what it chooses to, and cannot be stopped from here. A Cursor SDK run is launched by the office: its model is the one selected here, its stream is recorded as observed work, and it can be cancelled. Neither path makes a claim verified.

A run published while signed out is unattributed. Signing in runs Authorization Code with PKCE against Auth0: the office is a public client, so no client secret exists on the machine, the code verifier never leaves it, and the redirect lands on loopback. The `sub` claim of a verified identity token fixes the `credentialSub` on the desk, carries the display name and track record across sessions, and binds later reports to the account that opened the run. Operator recovery is deliberately exempt, because it exists for when that agent can no longer answer.

The sign-in callback is the one route outside the cookie-gated `/api` prefix. It has to be: the redirect arrives from `auth0.com`, and the office session cookie is `sameSite=strict`, so it would not be sent. The `state` parameter is the CSRF defence there, and it is single use.

The MCP server holds no credential. A local reporter inherits whichever account is signed in to the office, which is why `.cursor/mcp.json` carries no secret. The trade is that any process able to reach the loopback API acts as that account; this is already true of the rest of the execution API, and is why it must not be exposed beyond loopback.

A run doc is a projection over the same evidence the office already holds, not a second copy. Each block carries how far its claim is trusted: `verified` for a passing observed check on the current source version, `observed` for a recorded command that is stale or failing, `self-reported` for anything an external agent asserted, and `operator` for a human recovery note.

A handoff can be queued, delivered, acknowledged, or applied. Delivery does not prove the recipient read it. An applied finding references local evidence. Messages survive replacement; remote messages do not start agents or grant permissions.

Verification requires explicit criteria and receipts. Passing checks must refer to observed commands on the relevant source version. This validates an evidence contract; it cannot prove every semantic assertion in an agent report.

## Reproducible demonstrations

The default sample office and guided presentation are simulated. The two-office fixture uses real transport with deterministic test agents. The included completed React example came from an earlier live run; opening it is not a new model execution.

Use `npm run demo:check -- --project <saved-project-name> --team` to preflight a saved live outcome and running team fixture. This checks existing state; it does not create an outcome or run a model.
