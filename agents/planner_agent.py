"""Iteration1 planner agent for ASI:One: turns ideas into Jira stories and hands stories to the office.

    python agents/planner_agent.py        (or agents/run_all.py to start every agent)

Chat with it in ASI:One from the account paired with iteration1-office. `plan: <idea>` drafts an epic
and stories (with ASI:One's model if a key is set), `confirm` creates them in Jira, and `start KEY-12`
asks the office agent to run that story as a mission. As the watcher reports progress on a story the
planner started, it comments on the Jira issue and moves it to Done once the office has verified it.
Set up Jira and the model key with agents/configure.py.

Environment (all optional): OFFICE_PLANNER_PORT (default 8005).
"""
from __future__ import annotations

import asyncio
import os
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
from jira_cloud import Jira, JiraError, load_config  # noqa: E402
from llm import api_key, ask_json  # noqa: E402
from office_core import OfficeClient  # noqa: E402
from office_link import HEARTBEAT_SECONDS, OfficeLink  # noqa: E402
from planner_core import HELP, PlannerAgent  # noqa: E402
from siblings import DispatchRequest, DispatchResult, LocalFirst, OfficeAlert, address, ensure_seed, owners, port  # noqa: E402

uagents.asgi.HOST = "127.0.0.1"
sys.stdout.reconfigure(errors="backslashreplace")


def say(line: str) -> None:
    print(f"[iteration1-planner] {line}", flush=True)


def connect_jira() -> Jira | None:
    settings = load_config()
    if not settings:
        return None
    try:
        return Jira(settings["site"], settings["email"], settings["token"], settings["project"])
    except JiraError as e:
        say(f"Jira settings are invalid: {e}")
        return None


planner = PlannerAgent(jira=connect_jira(), owners=owners, ask=ask_json if api_key() else None)

agent = Agent(
    name="iteration1-planner",
    seed=ensure_seed("planner"),
    port=port("planner"),
    resolve=LocalFirst(),
    mailbox=os.environ.get("OFFICE_AGENT_MAILBOX") != "0",
    publish_agent_details=True,
    report_events=False,
    readme_path=str(Path(__file__).parent / "PLANNER.md"),
    description="Turns product ideas into Jira stories with acceptance criteria and hands them to an Iteration1 office of coding agents.",
)
chat = Protocol(spec=chat_protocol_spec)
team = Protocol(name="iteration1-planner", version="0.2.0")
ROOT = Path(__file__).resolve().parent.parent
client = OfficeClient(os.environ.get("ITERATION1_URL", "http://127.0.0.1:4314"), os.environ.get("ITERATION1_PROJECT", str(ROOT)))
link = OfficeLink(client, "planner", agent.address, lambda: {"jira": planner.jira.project if planner.jira else "", "site": planner.jira.site if planner.jira else "", "model": bool(planner.ask)}, say)


def dispatch(room_id: str, prompt: str) -> None:
    client.request(f"/rooms/{room_id}/dispatch", {"prompt": prompt[:12000]})


@agent.on_interval(period=HEARTBEAT_SECONDS)
async def check_in(ctx: Context):
    for job in await asyncio.to_thread(link.beat):
        ok, result = await asyncio.to_thread(planner.run_job, job["kind"], job.get("payload") or {}, job["roomId"], dispatch)
        await asyncio.to_thread(link.finish, job["id"], ok, result)
        if ok and job["kind"] == "create":
            await asyncio.to_thread(link.report, "jira", f"Created {len(result['issues'])} {result['project']} stories" + (f" under {result['epic']}" if result.get("epic") else ""), job["roomId"])
        elif ok and job["kind"] == "start":
            await asyncio.to_thread(link.report, "mission", f"Started {result['key']}: {result['summary']}", job["roomId"])


def reply(text: str) -> ChatMessage:
    return ChatMessage(content=[TextContent(text=text)], msg_id=uuid4(), timestamp=datetime.now(timezone.utc))


@agent.on_event("startup")
async def start(ctx: Context):
    say(f"Planner address: {agent.address}")
    if planner.jira:
        try:
            say(f"Jira: {await asyncio.to_thread(planner.jira.check)}")
        except JiraError as e:
            say(f"Jira check failed: {e}")
    else:
        say("Jira isn't set up. Run agents/configure.py, then restart me.")
    say("Drafting with ASI:One's model." if planner.ask else "No ASI:One API key: drafts split your idea into stories without a model.")


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    text = msg.text().strip()
    say(f"From {sender} [{'owner' if sender in owners() else 'not paired'}] text={text[:200]!r}")
    if not text:
        if any(isinstance(c, StartSessionContent) for c in msg.content):
            await ctx.send(sender, reply(HELP))
        return
    answer = await asyncio.to_thread(planner.handle, sender, text[:8000])
    while planner.outbox:
        requester, prompt = planner.outbox.pop(0)
        office = address("office")
        if office:
            await ctx.send(office, DispatchRequest(prompt=prompt, requester=requester))
        else:
            answer = "The office agent isn't set up on this computer, so I can't start missions."
    await ctx.send(sender, reply(answer))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


@team.on_message(DispatchResult)
async def on_dispatched(ctx: Context, sender: str, msg: DispatchResult):
    if sender != address("office"):
        return
    say(f"Office {'started' if msg.ok else 'refused'} a mission for {msg.requester}")
    if msg.requester in owners():
        await ctx.send(msg.requester, reply(msg.text))


@team.on_message(OfficeAlert)
async def on_alert(ctx: Context, sender: str, msg: OfficeAlert):
    if sender != address("watcher"):
        return
    for event in msg.events:
        line = await asyncio.to_thread(planner.on_event, event.kind, event.title, event.detail, event.verified)
        if line:
            say(f"Jira {line}")
            await asyncio.to_thread(link.report, "jira", line, event.room_id, event.task_id)


agent.include(chat, publish_manifest=True)
agent.include(team)

if __name__ == "__main__":
    agent.run()
