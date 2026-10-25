"""Iteration1 office agent for ASI:One. Runs on your computer and reaches Agentverse through its mailbox.

    python agents/office_agent.py        (or agents/run_all.py to start every agent)

It answers its paired owners in ASI:One and coordinates the local sibling agents: it forwards the
watcher's alerts and the reviewer's verdicts to owners, asks the reviewer for reviews, and starts
missions the planner hands it for an owner.

Environment (all optional):
    ITERATION1_URL      local office origin, default http://127.0.0.1:4314
    ITERATION1_PROJECT  project folder the office belongs to, default the repo root
    OFFICE_AGENT_PORT   local port for the agent, default 8001
    OFFICE_AGENT_SEED   fixes the agent address; otherwise one is generated and kept in .office/
"""
from __future__ import annotations

import asyncio
import os
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import uagents.asgi
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement, ChatMessage, StartSessionContent, TextContent, chat_protocol_spec,
)

sys.path.insert(0, str(Path(__file__).parent))
from office_core import HELP, Gate, OfficeAgent, OfficeClient, OfficeError  # noqa: E402
from office_link import HEARTBEAT_SECONDS, OfficeLink  # noqa: E402
from siblings import (  # noqa: E402
    OFFICE_CONFIG, DispatchRequest, DispatchResult, LocalFirst, OfficeAlert, ReviewRequest, ReviewResult,
    address, port, read_json, write_private,
)

ROOT = Path(__file__).resolve().parent.parent

# Windows consoles may not encode every character ASI:One sends; never let logging crash a handler.
sys.stdout.reconfigure(errors="backslashreplace")

# Mailbox mode needs no inbound connections, so keep the agent's own server off the local network.
uagents.asgi.HOST = "127.0.0.1"

config = read_json(OFFICE_CONFIG)
if not config.get("seed"):
    config["seed"] = secrets.token_urlsafe(32)
    write_private(OFFICE_CONFIG, config)


def say(line: str) -> None:
    print(f"[iteration1-office] {line}", flush=True)


def save_owners(owners: set[str]) -> None:
    config["owners"] = sorted(owners)
    write_private(OFFICE_CONFIG, config)


office = OfficeAgent(
    office=OfficeClient(os.environ.get("ITERATION1_URL", "http://127.0.0.1:4314"), os.environ.get("ITERATION1_PROJECT", str(ROOT))),
    gate=Gate(owners=set(config.get("owners", [])), save=save_owners, log=say),
)

agent = Agent(
    name="iteration1-office",
    seed=os.environ.get("OFFICE_AGENT_SEED") or config["seed"],
    port=port("office"),
    mailbox=os.environ.get("OFFICE_AGENT_MAILBOX") != "0",
    resolve=LocalFirst(),
    publish_agent_details=True,
    report_events=False,  # optional Agentverse telemetry; it needs an API key and logs 401s without one
    readme_path=str(Path(__file__).parent / "AGENT.md"),
    description="Check on, and hand missions to, an Iteration1 office of coding agents running on its owner's computer.",
)
chat = Protocol(spec=chat_protocol_spec)
team = Protocol(name="iteration1-office-team", version="0.2.0")
link = OfficeLink(office.office, "office", agent.address, lambda: {"owners": len(office.gate.owners), "pairingLocked": office.gate.locked}, say)


def reply(text: str) -> ChatMessage:
    return ChatMessage(content=[TextContent(text=text)], msg_id=uuid4(), timestamp=datetime.now(timezone.utc))


async def tell_owners(ctx: Context, text: str, only: str = "") -> None:
    for owner in [only] if only in office.gate.owners else sorted(office.gate.owners):
        await ctx.send(owner, reply(text))


@agent.on_event("startup")
async def announce(ctx: Context):
    say("=" * 64)
    say(f"Agent address: {agent.address}")
    say(f"Paired owners: {len(office.gate.owners)}")
    say(f"PAIRING CODE: {office.gate.code}   (new on every restart, single use)")
    say(f"Send it from ASI:One, for example: pair {office.gate.code}")
    say("=" * 64)


def queue_review(room_id: str, task_id: str) -> str:
    """A review asked for in the office app goes to the reviewer as a job; its verdict lands on the ticket."""
    try:
        office.office.request("/fetch/jobs", {"agent": "reviewer", "kind": "review", "roomId": room_id, "taskId": task_id})
        return ""
    except OfficeError as e:
        return f"\n\nThe reviewer couldn't take it: {e}"


