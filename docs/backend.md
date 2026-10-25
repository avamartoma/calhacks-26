# Iteration 1

Backend for the shared agent world. Sandboxes default to hosted E2B. Convex coordinates sessions. `env-host` is an optional self-hosted provider and is not used unless `SANDBOX_PROVIDER=env-host`.

Code is in `convex/`, `env-host/`, and `agent-env/`. The office sends the signed-in user's Auth0 ID token to Convex and no longer passes an owner or user id.

Every public function calls `ctx.auth.getUserIdentity()`. A verified Auth0 ID token supplies `subject` and `email`. With no token, the caller is the offline user `local`, so the office still works signed out and `npx convex run` still works from the dashboard. `projects.create` and `projects.buildOn` store that subject as `ownerId` and, when the token has an email, on the owner `members` row. `sessions.start` stores it as `userId`. Access control is not applied yet.

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
npx convex env set AUTH0_DOMAIN <Auth0 tenant domain, no path>
npx convex env set AUTH0_CLIENT_ID <Auth0 application client id>
```

`AUTH0_DOMAIN` and `AUTH0_CLIENT_ID` must be set on the Convex deployment. Convex refuses the auth config until both exist. Use the office's Auth0 application: the domain is the issuer, and the client id is the ID token audience. The office presents that ID token, which carries the verified email. A call with no JWT is still the user `local`. Do not put tokens in Convex env or in logs.

`SANDBOX_PROVIDER` defaults to `e2b`. Set it to `env-host` only for the optional gVisor host, and then also set `ENV_HOST_URL` and `ENV_HOST_SECRET`. E2B sandboxes last `E2B_TIMEOUT_MS` (default 10 minutes). One minute before that, Convex commits dirty work and pushes the session branch. An empty `git status --porcelain` skips the commit and still counts as success. If `lastActiveAt` is within the last 10 minutes and `sandboxExtensions` is below `E2B_MAX_EXTENSIONS` (default 5), the sandbox is extended. Otherwise it is destroyed. `E2B_MAX_EXTENSIONS` is a hard cap.

In the dashboard (or via `npx convex run`):

1. `projects:create` with `name`, `description`, and `repoUrl` (https) when the project has a remote. Omit `repoUrl` for a local folder with no remote. The owner is the verified identity, or `local` when no JWT is sent.
2. `sessions:start` with the returned `projectId` and `agent` of `claude`, `cursor`, `codex`, or `droid`. A project with no `repoUrl` gets an empty workspace. Upload files with `sessions:writeFile`.
3. `sessions:get` until `status` is `ready` and `sandboxId` is set. Agents call `sessions:exec`, `sessions:readFile`, and `sessions:writeFile`. Do not call the sandbox URL.
4. `events:byProject` shows `project.created`, `session.started`, and `session.ready`.

If launch fails, `status` becomes `error` and `events` contains `session.error` with the reason.

## Public functions

Teammates call these with `ConvexHttpClient`. Args use Convex validators. Document ids are Convex `Id`s.

| Function | Args | Returns |
| --- | --- | --- |
| `projects.create` | `{ name, repoUrl?, description }` | `projectId`. `repoUrl` is optional. When present it must be https with no credentials. Omit it for a folder with no remote. `ownerId` is the Auth0 `sub`, or `local`. |
| `projects.buildOn` | `{ parentId, name, repoUrl, description }` | `projectId`. Sets `builtOn` to `parentId`. The owner is the caller identity, same as `projects.create`. |
| `projects.list` | `{}` | projects, newest first |
| `projects.get` | `{ projectId }` | project, or throws if missing |
| `projects.lineage` | `{}` | `{ nodes, edges }`. An edge is `{ from: parentId, to: childId }`. |
| `sessions.start` | `{ projectId, agent }` | `sessionId`. Inserts `status: "provisioning"`, `location: "cloud"`, `branch: "visit/<sessionId>"`, then schedules launch. `userId` is the Auth0 `sub`, or `local`. A project with `repoUrl` is cloned. A project with no `repoUrl` gets an empty workspace at the provider directory. |
| `sessions.get` | `{ sessionId }` | session, including `status`, `sandboxId`, `sandboxExtensions`, `previewUrl`, `previewStatus`, and `snapshotUrl`. Does not return `envUrl`. `previewStatus` is `starting`, `live`, or `error` after a preview is requested. `snapshotUrl` is the project's last preview image, when one has been stored. |
| `sessions.exec` | `{ sessionId, cmd, cwd?, timeoutMs? }` | `{ stdout, stderr, code }`. Session must be `ready`. Updates `lastActiveAt` and does not write an event for that update. `cwd` defaults to the provider workspace (`/home/user/workspace` on E2B, `/workspace` on env-host). `timeoutMs` defaults to 60000 and must be an integer from 1 to 120000. Paths outside the repo directory are rejected. Writes `session.exec`. |
| `sessions.readFile` | `{ sessionId, path }` | `{ content }`. Session must be `ready`. Updates `lastActiveAt`. Paths outside the repo directory are rejected. Does not write an event. |
| `sessions.writeFile` | `{ sessionId, path, content }` | `{ ok: true }`. Session must be `ready`. Updates `lastActiveAt` and does not write an event for that update. Paths outside the repo directory are rejected. Writes `session.write_file`. |
| `sessions.deleteFile` | `{ sessionId, path }` | `{ ok: true }`. Session must be `ready`. Removes that file. Updates `lastActiveAt`. Paths outside the repo directory are rejected. Writes `session.delete_file`. |
| `sessions.startPreview` | `{ sessionId, command?, port? }` | `{ previewUrl, previewStatus: "live" }`. Session must be `ready`. Updates `lastActiveAt`. `port` defaults to 3000 and must be an integer from 1 to 65535. With no `command`, reads `package.json` and runs `npm install`, then `npm run dev` bound to `0.0.0.0` on that port (Next.js uses `--hostname`). The dev server stays in the background. Waits up to 90s for the port, then stores the E2B public URL. Writes `session.preview_ready`. On failure sets `previewStatus` to `error` and writes `session.preview_error`. |
| `sessions.resume` | `{ projectId, agent? }` | `sessionId`. Same as `sessions.start`. `agent` defaults to `claude`. This is the call a share page makes as soon as it loads. A project that already has a ready session on the saved sandbox returns that session. Otherwise it provisions one, and launch resumes the project's saved sandbox when it still exists. |
| `sessions.stop` | `{ sessionId }` | `sessionId`. Marks `paused` and schedules a pause. The sandbox is paused, not destroyed. Calling it again retries the pause. |
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

`projects.create` and `projects.buildOn` no longer take `ownerId`. `sessions.start` no longer takes `userId`. Both read the caller from `ctx.auth.getUserIdentity()`. `projects.create` `repoUrl` is optional. `projects.buildOn` still requires `repoUrl`. `sessions.start` on a project with no `repoUrl` creates an empty sandbox instead of cloning; upload the tree with `sessions.writeFile`. An empty sandbox requires `SANDBOX_PROVIDER=e2b`. Actions: `sessions.exec`, `sessions.readFile`, `sessions.writeFile`, `sessions.deleteFile`, `sessions.startPreview`. Agents use `exec`, `readFile`, and `writeFile`. `sessions.get` returns `previewUrl`, `previewStatus`, and `snapshotUrl`. `envUrl` is internal: it is still stored on the session for the provider, and `sessions.get` does not return it. `sessions.get` does return `sandboxId` and `sandboxExtensions`. `session.ready` event detail includes provider, URL, and create-to-ready milliseconds. Convex logs `session <id> ready in <ms>ms via e2b|env-host <url>`. Closing a project pauses its sandbox and keeps `projects.sandboxId`. `sessions.resume({ projectId })` is the share-page entry point and follows the same path.

State-changing mutations write an `events` row (`kind` + `detail`). Heartbeat does not. `sessions.exec`, `sessions.writeFile`, and `sessions.deleteFile` write `session.exec`, `session.write_file`, and `session.delete_file`. `sessions.readFile` does not.

## Crons

Every minute, expired leases are deleted. Every 5 minutes, sessions with `lastActiveAt` older than 5 minutes are paused. Heartbeats and file or command activity refresh `lastActiveAt`, so an open office keeps the sandbox running. A paused sandbox stays on the project. The next `sessions.start` or `sessions.resume` connects to it, checks port 3000, and starts the dev server only when that port is quiet. Resumes are limited to 4 per project per minute. Pausing stores a preview screenshot as `projects.lastSnapshot` and a file archive as `projects.backup` (no `node_modules`, and gitignored paths are left out when the workspace is a git repo). If the paused sandbox is gone, launch creates a new one from that archive and starts the preview. New sandboxes use E2B `onTimeout: "pause"`. Convex logs `session <id> open-to-live in <ms>ms via resume|backup` when that path reaches a live preview. The office logs `room <id> open-to-live in <ms>ms`.

## Not built yet

`requireRole`, sharing, presence, prewarm, bare repos on the host, and the teleport CLI. Auth0 JWT verification is configured; it does not yet restrict who can call a function. Projects already store `slug`, `visibility` (`private`), and `linkRole` (`viewer`). Creating a project inserts an owner `members` row, with `email` when the token has one. `presence` and `tokens` tables exist with no functions.

## Env host and container

Optional. `POST ${ENV_HOST_URL}/envs` with header `authorization: <ENV_HOST_SECRET>` and body `{ id, repoUrl, branch, token? }` returns `{ url }`. The host keeps `POOL_SIZE` idle containers (default 3). A request claims one, calls `POST /attach`, and refills the pool in the background. If none are idle, it cold-starts with `docker run --runtime=runsc` (gVisor). It logs `session <id> ready in <ms>ms via pool|cold <url>`. `DELETE /envs/:id` destroys the container. `GET /pool` returns `{ idle, claimed }`. The VM must have gVisor installed (`runsc`). Stub mode does not use it.

Inside the container, port 3000 serves `/health` (no auth). `/attach`, `/exec`, `/file`, `/git/commit`, `/git/push`, and `/git/pull` require `Authorization: Bearer <ENV_TOKEN>`. `/attach` clones the repo, or fetches when `/workspace` is already a clone, then checks out the branch. File paths that escape `/workspace` are rejected. `GIT_TOKEN` lets clone, push, and pull authenticate to the https origin without putting the token in the remote URL.
