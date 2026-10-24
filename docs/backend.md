# Iteration 1

Backend for the shared agent world. Sandboxes default to hosted E2B. Convex coordinates sessions. `env-host` is an optional self-hosted provider and is not used unless `SANDBOX_PROVIDER=env-host`.

Code is in `convex/`, `env-host/`, and `agent-env/`. The office app is unchanged.

Auth is not enforced yet. `ownerId` and `userId` are explicit arguments so functions can be called from the Convex dashboard. The next slice adds GitHub auth and `requireRole`.

## Setup

From the repo root, with Node 20:

```sh
npm install
npm install --prefix env-host
```

The default path does not start `env-host`. Start it only when `SANDBOX_PROVIDER=env-host` (see `env-host/README.md`). On a machine without Docker:

```powershell
$env:ENV_HOST_SECRET = "dev-secret"
$env:ENV_HOST_MODE = "stub"
npm --prefix env-host run dev
```

On the VM, build the image first: `docker build -t agent-env agent-env`. Leave `ENV_HOST_MODE` unset so it uses Docker. Set `PUBLIC_IP` to the VM address.

Use a **local** Convex deployment. A cloud deployment cannot reach `http://127.0.0.1:8787`.

```sh
npx convex dev
```

Leave that process running. In another terminal:

```sh
npx convex env set E2B_API_KEY <e2b key>
npx convex env set SANDBOX_GIT_TOKEN <git token for private clones, omit for public repos>
```

`SANDBOX_PROVIDER` defaults to `e2b`. Set it to `env-host` only for the optional gVisor host, and then also set `ENV_HOST_URL` and `ENV_HOST_SECRET`. E2B sandboxes last `E2B_TIMEOUT_MS` (default 10 minutes). One minute before that, Convex commits dirty work and pushes the session branch. An empty `git status --porcelain` skips the commit and still counts as success. If `lastActiveAt` is within the last 10 minutes and `sandboxExtensions` is below `E2B_MAX_EXTENSIONS` (default 5), the sandbox is extended. Otherwise it is destroyed. `E2B_MAX_EXTENSIONS` is a hard cap.

In the dashboard (or via `npx convex run`):

1. `projects:create` with `name`, `ownerId`, `description`, and `repoUrl` (https) when the project has a remote. Omit `repoUrl` for a local folder with no remote.
2. `sessions:start` with the returned `projectId`, a `userId`, and `agent` of `claude`, `cursor`, `codex`, or `droid`. A project with no `repoUrl` gets an empty workspace. Upload files with `sessions:writeFile`.
3. `sessions:get` until `status` is `ready` and `sandboxId` is set. Agents call `sessions:exec`, `sessions:readFile`, and `sessions:writeFile`. Do not call the sandbox URL.
4. `events:byProject` shows `project.created`, `session.started`, and `session.ready`.

If launch fails, `status` becomes `error` and `events` contains `session.error` with the reason.

## Public functions

Teammates call these with `ConvexHttpClient`. Args use Convex validators. Document ids are Convex `Id`s.

