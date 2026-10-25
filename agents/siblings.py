"""How the local Iteration1 agents find and trust each other, and the messages they exchange.

The office agent faces ASI:One; the watcher, reviewer and planner run beside it on the same computer.
Each keeps its seed in .office/, so any of them can derive the others' addresses and accept messages
only from them. Messages between them go straight to 127.0.0.1; anything else resolves as usual.
"""
from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

from uagents import Model
from uagents.crypto import Identity
from uagents.resolver import GlobalResolver, Resolver

STATE = Path(__file__).resolve().parent.parent / ".office"
# Overridable so a local test can run a second set of agents without touching the real pairing.
OFFICE_CONFIG = Path(os.environ.get("OFFICE_AGENT_CONFIG") or STATE / "fetch-agent.json")
PORTS = {"office": 8001, "watcher": 8003, "reviewer": 8004, "planner": 8005}
SIBLINGS = ("watcher", "reviewer", "planner")


def port(name: str) -> int:
    return int(os.environ.get(f"OFFICE_{name.upper()}_PORT" if name != "office" else "OFFICE_AGENT_PORT", PORTS[name]))


def seed_file(name: str) -> Path:
    return Path(os.environ.get(f"OFFICE_{name.upper()}_CONFIG") or STATE / f"fetch-{name}.json")


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}


def write_private(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def ensure_seed(name: str) -> str:
    data = read_json(seed_file(name))
    if not data.get("seed"):
        data["seed"] = secrets.token_urlsafe(32)
        write_private(seed_file(name), data)
    return data["seed"]


def address(name: str) -> str | None:
    """A sibling's address, read each time so the agents can start in any order."""
    if name == "office":
        seed = os.environ.get("OFFICE_AGENT_SEED") or read_json(OFFICE_CONFIG).get("seed")
    else:
        seed = read_json(seed_file(name)).get("seed")
    return Identity.from_seed(seed, 0).address if seed else None


def owners() -> set[str]:
    """ASI:One addresses paired with the office agent. The planner trusts the same people."""
    return set(read_json(OFFICE_CONFIG).get("owners", []))


class LocalFirst(Resolver):
    """Sends to sibling agents on 127.0.0.1 and resolves every other address through the Almanac."""

    def __init__(self):
        self._global = GlobalResolver()

    async def resolve(self, destination: str) -> tuple[str | None, list[str]]:
        for name in ("office", *SIBLINGS):
            if destination == address(name):
                return destination, [f"http://127.0.0.1:{port(name)}/submit"]
        return await self._global.resolve(destination)


class OfficeEvent(Model):
    kind: str
    room_id: str
    task_id: str = ""
    title: str = ""
    detail: str = ""
    verified: bool | None = None


class OfficeAlert(Model):
    lines: list[str]
    events: list[OfficeEvent] = []


class ReviewRequest(Model):
    room_id: str
    task_id: str
    requester: str = ""


class ReviewResult(Model):
    task_id: str
    text: str
    requester: str = ""


class DispatchRequest(Model):
    prompt: str
    requester: str


class DispatchResult(Model):
    ok: bool
    text: str
    requester: str
