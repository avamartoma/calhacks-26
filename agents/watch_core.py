"""What the watcher agent notices: transitions between two office snapshots, kept free of uAgents for testing."""
from __future__ import annotations

import json
import time
from typing import Callable, Iterable, Iterator

from office_core import _clip, _tasks, same_path

REPEAT_WINDOW = 60


def parse_sse(lines: Iterable[bytes | str]) -> Iterator[dict]:
    """Yield each JSON `data:` event from a server-sent event stream, joining multi-line data."""
    data: list[str] = []
    for raw in lines:
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
        line = line.rstrip("\r\n")
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
        elif not line and data:
            try:
                yield json.loads("\n".join(data))
            except ValueError:
                pass
            data = []


def project_rooms(state: dict, project: str) -> dict[str, dict]:
    return {r["id"]: r for r in state.get("rooms", []) if not r.get("demo") and not r.get("archived") and same_path(r["path"], project)}


def changes(before: dict | None, after: dict, project: str, verify: Callable[[str, str], str] | None = None) -> list[str]:
    """Plain-language lines for what changed in this project's offices. The first snapshot is a baseline."""
    if before is None:
        return []
    old_rooms, new_rooms = project_rooms(before, project), project_rooms(after, project)
    many = len(new_rooms) > 1
    lines: list[str] = []
    for room_id, room in new_rooms.items():
        prefix = f"{room['name']}: " if many else ""
        old = old_rooms.get(room_id)
        if old is None:
            lines.append(f"{prefix}New office opened for this project.")
            continue
        if room.get("paused") != old.get("paused"):
            lines.append(f"{prefix}Office {'paused' if room.get('paused') else 'resumed'}.")
        if room.get("goal") and room.get("goal") != old.get("goal"):
            lines.append(f"{prefix}New mission: {_clip(room['goal'], 140)}")
        previous = {t["id"]: t for t in old.get("workItems", [])}
        for task in _tasks(room):
            was = previous.get(task["id"])
            status, title = task["status"], _clip(task["title"], 100)
            if was is None or was["status"] == status:
                continue
            if status == "blocked":
                lines.append(f"{prefix}Blocked: {title}" + (f" ({_clip(task['blocker'], 140)})" if task.get("blocker") else ""))
            elif status == "review":
                lines.append(f"{prefix}Ready for review: {title}")
            elif status == "done":
                lines.append(f"{prefix}Done: {title}" + (f" ({verify(room_id, task['id'])})" if verify else ""))
            elif was["status"] == "blocked":
                lines.append(f"{prefix}Unblocked: {title}")
        old_approvals = {a.get("id") for a in before.get("approvals", []) if a.get("roomId") == room_id}
        for approval in after.get("approvals", []):
            if approval.get("roomId") == room_id and approval.get("id") not in old_approvals:
                lines.append(f"{prefix}Approval needed in the office app: {_clip(approval.get('command') or approval.get('method') or 'request', 140)}")
    return lines


class Repeats:
    """Drops a line already sent within the last minute, so a task flapping between states doesn't spam."""

    def __init__(self, clock: Callable[[], float] = time.time, window: float = REPEAT_WINDOW):
        self.clock, self.window, self.sent = clock, window, {}

    def fresh(self, lines: list[str]) -> list[str]:
        now = self.clock()
        self.sent = {line: t for line, t in self.sent.items() if now - t < self.window}
        out = []
        for line in lines:
            if line not in self.sent:
                self.sent[line] = now
                out.append(line)
        return out
