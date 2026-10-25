# Iteration1

A spatial workspace for AI-assisted software development. A **workspace** is a working set of projects. Each project is a **cloud** on that workspace’s sky; zooming into a cloud opens the agents, tickets, and desks for that project only. Agents run on **Codex** or **Claude**, side by side, and Cursor sessions can join too.

![The Iteration1 office](assets/blender-office-review.png)

## Cloud workspaces

There are two layers here, and they are easy to mix up.

**What is live** is a local workspace sky in the companion. Pick a workspace, see only that workspace’s projects as 3D clouds, zoom into a cloud to open its office desks. Codex, Claude, Cursor, tickets, and pairing all still run against those desks.

**What is not live** is sharing those workspaces — a shared drive crossed with Slack, with invites, per-project access, and search. That contract lives in `src/cloud/` so sharing and search can be built against one shape. Do not route companion traffic through it.

Why the city went away: the office-block downtown put every checkout in one implied neighborhood. An unrelated side quest looked like a neighbor, and there was no way to keep one working set on screen. A workspace is that working set.

### The live sky

Before this change, `tag: "WORKSPACE 01"` on a room was a label. There was no workspace entity, and every project lived in one flat list. A workspace is now a real record on saved state (`state.workspaces` in `.office/state.json`). Each room has a `workspaceId`. The sky only draws rooms in the selected workspace.

The picker in the top bar creates, renames, and removes workspaces. Switching one changes which clouds you see. New projects take an optional `workspaceId` and otherwise land in the current workspace.

Older save files have no workspaces. On load, `initWorkspaces` in `server/workspaces.mjs` gathers every existing room into **My workspace** and gives each a cloud spot, so nothing disappears. Saved state stays `version: 1` and is migrated in place: bumping the version would make the server reject the file and reseed, which would destroy existing projects.

Projects are never orphaned. Removing a workspace moves its rooms to another workspace and re-spots those clouds so they do not land on one already in that sky. The last workspace cannot be removed, because there would be nowhere to put them. There is a cap of 24 workspaces.

A **room is a project, and a project is a cloud**. Position (`cloud.x`, `cloud.y`, `cloud.depth`) is stored on the room, so a drag survives reload. Depth is only for parallax when you pan; it is not a second map. New projects land on a ring that widens as the workspace fills (`cloudSpot`), so a new cloud never stacks on an old one.

The clouds are meshes in the existing three.js scene (`src/CloudField.ts`), not a second engine and not an HTML overlay. Pan is unbounded. Zoom is anchored to the cursor, not the view center, so the cloud you are pointing at stays under the pointer.

Zooming is semantic, not just a scale. Crossing a height threshold on the hovered or nearest cloud interpolates the same camera into the office desks that already existed. That expanded view is still the agent office: published progress, commands, changes, and task state, with a sidebar of tickets, agents, start work, connections, and settings. Zooming out, or Esc, returns you to that workspace’s sky.

