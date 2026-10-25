"""What the watcher agent notices: transitions between two office snapshots, kept free of uAgents for testing."""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
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


@dataclass
class Change:
    """One thing that happened, as a line for people and fields for the reviewer and planner."""
    line: str
    kind: str
    room_id: str
    task_id: str = ""
    title: str = ""
    detail: str = ""
    verified: bool | None = None


def changes(before: dict | None, after: dict, project: str, verify: Callable[[str, str], tuple[bool | None, str]] | None = None) -> list[str]:
    return [c.line for c in events(before, after, project, verify)]


def events(before: dict | None, after: dict, project: str, verify: Callable[[str, str], tuple[bool | None, str]] | None = None) -> list[Change]:
    """What changed in this project's offices. The first snapshot is a baseline, so it reports nothing."""
    if before is None:
        return []
    old_rooms, new_rooms = project_rooms(before, project), project_rooms(after, project)
    many = len(new_rooms) > 1
    lines: list[Change] = []
    for room_id, room in new_rooms.items():
        prefix = f"{room['name']}: " if many else ""
        old = old_rooms.get(room_id)
        if old is None:
            lines.append(Change(f"{prefix}New office opened for this project.", "opened", room_id))
            continue
        if room.get("paused") != old.get("paused"):
            lines.append(Change(f"{prefix}Office {'paused' if room.get('paused') else 'resumed'}.", "paused" if room.get("paused") else "resumed", room_id))
        if room.get("goal") and room.get("goal") != old.get("goal"):
            lines.append(Change(f"{prefix}New mission: {_clip(room['goal'], 140)}", "mission", room_id, detail=room["goal"][:2000]))
        previous = {t["id"]: t for t in old.get("workItems", [])}
        for task in _tasks(room):
            was = previous.get(task["id"])
            status, title = task["status"], _clip(task["title"], 100)
            if was is None or was["status"] == status:
                continue
            at = dict(room_id=room_id, task_id=task["id"], title=task["title"])
            if status == "blocked":
                blocker = task.get("blocker") or ""
                lines.append(Change(f"{prefix}Blocked: {title}" + (f" ({_clip(blocker, 140)})" if blocker else ""), "blocked", detail=blocker[:500], **at))
            elif status == "review":
                lines.append(Change(f"{prefix}Ready for review: {title}", "review", **at))
            elif status == "done":
                verified, label = verify(room_id, task["id"]) if verify else (None, "")
                lines.append(Change(f"{prefix}Done: {title}" + (f" ({label})" if label else ""), "done", detail=label, verified=verified, **at))
            elif was["status"] == "blocked":
                lines.append(Change(f"{prefix}Unblocked: {title}", "unblocked", **at))
        old_approvals = {a.get("id") for a in before.get("approvals", []) if a.get("roomId") == room_id}
        for approval in after.get("approvals", []):
            if approval.get("roomId") == room_id and approval.get("id") not in old_approvals:
                lines.append(Change(f"{prefix}Approval needed in the office app: {_clip(approval.get('command') or approval.get('method') or 'request', 140)}", "approval", room_id))
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
