"""Talk to the running office agent from a second uAgent on this computer, bypassing ASI:One and Agentverse.

    python agents/pair_test.py <code> ["more messages" ...]

Sends `pair <code>`, then each extra message (default: `status`), and prints every reply. Messages go
straight to the office agent's local server. The tester listens on 127.0.0.1:8002 and registers that
loopback endpoint on the Almanac so the office agent can reply; it is unreachable from anywhere else.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
from pathlib import Path

import uagents.asgi
from uagents import Agent, Context, Protocol
from uagents.crypto import Identity
from uagents.resolver import RulesBasedResolver
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, TextContent, chat_protocol_spec

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".office"
OFFICE_PORT = int(os.environ.get("OFFICE_AGENT_PORT", "8001"))
TESTER_PORT = int(os.environ.get("PAIR_TEST_PORT", "8002"))
REPLY_TIMEOUT = 20

uagents.asgi.HOST = "127.0.0.1"
sys.stdout.reconfigure(errors="backslashreplace")

if len(sys.argv) < 2:
    sys.exit(__doc__)
messages = [f"pair {sys.argv[1]}", *(sys.argv[2:] or ["status"])]

config = json.loads((STATE / "fetch-agent.json").read_text(encoding="utf-8"))
office_address = Identity.from_seed(os.environ.get("OFFICE_AGENT_SEED") or config["seed"], 0).address

# A stable tester seed, so repeated runs reuse one address instead of registering a new one each time.
tester_file = STATE / "pair-tester.json"
if not tester_file.exists():
    tester_file.write_text(json.dumps({"seed": secrets.token_urlsafe(32)}), encoding="utf-8")
tester = Agent(
    name="iteration1-pair-tester",
    seed=json.loads(tester_file.read_text(encoding="utf-8"))["seed"],
    port=TESTER_PORT,
    endpoint=[f"http://127.0.0.1:{TESTER_PORT}/submit"],
    resolve=RulesBasedResolver({office_address: f"http://127.0.0.1:{OFFICE_PORT}/submit"}),
    publish_agent_details=False,
    enable_agent_inspector=False,
)
chat = Protocol(spec=chat_protocol_spec)
replies: asyncio.Queue[str] = asyncio.Queue()


@chat.on_message(ChatMessage)
async def on_reply(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id, timestamp=msg.timestamp))
    if sender == office_address:
        await replies.put(msg.text())


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


tester.include(chat)


@tester.on_event("startup")
async def run(ctx: Context):
    print(f"Tester {tester.address} -> office agent {office_address} on 127.0.0.1:{OFFICE_PORT}", flush=True)
    await asyncio.sleep(3)  # let the tester's loopback endpoint reach the Almanac before the office agent replies
    failed = False
    for text in messages:
        print(f"\n>>> {text}", flush=True)
        await ctx.send(office_address, ChatMessage(content=[TextContent(text=text)]))
        try:
            print(await asyncio.wait_for(replies.get(), REPLY_TIMEOUT), flush=True)
        except asyncio.TimeoutError:
            failed = True
            print(f"(no reply within {REPLY_TIMEOUT}s: is office_agent.py running on port {OFFICE_PORT}?)", flush=True)
            break
    os._exit(1 if failed else 0)


if __name__ == "__main__":
    tester.run()