This is the gesture language taken from [SyncHub](https://github.com/gtiosclub/SyncHub), and three things were deliberately not copied. SyncHub’s zoom is two discrete SwiftUI views with a spring that fakes depth; ours stays in one three.js camera. SyncHub anchors pinch to the view center, so content drifts off the pointer; ours follows the cursor. SyncHub lays cards out from eight hardcoded offsets plus random jitter and persists neither pan nor zoom; our spots are stable and written back to state.

The city and team district stay compiled so recording and paired-office framing are not deleted. They are hidden on the sky and on a normal project open. They are not the starting metaphor anymore.

What is still rough on the live sky: puff lighting and scale, empty-sky composition, opening a project from a URL, and showing a teammate district without leaving the sky.

Files to touch for the live sky: `server/workspaces.mjs`, `src/CloudField.ts`, `src/scene.ts`, `src/App.tsx`, `src/types.ts` (`Workspace`, `CloudSpot`, `Altitude`). Routes: `GET/POST /api/workspaces`, `PATCH/DELETE /api/workspaces/:id`, `POST /api/workspaces/:id/rooms`, `POST /api/rooms/:id/workspace`, `POST /api/rooms/:id/cloud`. [Why this is shaped this way](docs/architecture.md#why-the-sky-replaced-the-city).

### Shared access (planned)

The access model below is the contract for joining and sharing. It is not wired to the live sky.

- **Workspaces** there are company or public worlds joined by invite or email. Nothing is shared or searchable across them.
- **Projects as clouds** would show your active work in front and other people’s visible projects as faint background clouds.
- **Share links** would open a project document for people with access.
- **Work still runs locally.** Each person runs their own agent on their own account and computer; a future host stores and shares projects, it does not run agents.
- **Copying an agent** would take name, role, instructions, skills, tools and engine, never history or the project’s code.
- **Search** comes later: find agents and projects in your workspace that do similar things.

Each project has a default level for everyone in its workspace, and the owner can share it with individual people, as in Google Docs. A person gets the higher of the two, with each switch on if either has it on.

| Level | Can |
|---|---|
| None | See nothing: the project is not on the canvas or in search, and its share link refuses |
| Viewer | See the name, description and agents |
| Commenter | View and comment |
| Collaborator | Comment, run agents and upload work |
| Owner | Everything, plus sharing and transferring ownership |

Two switches apply to viewers and commenters: **code and history**, and **copy agents**. Collaborators and owners always have both.

`src/cloud/model.ts` defines that shape and `accessFor()`. `src/cloud/seed.json` is placeholder data (two workspaces, 18 projects, 29 agents, including projects hidden from the signed-in user). `src/cloud/data.ts` loads it. Change those files if you are working on sharing or search. The running sky uses `server/workspaces.mjs` and `state.workspaces`.


## Run locally

Requires Node.js 20.19+ and npm. Live agent work needs at least one engine: a ChatGPT account for Codex, or an Anthropic API key for Claude.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:4314**. For a production build, run `npm run build`, then `npm start`.

The sample office works without signing in and is explicitly simulated. For live work, connect an engine from the top bar and choose an existing local project folder:

- **Codex** signs in from **Connections → Codex**. It installs the pinned Codex CLI into the project if it is missing, then opens ChatGPT sign-in in your browser; the page continues on its own when you finish, or you can paste its localhost callback URL. Iteration1 uses its own sign-in profile in `~/.iteration1/codex`; it does not switch the Codex desktop app's account. Account model availability and usage limits apply.
- **Claude** connects from **Connections → Claude**: sign in with Claude into an app-owned profile, or paste an Anthropic API key, which is checked with Anthropic and saved only on this computer.
- **Cursor**'s SDK creates a dedicated app key from **Connections → Cursor**.

Provider accounts connect through the browser without importing a local CLI login. [Connection steps, credential storage, and deployment boundaries](docs/provider-connections.md).

On Windows, `npm run runtime:install` installs the pinned project-local Codex runtime. Restart Iteration1 after installation. Complete Windows sandbox setup from the connection panel before starting work if requested.

## Use it

1. **Pick a workspace, then a project.** The default view is the sky for the selected workspace. Each cloud is one project in that workspace — not every project you have ever opened. Scroll toward a cloud to open it; scroll back out or press Esc to return.
2. **Describe the work.** Start work applies a reusable workflow. Choose the **Manager model**, from Codex or Claude. The manager delegates bounded research and review for substantial tasks and remains the implementation owner. A new ticket can also stay in the backlog without running a model.
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

Tools includes workflows, skills, Cursor & Claude setup, development modes, and presentation controls. The recording studio selects camera stops and a clean view; it does not record video.

## Cursor and skills

The `.cursor/mcp.json` configuration and `/office` command connect an existing Cursor session to Iteration1. Cursor controls its own execution and permissions. Reports are marked as reported evidence and cannot automatically verify a task. No separate provider API key is needed by this integration.

**Sign in once** from the Cursor panel to give your sessions a durable desk, a name that persists across runs, and a track record. Iteration1 uses Auth0 with Authorization Code and PKCE: it opens a browser tab, you authenticate, and the redirect lands back on loopback. Tokens stay in ignored `.office/` storage, so nothing secret belongs in `.cursor/mcp.json` and the MCP server holds no credential at all. Work still runs signed out, but publishes unattributed.

Connect a tenant once in the panel, or set `ITERATION1_AUTH0_DOMAIN` and `ITERATION1_AUTH0_CLIENT_ID`. Use an Auth0 **Native** application, which is a public client with no secret, and allow `http://127.0.0.1:4314/auth/callback` as a callback URL.

Iteration1 can also **launch** a Cursor agent itself through the Cursor SDK, as an alternative to a session reporting in. Those runs use a model chosen here, stream their observable work, and can be stopped from the office. Set `CURSOR_API_KEY` first; launching requires Node 22.13+, which the rest of the app does not.

## Codex CLI sessions

A **Codex CLI** session you run yourself can report into the office over MCP too, on its own ChatGPT sign-in, which stays separate from the office's Codex profile. Open **Connections → Codex → Use an existing Codex CLI session**, copy the connect command (it runs `codex mcp add` and points the server at that project), then copy the start command. Its desk tools are `office_codex_start`, `office_codex_update` and `office_codex_finish`; reports are labeled `codex-reported`, and it shares the per-project writer lock with Cursor and Claude Code.

## ASI:One (Fetch.ai) agents

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Four uAgents let the office's owner run it from ASI:One. Two talk to people over the Agent Chat Protocol; the other two work behind them. All four run on your computer, are registered on Agentverse through their own mailboxes (an outbound connection, so the office stays on loopback and each agent's server listens only on `127.0.0.1`), and hold no office credential: missions publish under the account signed in to the office.

| Agent | Address | Role |
|---|---|---|
| **iteration1-office** | `agent1q0r5evneykvtpltu348zc0nq6a32lwuaq4ywjt0twxw7kz9945y0qgxn6mk` | Chat. Office status, run docs, approvals, alerts, reviews on request, and missions after `confirm` |
| **iteration1-planner** | printed at startup | Chat. Turns ideas into Jira stories and hands a story to the office as a mission |
| **iteration1-watcher** | `agent1qvjcfmt858hr6g47nu6jymzd7sz556us5a4ydjraa9vjevk94x5zw2d2npx` | Follows the office's live state and tells the other three what changed |
| **iteration1-reviewer** | printed at startup | Judges finished work against its acceptance criteria |

**Talking to the office agent.** `status` lists tasks, blockers and who is working; `report on <task>` shows a run doc that separates verified receipts from self-reported ones; `review <task>` asks the reviewer for a verdict; `approvals` lists commands waiting in the office; `alerts` shows what the watcher and reviewer reported recently; `mission: <what to build>` hands a new mission to the implementation manager after `confirm`.

**Talking to the planner.** `plan: <idea>` drafts an epic and stories with acceptance criteria, `confirm` creates them in Jira, `backlog` lists open issues, and `start ONB-12` asks the office agent to run that story. The mission's task is titled with the issue key, so as the watcher reports progress the planner comments on the issue and moves it to Done once the office has verified the work; unverified work stays open.

**How they work together.** The watcher follows the office's event stream and sends each batch of changes (tasks that block, reach review or finish, new approvals, new missions, pauses, the office going offline) to the other three. The office agent forwards them to its owners and keeps the last 20 for `alerts`, in case a message an agent starts doesn't appear in the chat. The reviewer reviews every task that reaches review and sends its verdict through the office agent. The planner hands missions to the office agent, which starts them only for a paired owner. Agents reach each other directly on `127.0.0.1` and accept team messages only from each other's addresses, derived from the seeds each keeps in `.office/`. The watcher reconnects with backoff, compares against the last state it saw so nothing is missed while the office restarts, and drops repeats within a minute.

- **Pairing.** Only paired ASI:One addresses can use the office agent; the planner trusts the same people. At startup the office agent prints a single-use code; send `pair <code>` from ASI:One. The code is accepted anywhere in a message, since ASI:One may reword what you type, and pairing locks after five wrong codes until restart. Paired addresses and seeds are kept in `.office/` (git-ignored). To check pairing without ASI:One, run `agents/pair_test.py <code>`: a local uAgent sends `pair <code>` and `status` and prints the replies (`PAIR_TEST_TARGET=planner` talks to the planner). It stays paired until you remove its address from `.office/fetch-agent.json`.
- **Limits.** Missions need an explicit `confirm`, or a `start` the owner sends the planner. Command approvals, stopping agents and pausing stay in the Iteration1 app; no agent can approve anything, and the reviewer only reads. The planner works in one Jira project and only sends its credentials to an `https://*.atlassian.net` site. Chat text, Jira text and office content are treated as data.
- **Model.** With an ASI:One API key, the reviewer judges each criterion against the receipts and the planner drafts stories with ASI:One's `asi1` model. Without one, the reviewer reports the office's own checks and the planner splits an idea into one story per line.

```sh
python -m venv .office/runtime/agent-venv
.office/runtime/agent-venv/Scripts/python -m pip install -r agents/requirements.txt   # bin/python on macOS and Linux
.office/runtime/agent-venv/Scripts/python agents/configure.py   # Jira site, email, API token, project key, ASI:One key
.office/runtime/agent-venv/Scripts/python agents/run_all.py     # starts all four and restarts any that exits
```

With the office running (`npm start`), open each `agentverse.ai/inspect` link the agents print and choose **Connect → Mailbox** once per agent. `configure.py` checks the Jira token and model key before saving them to `.office/jira.json` and `.office/asi1.json`. On Windows on ARM, uAgents needs `grpcio`, which has no ARM64 wheel; create the venv from an x64 Python (for example the `python` NuGet package unpacked under `.office/runtime/python-x64`), which runs under emulation. Tests: `python -m unittest discover agents`.

## Claude agents

Claude agents are full office members, run through the Claude Agent SDK. Choose a Claude model (Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.1) as the manager when you start work, or when you replace any agent, and the office runs exactly as it does on Codex:

- **Same roles and permissions.** The manager is the only writer: it edits files and runs commands in an OS sandbox that confines writes to the project folder, and the run fails instead of running unconfined if that sandbox is unavailable. Workers are read-only. A **Read only** office keeps every Claude agent read-only.
- **Same coordination.** Claude agents use the office tools Codex agents use (delegate, status, handoffs, acknowledgements and ticket updates), served to Claude as MCP tools by the same implementation. A Claude manager delegates to Claude workers; Crunch and Economy modes give workers Claude Haiku 5.5. Finished workers hand off to the manager, and messages and handoffs reach a Claude agent mid-turn.
- **Same evidence.** Commands and file edits are recorded as observed evidence: test commands with the project version they ran against, and edits as a project diff. Plans published with TodoWrite show as the desk's plan. Development modes set Claude's effort and the turn time budget.
- **Continuity.** A Claude agent continues its own conversation across turns and restarts; sessions are kept in `~/.iteration1/claude`, apart from your own Claude Code history. It can be stopped, steered and replaced like any desk.

Claude agents run on the Claude account signed in from **Connections → Claude**, or on an Anthropic API key pasted there. The key is saved only on this computer (`~/.iteration1/anthropic-key.json`, readable only by you) and never sent back to the page. `ANTHROPIC_API_KEY` in the environment also works and takes precedence. Usage follows that account's or key's billing and limits. Claude agents do not use Codex approval prompts or fast mode.

**Claude Code sessions connect over MCP, with no API key.** An existing Claude Code session reports into the office the same way a Cursor session does, using your own Claude sign-in and model. In this repository the checked-in `.mcp.json` and `/office` command are all you need: open Claude Code here, approve the `iteration1` server, and run `/office`. For another project, open **Connections → Claude** and copy the connect command, which runs `claude mcp add` with project scope, then copy the start command to open Claude Code with the office prompt. The desk tools are `office_claude_start`, `office_claude_update` and `office_claude_finish`, alongside the shared `office_open`, `office_status`, `office_identify`, `office_run_doc` and `office_dispatch`. Cursor and Claude Code share one writer lock per project, Claude Code reports are labeled `claude-reported` (self-reported in run docs), and they publish under the Auth0 account signed in to the office. Like Cursor, the office observes a Claude Code session but cannot stop it.

Reusable manager, handoff, and review skills live in `skills/`. The app can install them into a project's `.agents/skills` without overwriting differing instructions.

## Validation

```sh
npm test
```

The test command builds the production assets first because the API tests exercise the production server.

Tests cover lifecycle, delegation, dependencies, evidence, permissions, model replacement, checkpointing, paired-office transport, one-click Codex sign-in, and Claude office agents using isolated deterministic test adapters for Codex and the Claude Agent SDK. They do not establish live model quality or headset performance.

`examples/project-starter` is a small React starting point. `examples/project-result` preserves a completed agent-built feature, with its own tests and setup. [Architecture and execution boundaries](docs/architecture.md). The Convex backend and env host are in [docs/backend.md](docs/backend.md).

## Local data

State, checkpoints, and pairing credentials remain in ignored `.office/` storage. The app listens on loopback and validates requests. The separate team listener exposes only pairing/status/handoff operations on a trusted network; see the team guide before connecting. Do not expose the execution API publicly.

Optional configuration: `PORT`, `OFFICE_DATA_DIR`, `OFFICE_CODEX_HOME`, `OFFICE_CODEX_BIN`, `OFFICE_CODEX_ARGS`, `OFFICE_TEAM_PORT`, `ANTHROPIC_API_KEY`, `OFFICE_CLAUDE_HOME`, `OFFICE_CLAUDE_KEY_FILE`, and `OFFICE_CURSOR_AUTH_FILE`. Credentials are never part of this repository.

## Assets and VR

The default shell is a three.js cloud field in the same scene as the office. The city and district metaphor is no longer the starting view; those objects stay in the renderer for team and recording paths but are hidden on the sky and on a normal project open. The office geometry is still the expanded project. The runtime model is included at `public/models/office-shell.glb`; asset provenance is in `assets/`. Blender is optional for authoring and is not started by the app. From the repository root, an explicitly launched Blender session can run `scripts/build_office_assets.py`; `ITERATION1_ROOT` overrides its output root. That script replaces the active scene, so use a fresh Blender file.

Cloud layout and workspace membership persist in `.office/state.json`. Dragging a cloud writes its position; removing a workspace rehomes its projects instead of orphaning them. The last workspace cannot be removed. Semantic zoom and the puff meshes are real but still rough: puff lighting, empty-sky composition, and team-district framing from the sky are unfinished.

Three.js WebXR provides an initial headset path. Headset comfort, controller behavior, and production VR performance are unverified; the supported demonstration is the desktop walkthrough.
