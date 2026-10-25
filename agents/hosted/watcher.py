"""opencloud watcher agent, hosted on Agentverse. Notices when agents on the team's demo projects start,
finish or fail, shows it in the web office, and tells ASI:One users who said `watch`."""
from __future__ import annotations

from uagents import Agent, Context

from chat import acknowledge, make_chat, reply
from opencloud import Cloud, CloudError, run_changes, status_text
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage

HELP = """I'm the opencloud watcher. I tell you when agents on the team's demo projects start, finish or fail.

- **watch**: send me those updates
- **stop**: stop sending them
- **status**: what's happening now"""

agent = Agent()
cloud = Cloud("watcher")
chat = make_chat()


@agent.on_interval(period=10.0)
async def look(ctx: Context):
    subscribers = ctx.storage.get("subscribers") or []
    try:
        cloud.heartbeat(ctx.agent.address, {"watching": True, "subscribers": len(subscribers)})
        before = ctx.storage.get("runs")
        now, changes = run_changes(before, cloud.projects())
    except CloudError as e:
        ctx.logger.warning(f"Can't reach opencloud: {e}")
        return
    ctx.storage.set("runs", now)
    for project_id, text in changes:
        try:
            cloud.activity("noticed", text, project_id)
        except CloudError:
            pass
        for address in subscribers:
            await ctx.send(address, reply(text))


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    text = (await acknowledge(ctx, sender, msg)).lower()
    subscribers = set(ctx.storage.get("subscribers") or [])
    if text.startswith("watch"):
        subscribers.add(sender)
        ctx.storage.set("subscribers", sorted(subscribers))
        answer = "Watching. I'll message you when agents start, finish or fail."
    elif text.startswith("stop"):
        subscribers.discard(sender)
        ctx.storage.set("subscribers", sorted(subscribers))
        answer = "Stopped. Say `watch` to start again."
    elif text.startswith("status"):
        try:
            answer = status_text(cloud.projects())
        except CloudError as e:
            answer = f"I couldn't reach opencloud: {e}"
    else:
        answer = HELP
    await ctx.send(sender, reply(answer))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


agent.include(chat, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
