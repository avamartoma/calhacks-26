"""opencloud office agent, hosted on Agentverse. Answers in ASI:One about the team's demo projects, starts
Claude agents on them for paired users, and answers messages sent from the web office."""
from __future__ import annotations

from uagents import Agent, Context

from chat import acknowledge, make_chat, paired, reply, try_pair
from opencloud import HEARTBEAT_SECONDS, OFFICE_HELP, Cloud, CloudError, office_answer
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage

agent = Agent()
cloud = Cloud("office")
chat = make_chat()


@agent.on_interval(period=HEARTBEAT_SECONDS)
async def check_in(ctx: Context):
    try:
        jobs = cloud.heartbeat(ctx.agent.address, {"paired": len(ctx.storage.get("owners") or [])})
    except CloudError as e:
        ctx.logger.warning(f"Can't check in with opencloud: {e}")
        return
    for job in jobs:
        # Messages from the web office come from a signed-in editor of that project, so they count as paired.
        text = office_answer(str(job.get("payload", {}).get("text", "")), cloud, project=job.get("project"), paired=True)
        try:
            cloud.finish(job["id"], True, {"text": text})
        except CloudError as e:
            ctx.logger.warning(f"Couldn't answer job {job['id']}: {e}")


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    text = await acknowledge(ctx, sender, msg)
    if not text:
        return await ctx.send(sender, reply(OFFICE_HELP))
    answer = try_pair(ctx, sender, text) or office_answer(text, cloud, paired=paired(ctx, sender))
    await ctx.send(sender, reply(answer))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


agent.include(chat, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
