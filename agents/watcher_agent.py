"""Iteration1 watcher agent: follows the local office's live state and tells the other agents what changed.

    python agents/watcher_agent.py        (or agents/run_all.py to start every agent)

It notices tasks that block, become ready for review or finish (and whether they were verified), new
approval requests, new missions and pauses. The office agent forwards them to its paired owners in
ASI:One, the reviewer reviews work that reaches review, and the planner mirrors progress onto Jira.

Environment (all optional): ITERATION1_URL, ITERATION1_PROJECT, OFFICE_WATCHER_PORT (default 8003).
"""
from __future__ import annotations

import asyncio
import os
import queue
import sys
import threading
import time
from pathlib import Path

import uagents.asgi
from uagents import Agent, Context

sys.path.insert(0, str(Path(__file__).parent))
from office_core import OfficeClient, OfficeError  # noqa: E402
from office_link import HEARTBEAT_SECONDS, OfficeLink  # noqa: E402
from siblings import LocalFirst, OfficeAlert, OfficeEvent, address, ensure_seed, port  # noqa: E402
from watch_core import Change, Repeats, events, parse_sse  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BATCH_SECONDS = 3.0

uagents.asgi.HOST = "127.0.0.1"
sys.stdout.reconfigure(errors="backslashreplace")


def say(line: str) -> None:
    print(f"[iteration1-watcher] {line}", flush=True)


project = os.environ.get("ITERATION1_PROJECT", str(ROOT))
client = OfficeClient(os.environ.get("ITERATION1_URL", "http://127.0.0.1:4314"), project)

agent = Agent(
    name="iteration1-watcher",
    seed=ensure_seed("watcher"),
    port=port("watcher"),
    resolve=LocalFirst(),
    # Listed on Agentverse through its own mailbox, like the office agent. It takes no commands, so the
    # mailbox only makes it visible; alerts go straight to the sibling agents on this computer.
    mailbox=os.environ.get("OFFICE_AGENT_MAILBOX") != "0",
    publish_agent_details=True,
    report_events=False,
    readme_path=str(Path(__file__).parent / "WATCHER.md"),
    description="Watches a local Iteration1 office of coding agents and tells its office agent when tasks block, finish or need approval.",
)
found: "queue.Queue[Change]" = queue.Queue()
watching = {"live": False}
link = OfficeLink(client, "watcher", agent.address, lambda: {"watching": watching["live"]}, say)


def verdict(room_id: str, task_id: str) -> tuple[bool | None, str]:
    try:
        v = client.run_doc(room_id, task_id).get("verification", {})
    except OfficeError:
        return None, "verification unknown"
    if v.get("verified"):
        return True, "verified"
    gaps = v.get("gaps", [])
    return False, f"not verified: {len(gaps)} gap(s)" if gaps else "not verified"


def follow() -> None:
    """Read the office stream forever, reconnecting with backoff. Compares against the last state seen,
    so transitions that happen while the office is restarting are still reported once it is back."""
    last, delay, down = None, 2.0, False
    while True:
        try:
            with client.stream() as res:
                say("Watching the office.")
                watching["live"] = True
                if down:
                    found.put(Change("The office is back online.", "online", ""))
                down, delay = False, 2.0
                for state in parse_sse(res):
                    for change in events(last, state, project, verdict):
                        found.put(change)
                    last = state
        except (OfficeError, OSError) as e:
            watching["live"] = False
            if not down:
                say(f"Office stream lost ({e}). Retrying with backoff.")
                if last is not None:
                    found.put(Change("Lost contact with the office. I'll tell you when it's back.", "offline", ""))
            down = True
        time.sleep(delay)
        delay = min(delay * 2, 30.0)


repeats = Repeats()


@agent.on_event("startup")
async def start(ctx: Context):
    say(f"Watcher address: {agent.address}")
    threading.Thread(target=follow, daemon=True).start()


@agent.on_interval(period=HEARTBEAT_SECONDS)
async def check_in(ctx: Context):
    await asyncio.to_thread(link.beat)


@agent.on_interval(period=BATCH_SECONDS)
async def flush(ctx: Context):
    batch: list[Change] = []
    while not found.empty():
        batch.append(found.get_nowait())
    fresh = set(repeats.fresh([c.line for c in batch]))
    kept: list[Change] = []
    for change in batch:
        if change.line in fresh:
            fresh.discard(change.line)  # keep the first of identical changes in this batch
            kept.append(change)
    batch = kept[:20]
    if not batch:
        return
    alert = OfficeAlert(lines=[c.line for c in batch], events=[OfficeEvent(kind=c.kind, room_id=c.room_id, task_id=c.task_id, title=c.title, detail=c.detail, verified=c.verified) for c in batch])
    targets = {name: address(name) for name in ("office", "reviewer", "planner")}
    say(f"Sending {len(batch)} alert(s) to {', '.join(n for n, a in targets.items() if a)}: {alert.lines}")
    for target in targets.values():
        if target:
            await ctx.send(target, alert)
    for change in batch:
        await asyncio.to_thread(link.report, change.kind, change.line, change.room_id, change.task_id)


if __name__ == "__main__":
    agent.run()
