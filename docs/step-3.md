# Step 3: access, sharing, and presence

Who can see a project, who can change it, and when a shared sandbox pauses. `presence` is the participant table. There is no second participant table.

Identity comes from `convex/identity.ts` `currentUser()`. No JWT is the offline office user `{ id: "local", email: null, local: true }`. A signed-in Auth0 token is the subject, with the email trimmed and lowercased. Unsigned calls are not rejected when `project.ownerId` is `"local"`.

New projects stay `private`. `projects.create` and `projects.buildOn` set `shareSlug` to the same value as `slug`. `visibility: "link"` is still a stored value. Nothing in this step grants access from `link`, and `sharing.setVisibility` does not accept it.

## requireAccess

`convex/access.ts` exports `requireAccess(ctx, projectId, minRole)`, where `minRole` is `"viewer"` or `"editor"`. It returns the caller's role. Decision order:

1. Missing project throws `Project not found`.
2. `project.ownerId === user.id` grants `editor`. The unsigned office user matches a project they own (`ownerId` `"local"`).
3. Otherwise, if `user.email` matches a `projectAccess` row on `by_project_email`, the caller gets that row's role (`viewer` or `editor`). Emails are stored lowercase.
4. Otherwise, if `visibility` is `"public"`, the caller gets `viewer`. This includes the unsigned `local` user.
5. Otherwise throw `You do not have access to this project`.

`editor` satisfies a `viewer` check. `viewer` does not satisfy an `editor` check and throws `You do not have access to this project`. A public project does not grant `editor`. An invite is checked before public, so an invited editor on a public project stays an editor.

Actions cannot read the database. `sessions.exec`, `sessions.readFile`, `sessions.writeFile`, `sessions.deleteFile`, and `sessions.startPreview` call the internal query `access.requireRole`, which runs the same `requireAccess` rules with the caller's auth.

`projects.create` does not call `requireAccess`. The project does not exist yet. The caller becomes `ownerId`, visibility stays `private`, and an owner `members` row is inserted (with email when the token has one).

## Who can call what

| Function | Minimum role |
| --- | --- |
| `projects.list` | Returns only projects the caller can view: owner, invited email, or `public`. Same decision order as above. Does not throw for hidden projects. |
| `projects.get` | `viewer` |
| `projects.lineage` | `viewer`. Nodes are projects the caller can view. An edge is included only when both the parent and the child are visible. |
| `projects.buildOn` | `editor` on the parent. The new project is owned by the caller and stays `private`. |
| `sessions.start`, `sessions.resume`, `sessions.stop`, `sessions.heartbeat`, `sessions.get`, `sessions.readFile` | `viewer` |
| `sessions.exec`, `sessions.writeFile`, `sessions.deleteFile`, `sessions.startPreview` | `editor` |
| `leases.acquire`, `leases.release` | `editor` |
| `handoffs.create` | `editor` on the session's project |
| `handoffs.latest` | `viewer` on the session's project |
| `events.byProject` | `viewer` |
| `events.recent` | Any local or signed-in caller. The result is filtered to projects they can view, up to 50, newest first. Hidden projects are omitted rather than throwing. |
| `contributions.propose`, `contributions.setStatus` | `editor` on the contribution's target project |

`sessions.get` still omits `envUrl`. `sessions.writeFile` and `sessions.deleteFile` still record `internal.fileChanges.record`.

## Sharing

`convex/sharing.ts` public functions. Args are exact.

| Function | Who | Args | Returns |
| --- | --- | --- | --- |
| `sharing.get` | `viewer` | `{ slug: string }` | Looks up `projects.by_share_slug`. Throws `Project not found` when the slug is missing, and `You do not have access to this project` when the caller cannot view. Returns `{ projectId, name, visibility, shareSlug, role, previewUrl, previewStatus, snapshotUrl }`. `previewUrl` and `previewStatus` come from the newest session (latest `_creationTime`). `snapshotUrl` is `ctx.storage.getUrl(project.lastSnapshot)`. Does not return `envUrl`. |
| `sharing.setVisibility` | owner only | `{ projectId, visibility: "private" \| "public" }` | `projectId`. Owner means `ownerId === user.id`, which includes the local owner of a local project. `"link"` is rejected by the validator. |
| `sharing.invite` | owner only | `{ projectId, email, role: "viewer" \| "editor" }` | Access row id. Email is trimmed and lowercased. Upserts the `projectAccess` row for that project and email. `invitedBy` is the caller id. |
| `sharing.remove` | owner only | `{ projectId, email }` | `{ ok: true }`. Deletes that access row. Email is matched lowercased. Throws `Invite not found` when there is no row. |
| `sharing.list` | owner only | `{ projectId }` | That project's `projectAccess` rows. |

A non-owner, including an invited editor, gets `Only the project owner can do this`.

## Shared sessions and presence

Sessions are shared. `beginSession` (`sessions.start` and `sessions.resume`) returns an existing session for the project when any session has status `ready`, and touches `lastActiveAt`, even when `project.sandboxId` is not set yet. The resume rate limit (4 per project per minute) and the sandbox resume path still apply only when a new session is provisioned.

`sessions.start`, `sessions.resume`, and `sessions.heartbeat` upsert one `presence` row per `(projectId, userId)` and set `sessionId`, `agent`, and `lastSeenAt`. `sessions.stop` deletes that caller's presence row for the project.

The sandbox pauses only when everyone has left or gone idle. `sessions.stop` still schedules `internal.sessions.pauseSandbox` when no presence row for the project is newer than 5 minutes (including when the caller was the last one). If another participant's `lastSeenAt` is within 5 minutes, stop leaves the ready session running. `stopIdle` pauses a `ready` session only when `lastActiveAt` is older than 5 minutes and every presence row for that project is also older than 5 minutes, or there are no presence rows. A fresh participant keeps the session up. Pausing still pauses the sandbox. It does not destroy it.
