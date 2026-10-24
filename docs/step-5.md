# Step 5 — Connect an agent

Personal tokens let Claude Code, Codex, and Cursor work in a project sandbox through a remote MCP server. The raw token is returned once by `agentTokens.issue` and is never stored. Convex stores only the SHA-256 hex digest in `tokens.hashedToken`, with `userId`, `projectId`, an optional `label`, `createdAt`, and `revokedAt`.

Unsigned office calls are the user `local`, which matches projects created by the office (`ownerId` `"local"`). The issuer must be the project owner or a `members` row with role `owner` or `editor`. `agentTokens.revoke` is limited to that same user. `agentTokens.list` returns `{ id, label, createdAt, revokedAt }` for that user and project, and never the hash or the raw token.

The share app exposes Streamable HTTP at `/api/mcp?projectId=<id>`. The host is the deployed share origin. Locally that origin is `http://127.0.0.1:4315` (`npm run dev` in `share/`). Set `VITE_SHARE_ORIGIN` when the office should show a different host. The gateway reads `NEXT_PUBLIC_CONVEX_URL`, then `CONVEX_URL`, then `http://127.0.0.1:3210`. Send `Authorization: Bearer <token>`. The route does not log that header.

Tools:

| Tool | Who | What |
| --- | --- | --- |
| `list_files` | viewer | `git ls-files -z --cached --others --exclude-standard`, or a `find` that skips `node_modules` and `.git` |
| `read_file` | viewer | sandbox file contents |
| `get_preview_url` | viewer | the ready session's `previewUrl` |
| `write_file` | editor | writes after a 5-minute lease; the same session renews, another live session gets `File is busy` |
| `delete_file` | editor | deletes after the same lease |
| `run_command` | editor | `sessionSandbox.exec` in the workspace |

Viewer means the token user is the owner, an owner/editor/viewer member, or the project visibility is `public`. Editor means the owner or an owner/editor member. If no session is `ready`, the gateway throws `Open the project so its sandbox is running`.

Mount the panel where the room preview is known. Do not paste a token into chat, and do not commit one in a repo file. Codex reads `ITERATION1_TOKEN` from `bearer_token_env_var`. Cursor's header should reference that env var.

```tsx
import { ConnectAgent } from "./ConnectAgent";

<ConnectAgent projectId={room.preview?.projectId} />
```
