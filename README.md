# Iteration1

A spatial workspace for AI-assisted software development. Workspaces hold projects. Each project is a cloud on that workspace’s sky; zooming into a cloud opens the agents, tickets, and desks for that project only.

![The Iteration1 office](assets/blender-office-review.png)

## Run locally

Requires Node.js 20.19+ and npm. Live agent work also requires the Codex CLI and a supported signed-in account.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:4314**. For a production build, run `npm run build`, then `npm start`.

The sample office works without signing in and is explicitly simulated. For live work, connect Codex through the app and choose an existing local project folder. Iteration1 uses its own sign-in profile in `~/.iteration1/codex`; it does not switch the Codex desktop app's account. Account model availability and usage limits apply.

Provider accounts can also be connected through the browser without importing a local CLI login. Codex supports pasting its localhost callback URL, Claude supports a new sign-in into an app-owned profile, and Cursor's SDK creates a dedicated app key. [Connection steps, credential storage, and deployment boundaries](docs/provider-connections.md).

On Windows, `npm run runtime:install` installs the pinned project-local Codex runtime. Restart Iteration1 after installation. Complete Windows sandbox setup from the connection panel before starting work if requested.

## Use it

1. **Pick a workspace, then a project.** The default view is the sky for the selected workspace. Each cloud is one project in that workspace — not every project you have ever opened. Scroll toward a cloud to open it; scroll back out or press Esc to return.
2. **Describe the work.** Start work applies a reusable workflow. The manager delegates bounded research and review for substantial tasks and remains the implementation owner. A new ticket can also stay in the backlog without running a model.
3. **Follow the project.** The expanded view is still the office desks: published progress, commands, changes, and task state. The sidebar keeps tickets, agents, start work, connections, and settings next to that view. Private reasoning is not displayed.
4. **Coordinate.** Handoffs connect findings to assignments. Declared file scopes and dependencies help sequence work. Pair a teammate's office to exchange status and context across separate checkouts.
5. **Inspect the result.** Open the diff, recorded checks, and feature URL. Verification requires acceptance checks and evidence; an agent's completion message alone is insufficient. The feature's development server must remain running.

Replacing an agent preserves its task and handoff. Development modes adjust the next turn's model policy, reasoning, concurrency, and time budget. Checkpoints support inspection and branching; they are not a substitute for Git review.

## Team offices

Each participant runs Iteration1 with their own checkout and account. **Team** creates or accepts a short-lived invitation. Pairing shares assignments and explicit handoffs; it does not synchronize files or merge branches.

The current transport supports **one real paired teammate per project**. The visual district supports nine offices with selective interior detail; the **+** control adds local visual previews, not authenticated teammates. [Connection guide and limitations](docs/team-offices.md).

To rehearse two connected offices without model calls:

```sh
npm run build
npm run demo:team
```

Open **http://127.0.0.1:4351** and **http://127.0.0.1:4352**. Pair Alex and Blair through Team using the loopback address. These offices use test agents and real HTTP transport, clearly labeled in the UI.

## Controls

| Control | Action |
| --- | --- |
| Drag / wheel on the sky | Pan infinitely, and zoom toward the cursor. Crossing the zoom threshold on a nearby cloud opens that project |
| Esc / zoom out | Leave a project and return to its workspace sky |
| Overview / Map / Walk | Change the expanded project view |
| WASD / arrows | Move in walk mode |
| E | Inspect the focused desk |
| Sidebar | Tickets, agents, start work, connections, settings, plus handoffs, team, Inbox, history, and tools |

Tools includes workflows, skills, Cursor setup, development modes, and presentation controls. The recording studio selects camera stops and a clean view; it does not record video.

## Cursor and skills

The `.cursor/mcp.json` configuration and `/office` command connect an existing Cursor session to Iteration1. Cursor controls its own execution and permissions. Reports are marked as reported evidence and cannot automatically verify a task. No separate provider API key is needed by this integration.

**Sign in once** from the Cursor panel to give your sessions a durable desk, a name that persists across runs, and a track record. Iteration1 uses Auth0 with Authorization Code and PKCE: it opens a browser tab, you authenticate, and the redirect lands back on loopback. Tokens stay in ignored `.office/` storage, so nothing secret belongs in `.cursor/mcp.json` and the MCP server holds no credential at all. Work still runs signed out, but publishes unattributed.

Connect a tenant once in the panel, or set `ITERATION1_AUTH0_DOMAIN` and `ITERATION1_AUTH0_CLIENT_ID`. Use an Auth0 **Native** application, which is a public client with no secret, and allow `http://127.0.0.1:4314/auth/callback` as a callback URL.

