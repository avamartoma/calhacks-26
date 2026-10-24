# Step 6 — Cloud edits land in the local project

While the open project's cloud session is ready, the office polls `fileChanges.since` every 2 seconds. The first poll runs after an initial upload when this office is sending the folder up, so that upload stays the baseline. Another person's write is read with `sessions.readFile` and saved into the project folder. A delete removes the local file. Paths inside `node_modules` or `.git` are ignored.

Uploads this office just sent are not applied again. A change is an echo when its author is `local` and its `contentHash` matches the file this office wrote. That hash is FNV-1a 32-bit hex, a colon, and the content length. Deletes use the hash `delete`.

If the watcher still has a save queued for the path, or the local file is newer than the last successful upload, the local file stays. The cloud bytes are written beside it as `<file>.remote`, and `{ path, at }` is added to `room.preview.conflicts`. Entries leave that list once a later cloud change applies cleanly.

Import `ConflictNotice` from `./ConflictNotice` and mount it with the preview:

<ConflictNotice conflicts={room.preview?.conflicts} />
