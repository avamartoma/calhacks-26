"""Chat plumbing the hosted agents share: ASI:One's Agent Chat Protocol, and pairing with a team code
before anyone can start work or ask for reviews from ASI:One."""
from __future__ import annotations

import hmac
import os
from datetime import datetime, timezone
from uuid import uuid4

from uagents import Context, Protocol
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, TextContent, chat_protocol_spec

MAX_TRIES = 5


def make_chat() -> Protocol:
    return Protocol(spec=chat_protocol_spec)


def reply(text: str) -> ChatMessage:
    return ChatMessage(content=[TextContent(type="text", text=text)], msg_id=uuid4(), timestamp=datetime.now(timezone.utc))


async def acknowledge(ctx: Context, sender: str, msg: ChatMessage) -> str:
    """Acknowledges a message and returns its text."""
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    return " ".join(part.text for part in msg.content if isinstance(part, TextContent)).strip()


def paired(ctx: Context, sender: str) -> bool:
    return sender in (ctx.storage.get("owners") or [])


def try_pair(ctx: Context, sender: str, text: str) -> str | None:
    """Handles `pair <code>` (anywhere in the message, since ASI:One may reword it). None if it isn't a pairing message."""
    if "pair" not in text.lower():
        return None
    code = os.environ.get("OPENCLOUD_PAIR_CODE", "")
    if len(code) < 6:
        return "Pairing isn't set up: add OPENCLOUD_PAIR_CODE to this agent's secrets."
    tries = ctx.storage.get("pair_tries") or 0
    if tries >= MAX_TRIES:
        return "Pairing is locked after too many wrong codes. Change OPENCLOUD_PAIR_CODE to unlock it."
    if any(hmac.compare_digest(word.strip("`'\".,"), code) for word in text.split()):
        owners = set(ctx.storage.get("owners") or [])
        owners.add(sender)
        ctx.storage.set("owners", sorted(owners))
        return "Paired. You can start work and ask for reviews now."
    ctx.storage.set("pair_tries", tries + 1)
    return "That code didn't match."
