"""Iteration1 reviewer agent: checks a task's evidence against its acceptance criteria.

    python agents/reviewer_agent.py        (or agents/run_all.py to start every agent)

It reviews every task the watcher reports as ready for review, and any task an owner asks the office
agent to review, then sends the verdict to the office agent for its owners. It only reads run docs: it
never approves, edits or marks work verified. With an ASI:One API key (agents/configure.py) it judges
each criterion against the receipts; without one it reports the office's own checks.

Environment (all optional): ITERATION1_URL, ITERATION1_PROJECT, OFFICE_REVIEWER_PORT (default 8004).
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import uagents.asgi
from uagents import Agent, Context, Protocol

sys.path.insert(0, str(Path(__file__).parent))
from llm import api_key, ask_json  # noqa: E402
from office_core import OfficeClient, OfficeError  # noqa: E402
from review_core import review  # noqa: E402
from siblings import LocalFirst, OfficeAlert, ReviewRequest, ReviewResult, address, ensure_seed, port  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

uagents.asgi.HOST = "127.0.0.1"
sys.stdout.reconfigure(errors="backslashreplace")


def say(line: str) -> None:
    print(f"[iteration1-reviewer] {line}", flush=True)


client = OfficeClient(os.environ.get("ITERATION1_URL", "http://127.0.0.1:4314"), os.environ.get("ITERATION1_PROJECT", str(ROOT)))

agent = Agent(
    name="iteration1-reviewer",
    seed=ensure_seed("reviewer"),
    port=port("reviewer"),
    resolve=LocalFirst(),
    mailbox=os.environ.get("OFFICE_AGENT_MAILBOX") != "0",
    publish_agent_details=True,
    report_events=False,
    readme_path=str(Path(__file__).parent / "REVIEWER.md"),
    description="Reviews work from an Iteration1 office of coding agents: which acceptance criteria the evidence actually supports.",
)
team = Protocol(name="iteration1-reviewer", version="0.2.0")


def judge(room_id: str, task_id: str) -> str:
    try:
        return review(client.run_doc(room_id, task_id), ask_json if api_key() else None)
    except OfficeError as e:
        return f"I couldn't review that task: {e}"


async def send_review(ctx: Context, room_id: str, task_id: str, requester: str = "") -> None:
    office = address("office")
    if not office:
        return
    say(f"Reviewing task {task_id}" + (" (model)" if api_key() else " (office checks only)"))
    text = await asyncio.to_thread(judge, room_id, task_id)
    await ctx.send(office, ReviewResult(task_id=task_id, text=text, requester=requester))


@agent.on_event("startup")
async def start(ctx: Context):
    say(f"Reviewer address: {agent.address}")
    say("Judging criteria with ASI:One's model." if api_key() else "No ASI:One API key: reporting the office's own checks. Run agents/configure.py to add one.")


@team.on_message(OfficeAlert)
async def on_alert(ctx: Context, sender: str, msg: OfficeAlert):
    if sender != address("watcher"):
        return
    for event in msg.events:
        if event.kind == "review" and event.task_id:
            await send_review(ctx, event.room_id, event.task_id)


@team.on_message(ReviewRequest)
async def on_request(ctx: Context, sender: str, msg: ReviewRequest):
    if sender != address("office"):
        say(f"Ignored review request from unknown sender {sender}")
        return
    await send_review(ctx, msg.room_id, msg.task_id, msg.requester)


agent.include(team)

if __name__ == "__main__":
    agent.run()
