# Architecture

## Components

| Area | Files | Responsibility |
| --- | --- | --- |
| Local companion | `server/index.mjs`, `server/codex.mjs` | Express app, Codex app-server connection, local session and lifecycle |
| Work graph | `server/domain.mjs`, `server/orchestration.mjs`, `server/tickets.mjs` | Roles, assignments, dependencies, scheduling and mode policies |
| Review | `server/evidence.mjs`, `server/workspace-check.mjs` | Evidence receipts, current-source checks and verification gates |
| Continuity | `server/checkpoints.mjs`, `server/peer-handoffs.mjs` | Checkpoints, replacement context and persistent messages |
| Team transport | `server/team.mjs` | Paired local offices, status exchange and cross-office handoffs |
| External execution | `server/cursor.mjs`, `scripts/cursor-mcp.mjs` | Cursor ownership and explicitly reported activity |
| Workspace UI | `src/App.tsx`, `src/Operations.tsx`, panel components | Project navigation, tickets, agents, permissions and evidence |
| Spatial view | `src/scene.ts`, `src/CityEnvironment.ts`, `src/TeamDistrict.ts` | Office, city, agents, rendering and nearby office detail |
| Alternative view | `src/CompactOffice.tsx`, `src/TeamMap.tsx` | Searchable project and team maps |

## Execution boundaries

The manager is the implementation owner. Specialists use a read-only sandbox for bounded research and review. Dependencies and declared file scopes coordinate assignments; they are not operating-system file locks. Office-wide permissions apply to subsequent turns. Approval requests remain explicit.

Published plans, status, commands, outputs and changes are observable work. Private reasoning is excluded. Model labels come from the connected catalog or are explicitly reported by an external provider.

A handoff can be queued, delivered, acknowledged, or applied. Delivery does not prove the recipient read it. An applied finding references local evidence. Messages survive replacement; remote messages do not start agents or grant permissions.

Verification requires explicit criteria and receipts. Passing checks must refer to observed commands on the relevant source version. This validates an evidence contract; it cannot prove every semantic assertion in an agent report.

## Reproducible demonstrations

The default sample office and guided presentation are simulated. The two-office fixture uses real transport with deterministic test agents. The included completed React example came from an earlier live run; opening it is not a new model execution.

Use `npm run demo:check -- --project <saved-project-name> --team` to preflight a saved live outcome and running team fixture. This checks existing state; it does not create an outcome or run a model.
