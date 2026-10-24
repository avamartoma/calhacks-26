"""Iteration1 watcher agent: follows the local office's live state and tells the office agent what changed.

    python agents/watcher_agent.py

It notices tasks that block, become ready for review or finish (and whether they were verified), new
approval requests, new missions and pauses, then sends them to the office agent, which forwards them
to its paired owners in ASI:One. Both agents run on this computer; the watcher has no public endpoint.

Environment (all optional): ITERATION1_URL, ITERATION1_PROJECT, OFFICE_AGENT_PORT (default 8001),
WATCHER_PORT (default 8003).
"""
from __future__ import annotations

import json
import os
import queue
import secrets
import sys
import threading
import time
from pathlib import Path

import uagents.asgi
from uagents import Agent, Context
from uagents.crypto import Identity
from uagents.resolver import RulesBasedResolver

sys.path.insert(0, str(Path(__file__).parent))
from alerts import OFFICE_CONFIG, WATCHER, OfficeAlert  # noqa: E402
from office_core import OfficeClient, OfficeError  # noqa: E402
from watch_core import Repeats, changes, parse_sse  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OFFICE_PORT = int(os.environ.get("OFFICE_AGENT_PORT", "8001"))
BATCH_SECONDS = 3.0

uagents.asgi.HOST = "127.0.0.1"
sys.stdout.reconfigure(errors="backslashreplace")


def say(line: str) -> None:
    print(f"[iteration1-watcher] {line}", flush=True)


def seed() -> str:
    try:
        return json.loads(WATCHER.read_text(encoding="utf-8"))["seed"]
    except (OSError, ValueError, KeyError):
        value = secrets.token_urlsafe(32)
        WATCHER.parent.mkdir(parents=True, exist_ok=True)
        WATCHER.write_text(json.dumps({"seed": value}), encoding="utf-8")
        os.chmod(WATCHER, 0o600)
        return value


office_config = json.loads(OFFICE_CONFIG.read_text(encoding="utf-8-sig"))
office_address = Identity.from_seed(os.environ.get("OFFICE_AGENT_SEED") or office_config["seed"], 0).address
project = os.environ.get("ITERATION1_PROJECT", str(ROOT))
client = OfficeClient(os.environ.get("ITERATION1_URL", "http://127.0.0.1:4314"), project)

agent = Agent(
    name="iteration1-watcher",
    seed=seed(),
    port=int(os.environ.get("WATCHER_PORT", "8003")),
    resolve=RulesBasedResolver({office_address: f"http://127.0.0.1:{OFFICE_PORT}/submit"}),
    publish_agent_details=False,
    enable_agent_inspector=False,
    report_events=False,
)
found: "queue.Queue[str]" = queue.Queue()


def verdict(room_id: str, task_id: str) -> str:
    try:
        v = client.run_doc(room_id, task_id).get("verification", {})
    except OfficeError:
        return "verification unknown"
    if v.get("verified"):
        return "verified"
    gaps = v.get("gaps", [])
    return f"not verified: {len(gaps)} gap(s)" if gaps else "not verified"


def follow() -> None:
    """Read the office stream forever, reconnecting with backoff. Compares against the last state seen,
    so transitions that happen while the office is restarting are still reported once it is back."""
    last, delay, down = None, 2.0, False
    while True:
        try:
            with client.stream() as res:
                if down:
                    say("Office is back; watching again.")
                    found.put("The office is back online.")
                down, delay = False, 2.0
                for state in parse_sse(res):
                    for line in changes(last, state, project, verdict):
                        found.put(line)
                    last = state
        except (OfficeError, OSError) as e:
            if not down:
                say(f"Office stream lost ({e}). Retrying with backoff.")
                if last is not None:
                    found.put("Lost contact with the office. I'll tell you when it's back.")
            down = True
        time.sleep(delay)
        delay = min(delay * 2, 30.0)


repeats = Repeats()


@agent.on_event("startup")
async def start(ctx: Context):
    say(f"Watcher address: {agent.address}")
    say(f"Reporting to office agent {office_address} on 127.0.0.1:{OFFICE_PORT}")
    threading.Thread(target=follow, daemon=True).start()


@agent.on_interval(period=BATCH_SECONDS)
async def flush(ctx: Context):
    lines = []
    while not found.empty():
        lines.append(found.get_nowait())
    lines = repeats.fresh(lines)
    if lines:
        say(f"Sending {len(lines)} alert(s): {lines}")
        await ctx.send(office_address, OfficeAlert(lines=lines[:20]))


if __name__ == "__main__":
    agent.run()
