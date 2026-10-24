"""Iteration1 office agent for ASI:One. Runs on your computer and reaches Agentverse through its mailbox.

    python agents/office_agent.py

Environment (all optional):
    ITERATION1_URL      local office origin, default http://127.0.0.1:4314
    ITERATION1_PROJECT  project folder the office belongs to, default the repo root
    OFFICE_AGENT_PORT   local port for the agent, default 8001
    OFFICE_AGENT_SEED   fixes the agent address; otherwise one is generated and kept in .office/
"""
from __future__ import annotations

import asyncio
import json
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
from alerts import OFFICE_CONFIG, OfficeAlert, alert_protocol, watcher_address  # noqa: E402
from office_core import HELP, Gate, OfficeAgent, OfficeClient  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG = OFFICE_CONFIG

# Windows consoles may not encode every character ASI:One sends; never let logging crash a handler.
sys.stdout.reconfigure(errors="backslashreplace")

# Mailbox mode needs no inbound connections, so keep the agent's own server off the local network.
uagents.asgi.HOST = "127.0.0.1"


def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}


def save_config(config: dict) -> None:
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    temp = CONFIG.with_suffix(".tmp")
    temp.write_text(json.dumps(config, indent=2), encoding="utf-8")
    os.chmod(temp, 0o600)
    os.replace(temp, CONFIG)


config = load_config()
if not config.get("seed"):
    config["seed"] = secrets.token_urlsafe(32)
    save_config(config)


def say(line: str) -> None:
    print(f"[iteration1-office] {line}", flush=True)


def save_owners(owners: set[str]) -> None:
    config["owners"] = sorted(owners)
    save_config(config)


office = OfficeAgent(
    office=OfficeClient(os.environ.get("ITERATION1_URL", "http://127.0.0.1:4314"), os.environ.get("ITERATION1_PROJECT", str(ROOT))),
    gate=Gate(owners=set(config.get("owners", [])), save=save_owners, log=say),
)

agent = Agent(
    name="iteration1-office",
    seed=os.environ.get("OFFICE_AGENT_SEED") or config["seed"],
    port=int(os.environ.get("OFFICE_AGENT_PORT", "8001")),
    mailbox=os.environ.get("OFFICE_AGENT_MAILBOX") != "0",
    publish_agent_details=True,
    report_events=False,  # optional Agentverse telemetry; it needs an API key and logs 401s without one
    readme_path=str(Path(__file__).parent / "AGENT.md"),
    description="Check on, and hand missions to, an Iteration1 office of coding agents running on its owner's computer.",
)
chat = Protocol(spec=chat_protocol_spec)
alerts = alert_protocol()


def reply(text: str) -> ChatMessage:
    return ChatMessage(content=[TextContent(text=text)], msg_id=uuid4(), timestamp=datetime.now(timezone.utc))


@agent.on_event("startup")
async def announce(ctx: Context):
    say("=" * 64)
    say(f"Agent address: {agent.address}")
    say(f"Paired owners: {len(office.gate.owners)}")
    say(f"PAIRING CODE: {office.gate.code}   (new on every restart, single use)")
    say(f"Send it from ASI:One, for example: pair {office.gate.code}")
    say("=" * 64)


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
    await ctx.send(sender, reply(answer))


@alerts.on_message(OfficeAlert)
async def on_alert(ctx: Context, sender: str, msg: OfficeAlert):
    # Alerts are accepted only from this computer's own watcher agent.
    if sender != watcher_address():
        say(f"Ignored alert from unknown sender {sender}")
        return
    lines = [line[:300] for line in msg.lines[:20]]
    office.remember(lines)
    say(f"Alert from watcher -> {len(office.gate.owners)} owner(s): {lines}")
    for owner in sorted(office.gate.owners):
        await ctx.send(owner, reply("Office update:\n" + "\n".join(f"- {line}" for line in lines)))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


agent.include(chat, publish_manifest=True)
agent.include(alerts)

if __name__ == "__main__":
    agent.run()
