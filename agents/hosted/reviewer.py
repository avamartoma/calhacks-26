"""opencloud reviewer agent, hosted on Agentverse. Takes review jobs from the web office (or the office
agent) and judges whether an agent run's output supports what was asked. Read-only."""
from __future__ import annotations

from uagents import Agent, Context

from opencloud import HEARTBEAT_SECONDS, Cloud, CloudError, ask_json, clip, review_text

agent = Agent()
cloud = Cloud("reviewer")


@agent.on_interval(period=HEARTBEAT_SECONDS)
async def check_in(ctx: Context):
    try:
        jobs = cloud.heartbeat(ctx.agent.address)
    except CloudError as e:
        ctx.logger.warning(f"Can't check in with opencloud: {e}")
        return
    for job in jobs:
        try:
            text = review_text(job, ask_json)
            cloud.finish(job["id"], True, {"text": text})
            project = job.get("project") or {}
            cloud.activity("review", f"Reviewed **{clip((job.get('run') or {}).get('prompt', ''), 100)}**\n" + text.split("**Verdict:**")[-1].split("\n")[0].strip(), project.get("id", ""))
        except CloudError as e:
            ctx.logger.warning(f"Review {job['id']} failed: {e}")
            try:
                cloud.finish(job["id"], False, {"error": str(e)})
            except CloudError:
                pass


if __name__ == "__main__":
    agent.run()
