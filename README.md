# Iteration1

A spatial workspace for AI-assisted software development. Project folders become offices, agents occupy desks, and tickets connect their assignments, handoffs, code changes, and checks. Agents run on **Codex** or **Claude**, side by side in the same office, and Cursor sessions can join too.

![The Iteration1 office](assets/blender-office-review.png)

## Run locally

Requires Node.js 20.19+ and npm. Live agent work needs at least one engine: a ChatGPT account for Codex, or an Anthropic API key for Claude.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:4314**. For a production build, run `npm run build`, then `npm start`.

The sample office works without signing in and is explicitly simulated. For live work, connect an engine from the top bar and choose an existing local project folder:

- **Sign in to Codex** is one click. It installs the pinned Codex CLI into the project if it is missing, then opens ChatGPT sign-in in your browser; the page continues on its own when you finish. Iteration1 uses its own sign-in profile in `~/.iteration1/codex`; it does not switch the Codex desktop app's account. Account model availability and usage limits apply.
- **Connect Claude** is one click and a paste. It opens Anthropic's API key page and puts the cursor in the key box; pasting a key checks it with Anthropic and connects. Anthropic does not allow third-party apps to sign in with a Claude.ai subscription, so Claude agents use an API key, billed by usage to that key's account.

On Windows, complete the one-time Windows sandbox setup from the Codex panel before starting work if requested; Windows asks for administrator approval. `npm run runtime:install` installs the Codex runtime ahead of time if you prefer.

## Use it

1. **Open a project.** Create an office for a local checkout.
2. **Describe the work.** Start work applies a reusable workflow. Choose the **Manager model**, from Codex or Claude. The manager delegates bounded research and review for substantial tasks and remains the implementation owner. A new ticket can also stay in the backlog without running a model.
3. **Follow the office.** Desks show published progress, commands, changes, and task state. Tickets, the compact map, and Inbox provide direct access without moving the camera. Private reasoning is not displayed.
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
| Drag / wheel | Orbit and zoom |
| Overview / Map / Walk | Change the project view |
| WASD / arrows | Move in walk mode |
| E | Inspect the focused desk |
| Esc | Close an inspector or return to overview |
| Sidebar | Tickets, agents, handoffs, team, Inbox, history, tools, settings |

Tools includes workflows, skills, Cursor & Claude setup, development modes, and presentation controls. The recording studio selects camera stops and a clean view; it does not record video.

## Cursor and skills

The `.cursor/mcp.json` configuration and `/office` command connect an existing Cursor session to Iteration1. Cursor controls its own execution and permissions. Reports are marked as reported evidence and cannot automatically verify a task. No separate provider API key is needed by this integration.

Issue an **agent identity** from the Cursor panel to give a session a durable desk, a name that persists across runs, and a track record. The token is shown once and stored only as a hash; put it in `ITERATION1_AGENT_TOKEN` in `.cursor/mcp.json`. Work still runs without one, but publishes unattributed.

Iteration1 can also **launch** a Cursor agent itself through the Cursor SDK, as an alternative to a session reporting in. Those runs use a model chosen here, stream their observable work, and can be stopped from the office. Set `CURSOR_API_KEY` first; launching requires Node 22.13+, which the rest of the app does not.

## Claude agents

Claude agents are full office members, run through the Claude Agent SDK. Choose a Claude model (Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.1) as the manager when you start work, or when you replace any agent, and the office runs exactly as it does on Codex:

- **Same roles and permissions.** The manager is the only writer: it edits files and runs commands in an OS sandbox that confines writes to the project folder, and the run fails instead of running unconfined if that sandbox is unavailable. Workers are read-only. A **Read only** office keeps every Claude agent read-only.
- **Same coordination.** Claude agents use the office tools Codex agents use (delegate, status, handoffs, acknowledgements and ticket updates), served to Claude as MCP tools by the same implementation. A Claude manager delegates to Claude workers; Crunch and Economy modes give workers Claude Haiku 5.5. Finished workers hand off to the manager, and messages and handoffs reach a Claude agent mid-turn.
- **Same evidence.** Commands and file edits are recorded as observed evidence: test commands with the project version they ran against, and edits as a project diff. Plans published with TodoWrite show as the desk's plan. Development modes set Claude's effort and the turn time budget.
- **Continuity.** A Claude agent continues its own conversation across turns and restarts; sessions are kept in `~/.iteration1/claude`, apart from your own Claude Code history. It can be stopped, steered and replaced like any desk.

The API key is saved only on this computer (`~/.iteration1/anthropic-key.json`, readable only by you) and never sent back to the page. `ANTHROPIC_API_KEY` in the environment also works and takes precedence. Claude agents do not use Codex approval prompts or fast mode.

Reusable manager, handoff, and review skills live in `skills/`. The app can install them into a project's `.agents/skills` without overwriting differing instructions.

## Validation

```sh
npm test
```

The test command builds the production assets first because the API tests exercise the production server.

Tests cover lifecycle, delegation, dependencies, evidence, permissions, model replacement, checkpointing, paired-office transport, one-click Codex sign-in, and Claude office agents using isolated deterministic test adapters for Codex and the Claude Agent SDK. They do not establish live model quality or headset performance.

`examples/project-starter` is a small React starting point. `examples/project-result` preserves a completed agent-built feature, with its own tests and setup. [Architecture and execution boundaries](docs/architecture.md).

## Local data

State, checkpoints, and pairing credentials remain in ignored `.office/` storage. The app listens on loopback and validates requests. The separate team listener exposes only pairing/status/handoff operations on a trusted network; see the team guide before connecting. Do not expose the execution API publicly.

Optional configuration: `PORT`, `OFFICE_DATA_DIR`, `OFFICE_CODEX_HOME`, `OFFICE_CODEX_BIN`, `OFFICE_CODEX_ARGS`, `OFFICE_TEAM_PORT`, `ANTHROPIC_API_KEY`, `OFFICE_CLAUDE_HOME`, and `OFFICE_CLAUDE_KEY_FILE`. Credentials are never part of this repository.

## Assets and VR

The office geometry and procedural city were created for this project. The runtime model is included at `public/models/office-shell.glb`; asset provenance is in `assets/`. Blender is optional for authoring and is not started by the app. From the repository root, an explicitly launched Blender session can run `scripts/build_office_assets.py`; `ITERATION1_ROOT` overrides its output root. That script replaces the active scene, so use a fresh Blender file.

Three.js WebXR provides an initial headset path. Headset comfort, controller behavior, and production VR performance are unverified; the supported demonstration is the desktop walkthrough.
