# Team offices

Two people can connect their Fourteenth offices for a shared project. Each runs Fourteenth locally with their own project checkout and Codex account. No provider API key is required.

## Connect

1. Both people open a live project in Fourteenth.
2. The first person opens **Team**, enters their name, selects their private network address, and clicks **Create invitation**.
3. They privately share the invitation code, which expires after ten minutes.
4. The second person opens **Team → Join teammate**, enters their own name and pastes the code.

Use a trusted local network. The sharing listener uses HTTP on port `4414` by default (`PORT + 100`, or `OFFICE_TEAM_PORT`). Only this narrow pairing/status/handoff listener accepts network connections. The application and execution API remain bound to localhost. Windows Firewall may require allowing the sharing port on the private network; Fourteenth does not change firewall rules. For two instances on the same computer, choose the `127.0.0.1` sharing address.

Invitations are capabilities: keep them private. Names are chosen by participants, not verified account identities. This first version pairs one teammate per project. It does not provide Internet relaying or a hosted team account service.

## Working together

- The 3D view adds a neighboring office; click **your name + teammate name** to frame both offices. Click a teammate's desk to inspect their shared work. The compact map shows both offices as well.
- **Team** shows the other office's agent assignments, ticket states, declared file scopes and receipt counts. Matching file scopes are highlighted for coordination.
- Agents discover the paired office through `office_status`. Their turn instructions tell them to inspect teammate work and resolve relevant dependencies or overlapping scopes with `office_message`.
- **Send a handoff** lets a human send context through one of their local desks. The message is marked **sent by owner**, so it is not presented as an agent's own statement.
- Active recipients receive context through their current turn. Idle or paused recipients read it when their owner next starts them. Cross-office traffic never starts a recipient, approves a tool, changes permissions, or edits the teammate's tickets.
- Delivery, acknowledgment, and application of a finding are separate states. Applied findings need receipts in the recipient's local office; they never count as verified evidence in the sender's checkout.
- Disconnections retain queued messages. Reconnection retries delivery without duplicate inbox entries. Agent replacement preserves pending handoffs and reply continuity.

Each person still commits and merges code through Git. Pairing does not synchronize files, merge branches, or enforce file locks across checkouts. A teammate's reported completion is not local verification.

## Shared data and disconnecting

Shared: person and office names, agent names/models/roles/assignments/status, ticket titles/status/file scopes/blockers/receipt counts, and explicit cross-office handoffs and acknowledgments.

Not shared by the status protocol: account identity or credentials, local folder paths, raw activity logs, diffs, thread IDs, approval requests, or unrelated projects. Explicit messages contain whatever their sender writes.

Open **Team → Connection settings → Disconnect teammate** to revoke the connection. Previously received history remains inspectable. Restored/branched offices do not inherit transport credentials; pairing is stored separately by local room ID in the ignored `.office/team-links.json` file.

## Verification and local preview

`npm test` includes two isolated companion processes exercising real HTTP pairing and transport with the deterministic Codex test adapter: active delivery, acknowledgments, replies, queued delivery, replacement, restart, revocation, data minimization and local ownership. Additional service tests cover a lost pairing response and persistence before receipt confirmation.

For a reproducible UI fixture, run `npm run build`, then `node scripts/team-preview.mjs`. Open `http://127.0.0.1:4351` and `http://127.0.0.1:4352`, and pair Alex and Blair using the Team panel. These are explicitly named test offices with fixture agent output, not two authenticated human participants. Their data is isolated in `.office/team-preview`.

The small **+** button on the left of the office adds a local demo teammate. Each project supports a visual district of nine offices: the local office plus eight teammates. Every demo teammate has a manager and two workers. The district button frames all the buildings; selecting a building or a teammate opens that office's detailed floor. Other offices use shared lightweight building instances. Each tower extends to street level, replaces its procedural city block, and connects to the district's skybridges.

When a real teammate is paired, visual previews are suppressed and **+** is disabled so the paired office and its handoffs stay visible. Use an unpaired project to explore the visual district. The two-instance rehearsal displays **Test agents** in the header and recording view; transport is real, agent execution is simulated.

Only the local and selected teammate offices have detailed interiors. The map shows all offices in the current project and searches people, agent roles, assignments, and tickets. Project switching preserves each project's separate preview team during the current page session. **×** clears only the current project's previews and restores its paired office. These view-only previews reset on page reload, make no model calls, and do not alter real team connections or send messages.

The 3D offices, demo creation, switching, clearing, and compact map were visually checked on 25 September 2026 after restarting the embedded browser. Earlier GPU-process crashes had disabled WebGL. The app now offers Retry 3D, preserves map access after graphics failure, and pauses the rendering loop in hidden tabs.

Current limits: one real paired teammate per project, nine visual offices per district (tested using local previews), two detailed interiors at a time, and up to six visible workers plus a manager per detailed office. Shared snapshots contain at most 100 agents and 100 non-archived tickets. Live groups larger than two people still require a multi-peer transport implementation. The visual demo capacity does not change that backend limit.