async def send_outbox(ctx: Context) -> str:
    """Pass requests for sibling agents along. Returns a note to add to the reply when one couldn't be sent."""
    note = ""
    while office.outbox:
        kind, requester, room_id, task_id = office.outbox.pop(0)
        reviewer = address("reviewer")
        if kind == "review" and requester.startswith("local:"):
            note += await asyncio.to_thread(queue_review, room_id, task_id)
        elif kind == "review" and reviewer:
            await ctx.send(reviewer, ReviewRequest(room_id=room_id, task_id=task_id, requester=requester))
        elif kind == "review":
            note += "\n\nThe reviewer agent isn't set up. Start it with agents/run_all.py, then ask again."
    return note


@agent.on_interval(period=HEARTBEAT_SECONDS)
async def check_in(ctx: Context):
    # Messages typed to this agent in the office app arrive as chat jobs.
    for job in await asyncio.to_thread(link.beat):
        text = str((job.get("payload") or {}).get("text", "")).strip()
        if job["kind"] != "chat" or not text:
            await asyncio.to_thread(link.finish, job["id"], False, {"error": "Send me a message."})
            continue
        answer = await asyncio.to_thread(office.local, job["roomId"], text[:4000])
        answer += await send_outbox(ctx)
        await asyncio.to_thread(link.finish, job["id"], True, {"text": answer})


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    text = msg.text().strip()
    kinds = ",".join(getattr(c, "type", type(c).__name__) for c in msg.content)
    # Log what actually arrived, so a reworded or empty delivery from ASI:One is visible.
    say(f"From {sender} [{'owner' if office.gate.allowed(sender) else 'not paired'}] content={kinds} text={text[:200]!r}")
    if not text:
        if any(isinstance(c, StartSessionContent) for c in msg.content):
            await ctx.send(sender, reply(HELP))
        return
    # Office calls are blocking HTTP to localhost; keep them off the event loop.
    answer = await asyncio.to_thread(office.handle, sender, text[:12000])
    if office.gate.allowed(sender):
        await asyncio.to_thread(link.report, "chat", f"ASI:One: {text[:160]}")
    answer += await send_outbox(ctx)
    await ctx.send(sender, reply(answer))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


# Sibling agents on this computer. Each handler checks the sender is the sibling it expects.

@team.on_message(OfficeAlert)
async def on_alert(ctx: Context, sender: str, msg: OfficeAlert):
    if sender != address("watcher"):
        say(f"Ignored alert from unknown sender {sender}")
        return
    lines = [line[:300] for line in msg.lines[:20]]
    office.remember(lines)
    say(f"Alert from watcher -> {len(office.gate.owners)} owner(s): {lines}")
    await tell_owners(ctx, "Office update:\n" + "\n".join(f"- {line}" for line in lines))


@team.on_message(ReviewResult)
async def on_review(ctx: Context, sender: str, msg: ReviewResult):
    if sender != address("reviewer"):
        say(f"Ignored review from unknown sender {sender}")
        return
    office.remember([msg.text.splitlines()[0][:200] + " (say `alerts` for the list, or ask me to review it again)"])
    say(f"Review from reviewer for task {msg.task_id} -> {'requester' if msg.requester else 'all owners'}")
    await tell_owners(ctx, msg.text[:6000], only=msg.requester)


@team.on_message(DispatchRequest)
async def on_dispatch(ctx: Context, sender: str, msg: DispatchRequest):
    if sender != address("planner"):
        say(f"Ignored mission from unknown sender {sender}")
        return
    if msg.requester not in office.gate.owners:
        await ctx.send(sender, DispatchResult(ok=False, text="Only the office's paired owner can start missions.", requester=msg.requester))
        return
    try:
        text, ok = await asyncio.to_thread(office.dispatch, msg.prompt), True
    except OfficeError as e:
        text, ok = f"The office said: {e}", False
    say(f"Mission from planner for {msg.requester}: {'started' if ok else text}")
    await asyncio.to_thread(link.report, "mission", f"Planner started a mission from ASI:One: {msg.prompt.splitlines()[0][:160]}" if ok else text)
    await ctx.send(sender, DispatchResult(ok=ok, text=text, requester=msg.requester))


agent.include(chat, publish_manifest=True)
agent.include(team)

if __name__ == "__main__":
    agent.run()