Iteration1 can also **launch** a Cursor agent itself through the Cursor SDK, as an alternative to a session reporting in. Those runs use a model chosen here, stream their observable work, and can be stopped from the office. Set `CURSOR_API_KEY` first; launching requires Node 22.13+, which the rest of the app does not.

## Codex CLI sessions

A **Codex CLI** session you run yourself can report into the office over MCP too, on its own ChatGPT sign-in, which stays separate from the office's Codex profile. Open **Connections → Codex → Use an existing Codex CLI session**, copy the connect command (it runs `codex mcp add` and points the server at that project), then copy the start command. Its desk tools are `office_codex_start`, `office_codex_update` and `office_codex_finish`; reports are labeled `codex-reported`, and it shares the per-project writer lock with Cursor and Claude Code.

## Claude agents

**Claude Code connects over MCP, with no API key.** An existing Claude Code session reports into the office the same way a Cursor session does, using your own Claude sign-in and model. In this repository the checked-in `.mcp.json` and `/office` command are all you need: open Claude Code here, approve the `iteration1` server, and run `/office`. For another project, open **Connections → Claude** and copy the connect command, which runs `claude mcp add` with project scope, then copy the start command to open Claude Code with the office prompt. The desk tools are `office_claude_start`, `office_claude_update` and `office_claude_finish`, alongside the shared `office_open`, `office_status`, `office_identify`, `office_run_doc` and `office_dispatch`. Cursor and Claude Code share one writer lock per project, Claude Code reports are labeled `claude-reported` (self-reported in run docs), and they publish under the Auth0 account signed in to the office. Like Cursor, the office observes a Claude Code session but cannot stop it.

Iteration1 can also **launch** Claude agents itself through the Claude Agent SDK. Open **Connections → Claude** and sign in with Claude, then expand **Launch Claude from the office**. Alternatively, create an Anthropic API key from the link there and paste it once: it is checked with Anthropic and saved only on this computer (`~/.iteration1/anthropic-key.json`, readable only by you). `ANTHROPIC_API_KEY` in the environment also works and takes precedence. Then describe the task and choose a model (Claude Opus 5.5 by default) and access. An editing agent may change files and run commands in an OS sandbox that confines writes to the project folder; if the sandbox is unavailable the run fails instead of running unconfined. A read-only agent can only read and search. Like a Codex desk, a Claude desk streams its observable work, takes messages while it works, and continues the same conversation when you message it after it finishes (sessions are kept in `~/.iteration1/claude`, apart from your own Claude Code history). It can be stopped from its desk. Usage follows the connected Claude account or API key's billing and limits.

Reusable manager, handoff, and review skills live in `skills/`. The app can install them into a project's `.agents/skills` without overwriting differing instructions.

## Validation

```sh
npm test
```

The test command builds the production assets first because the API tests exercise the production server.

Tests cover lifecycle, delegation, dependencies, evidence, permissions, model replacement, checkpointing, and paired-office transport using isolated deterministic test adapters. They do not establish live model quality or headset performance.

`examples/project-starter` is a small React starting point. `examples/project-result` preserves a completed agent-built feature, with its own tests and setup. [Architecture and execution boundaries](docs/architecture.md).

## Local data

State, checkpoints, and pairing credentials remain in ignored `.office/` storage. The app listens on loopback and validates requests. The separate team listener exposes only pairing/status/handoff operations on a trusted network; see the team guide before connecting. Do not expose the execution API publicly.

Optional configuration: `PORT`, `OFFICE_DATA_DIR`, `OFFICE_CODEX_HOME`, `OFFICE_CODEX_BIN`, `OFFICE_CODEX_ARGS`, `OFFICE_CLAUDE_HOME`, `OFFICE_CURSOR_AUTH_FILE`, and `OFFICE_TEAM_PORT`. Credentials are never part of this repository.

## Assets and VR

The default shell is a three.js cloud field in the same scene as the office. The city and district metaphor is no longer the starting view; those objects stay in the renderer for team and recording paths but are hidden on the sky and on a normal project open. The office geometry is still the expanded project. The runtime model is included at `public/models/office-shell.glb`; asset provenance is in `assets/`. Blender is optional for authoring and is not started by the app. From the repository root, an explicitly launched Blender session can run `scripts/build_office_assets.py`; `ITERATION1_ROOT` overrides its output root. That script replaces the active scene, so use a fresh Blender file.

Cloud layout and workspace membership persist in `.office/state.json`. Dragging a cloud writes its position; removing a workspace rehomes its projects instead of orphaning them. The last workspace cannot be removed. Semantic zoom and the puff meshes are real but still rough: puff lighting, empty-sky composition, and team-district framing from the sky are unfinished.

Three.js WebXR provides an initial headset path. Headset comfort, controller behavior, and production VR performance are unverified; the supported demonstration is the desktop walkthrough.