| Function | Args | Returns |
| --- | --- | --- |
| `projects.create` | `{ name, ownerId, repoUrl?, description }` | `projectId`. `repoUrl` is optional. When present it must be https with no credentials. Omit it for a folder with no remote. |
| `projects.buildOn` | `{ parentId, name, ownerId, repoUrl, description }` | `projectId`. Sets `builtOn` to `parentId`. |
| `projects.list` | `{}` | projects, newest first |
| `projects.get` | `{ projectId }` | project, or throws if missing |
| `projects.lineage` | `{}` | `{ nodes, edges }`. An edge is `{ from: parentId, to: childId }`. |
| `sessions.start` | `{ projectId, userId, agent }` | `sessionId`. Inserts `status: "provisioning"`, `location: "cloud"`, `branch: "visit/<sessionId>"`, then schedules launch. A project with `repoUrl` is cloned. A project with no `repoUrl` gets an empty workspace at the provider directory. |
| `sessions.get` | `{ sessionId }` | session, including `status`, `sandboxId`, `sandboxExtensions`, `previewUrl`, and `previewStatus`. Does not return `envUrl`. `previewStatus` is `starting`, `live`, or `error` after a preview is requested. |
| `sessions.exec` | `{ sessionId, cmd, cwd?, timeoutMs? }` | `{ stdout, stderr, code }`. Session must be `ready`. Updates `lastActiveAt` and does not write an event for that update. `cwd` defaults to the provider workspace (`/home/user/workspace` on E2B, `/workspace` on env-host). `timeoutMs` defaults to 60000 and must be an integer from 1 to 120000. Paths outside the repo directory are rejected. Writes `session.exec`. |
| `sessions.readFile` | `{ sessionId, path }` | `{ content }`. Session must be `ready`. Updates `lastActiveAt`. Paths outside the repo directory are rejected. Does not write an event. |
| `sessions.writeFile` | `{ sessionId, path, content }` | `{ ok: true }`. Session must be `ready`. Updates `lastActiveAt` and does not write an event for that update. Paths outside the repo directory are rejected. Writes `session.write_file`. |
| `sessions.deleteFile` | `{ sessionId, path }` | `{ ok: true }`. Session must be `ready`. Removes that file. Updates `lastActiveAt`. Paths outside the repo directory are rejected. Writes `session.delete_file`. |
| `sessions.startPreview` | `{ sessionId, command?, port? }` | `{ previewUrl, previewStatus: "live" }`. Session must be `ready`. Updates `lastActiveAt`. `port` defaults to 3000 and must be an integer from 1 to 65535. With no `command`, reads `package.json` and runs `npm install`, then `npm run dev` bound to `0.0.0.0` on that port (Next.js uses `--hostname`). The dev server stays in the background. Waits up to 90s for the port, then stores the E2B public URL. Writes `session.preview_ready`. On failure sets `previewStatus` to `error` and writes `session.preview_error`. |
| `sessions.stop` | `{ sessionId }` | `sessionId`. Marks `stopped` and schedules teardown. Calling it again retries teardown. |
| `sessions.heartbeat` | `{ sessionId }` | `{ ok: true, lastActiveAt }`. Does not write an event. |
| `events.byProject` | `{ projectId }` | up to 100 events, newest first |
| `events.recent` | `{}` | up to 50 events, newest first |
| `leases.acquire` | `{ projectId, path, sessionId }` | `{ ok: true }` or `{ ok: false, heldBy }`. 5-minute expiry. The same session renews. One transaction. |
| `leases.release` | `{ projectId, path, sessionId }` | `{ ok: true }`. Throws if another live session holds it. |
| `handoffs.create` | `{ sessionId, from, to, ref, note }` | `handoffId`. `from` and `to` are `local` or `cloud` and must differ. Also sets the session `location` to `to`. |
| `handoffs.latest` | `{ sessionId }` | newest handoff, or `null` |
| `contributions.propose` | `{ fromSessionId, toProjectId, branch, summary }` | `contributionId` with status `proposed` |
| `contributions.setStatus` | `{ contributionId, status }` | `contributionId`. `status` is `proposed`, `merged`, or `rejected`. |

`agent` is `claude`, `cursor`, `codex`, or `droid`. `repoUrl` must be https and must not contain credentials.

`projects.create` `repoUrl` is now optional. `projects.buildOn` still requires `repoUrl`. Callers that pass `repoUrl` are unchanged. `sessions.start` on a project with no `repoUrl` creates an empty sandbox instead of cloning; upload the tree with `sessions.writeFile`. An empty sandbox requires `SANDBOX_PROVIDER=e2b`. New actions: `sessions.exec`, `sessions.readFile`, `sessions.writeFile`, `sessions.deleteFile`, `sessions.startPreview`. Agents use `exec`, `readFile`, and `writeFile`. `sessions.get` now also returns `previewUrl` and `previewStatus`. `envUrl` is internal: it is still stored on the session for the provider, and `sessions.get` does not return it. `sessions.get` does return `sandboxId` and `sandboxExtensions`. `session.ready` event detail includes provider, URL, and create-to-ready milliseconds. Convex logs `session <id> ready in <ms>ms via e2b|env-host <url>`.

State-changing mutations write an `events` row (`kind` + `detail`). Heartbeat does not. `sessions.exec`, `sessions.writeFile`, and `sessions.deleteFile` write `session.exec`, `session.write_file`, and `session.delete_file`. `sessions.readFile` does not.

## Crons

Every minute, expired leases are deleted. Every 5 minutes, sessions with `lastActiveAt` older than 30 minutes are stopped and torn down.

## Not built yet

Auth, `requireRole`, sharing, presence, prewarm, bare repos on the host, and the teleport CLI. Projects already store `slug`, `visibility` (`private`), and `linkRole` (`viewer`). Creating a project inserts an owner `members` row. `presence` and `tokens` tables exist with no functions.

## Env host and container

Optional. `POST ${ENV_HOST_URL}/envs` with header `authorization: <ENV_HOST_SECRET>` and body `{ id, repoUrl, branch, token? }` returns `{ url }`. The host keeps `POOL_SIZE` idle containers (default 3). A request claims one, calls `POST /attach`, and refills the pool in the background. If none are idle, it cold-starts with `docker run --runtime=runsc` (gVisor). It logs `session <id> ready in <ms>ms via pool|cold <url>`. `DELETE /envs/:id` destroys the container. `GET /pool` returns `{ idle, claimed }`. The VM must have gVisor installed (`runsc`). Stub mode does not use it.

Inside the container, port 3000 serves `/health` (no auth). `/attach`, `/exec`, `/file`, `/git/commit`, `/git/push`, and `/git/pull` require `Authorization: Bearer <ENV_TOKEN>`. `/attach` clones the repo, or fetches when `/workspace` is already a clone, then checks out the branch. File paths that escape `/workspace` are rejected. `GIT_TOKEN` lets clone, push, and pull authenticate to the https origin without putting the token in the remote URL.
