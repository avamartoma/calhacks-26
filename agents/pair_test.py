"""Talk to a running Iteration1 agent from a second uAgent on this computer, bypassing ASI:One and Agentverse.

    python agents/pair_test.py <code> ["more messages" ...]
    python agents/pair_test.py - "plan: ..."            (skip pairing, for example once already paired)

Sends `pair <code>`, then each extra message (default: `status`), prints every reply, and keeps
listening briefly for follow-ups such as a review that arrives later. Messages go straight to the
agent's local server. PAIR_TEST_TARGET picks the agent (office or planner; default office). The tester
listens on 127.0.0.1:8002 and registers that loopback endpoint on the Almanac so agents can reply; it is
unreachable from anywhere else. It stays paired until you remove its address from .office/fetch-agent.json.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys

import uagents.asgi
from uagents import Agent, Context, Protocol
from uagents.resolver import RulesBasedResolver
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, TextContent, chat_protocol_spec

from siblings import STATE, address, port

TARGET = os.environ.get("PAIR_TEST_TARGET", "office")
TESTER_PORT = int(os.environ.get("PAIR_TEST_PORT", "8002"))
REPLY_TIMEOUT = 20
LINGER = float(os.environ.get("PAIR_TEST_LINGER", "8"))

uagents.asgi.HOST = "127.0.0.1"
sys.stdout.reconfigure(errors="backslashreplace")

if len(sys.argv) < 2:
    sys.exit(__doc__)
messages = ([] if sys.argv[1] == "-" else [f"pair {sys.argv[1]}"]) + (sys.argv[2:] or ["status"])

target_address = address(TARGET)
if not target_address:
    sys.exit(f"No {TARGET} agent is set up in .office/ yet; start it first.")

# A stable tester seed, so repeated runs reuse one address instead of registering a new one each time.
tester_file = STATE / "pair-tester.json"
if not tester_file.exists():
    tester_file.write_text(json.dumps({"seed": secrets.token_urlsafe(32)}), encoding="utf-8")
tester = Agent(
    name="iteration1-pair-tester",
    seed=json.loads(tester_file.read_text(encoding="utf-8"))["seed"],
    port=TESTER_PORT,
    endpoint=[f"http://127.0.0.1:{TESTER_PORT}/submit"],
    resolve=RulesBasedResolver({target_address: f"http://127.0.0.1:{port(TARGET)}/submit"}),
    publish_agent_details=False,
    enable_agent_inspector=False,
)
chat = Protocol(spec=chat_protocol_spec)
replies: asyncio.Queue[str] = asyncio.Queue()


@chat.on_message(ChatMessage)
async def on_reply(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id, timestamp=msg.timestamp))
    if sender == target_address:
        await replies.put(msg.text())


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


tester.include(chat)


@tester.on_event("startup")
async def run(ctx: Context):
    print(f"Tester {tester.address} -> {TARGET} agent {target_address} on 127.0.0.1:{port(TARGET)}", flush=True)
    await asyncio.sleep(3)  # let the tester's loopback endpoint reach the Almanac before the agent replies
    failed = False
    for text in messages:
        print(f"\n>>> {text}", flush=True)
        await ctx.send(target_address, ChatMessage(content=[TextContent(text=text)]))
        try:
            print(await asyncio.wait_for(replies.get(), REPLY_TIMEOUT), flush=True)
        except asyncio.TimeoutError:
            failed = True
            print(f"(no reply within {REPLY_TIMEOUT}s: is the {TARGET} agent running on port {port(TARGET)}?)", flush=True)
            break
    try:
        while True:
            print("\n<<< follow-up\n" + await asyncio.wait_for(replies.get(), LINGER), flush=True)
    except asyncio.TimeoutError:
        pass
    os._exit(1 if failed else 0)


if __name__ == "__main__":
    tester.run()
