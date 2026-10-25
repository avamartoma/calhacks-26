"""opencloud planner agent, hosted on Agentverse. Drafts Jira stories from an idea, creates them, and
starts a story as a Claude agent run on a team demo project. Works from the web office and from ASI:One."""
from __future__ import annotations

from uagents import Agent, Context

from chat import acknowledge, make_chat, paired, reply, try_pair
from opencloud import HEARTBEAT_SECONDS, Cloud, CloudError, Jira, ask_json, clean_plan, draft_plan, find_project, mission_from_issue
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage

HELP = """I'm the opencloud planner. I turn ideas into Jira stories and hand them to opencloud's agents.

- **plan: <idea>**: draft an epic and stories with acceptance criteria
- **create**: create the stories I just drafted in Jira (paired users)
- **start <KEY-12> on <project>**: start a Claude agent on that story (paired users)"""

agent = Agent()
cloud = Cloud("planner")
jira = Jira()
chat = make_chat()


def plan_lines(plan: dict) -> str:
    lines = [f"**Epic:** {plan['epic']['summary']}", ""]
    for i, story in enumerate(plan["stories"], 1):
        lines.append(f"{i}. **{story['summary']}**")
        lines += [f"   - {c}" for c in story["acceptance_criteria"]]
    return "\n".join(lines)


def run_job(job: dict) -> dict:
    kind, payload, project = job["kind"], job.get("payload") or {}, job.get("project") or {}
    if kind == "plan":
        plan, modeled = draft_plan(str(payload.get("idea", "")), ask_json)
        return {"plan": plan, "modeled": modeled}
    if not jira.configured:
        raise CloudError("Jira isn't set up in the planner's Agentverse secrets.")
    if kind == "create":
        plan = clean_plan(payload.get("plan"))
        if not plan:
            raise CloudError("That plan is missing its epic or stories.")
        return {"issues": jira.create_plan(plan)}
    if kind == "start":
        issue = jira.issue(str(payload.get("key", "")))
        return {"runId": cloud.dispatch(project["id"], mission_from_issue(issue)), "key": issue["key"]}
    raise CloudError(f"I don't take {kind} jobs.")


@agent.on_interval(period=HEARTBEAT_SECONDS)
async def check_in(ctx: Context):
    try:
        jobs = cloud.heartbeat(ctx.agent.address, {"jira": jira.project if jira.configured else "", "site": jira.site if jira.configured else ""})
    except CloudError as e:
        ctx.logger.warning(f"Can't check in with opencloud: {e}")
        return
    for job in jobs:
        try:
            cloud.finish(job["id"], True, run_job(job))
        except CloudError as e:
            try:
                cloud.finish(job["id"], False, {"error": str(e)})
            except CloudError:
                ctx.logger.warning(f"Couldn't report job {job['id']}: {e}")


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    text = await acknowledge(ctx, sender, msg)
    lower = text.lower()
    answer = try_pair(ctx, sender, text)
    try:
        if answer:
            pass
        elif lower.startswith("plan"):
            idea = text.split(":", 1)[1].strip() if ":" in text else text[4:].strip()
            if len(idea) < 6:
                answer = "Say `plan: <idea>`."
            else:
                plan, _ = draft_plan(idea, ask_json)
                ctx.storage.set(f"plan:{sender}", plan)
                answer = plan_lines(plan) + "\n\nSay `create` to make these in Jira."
        elif lower.startswith("create"):
            plan = ctx.storage.get(f"plan:{sender}")
            if not paired(ctx, sender):
                answer = "Pair first: send `pair <code>` with the code from the team."
            elif not plan:
                answer = "Draft a plan first with `plan: <idea>`."
            elif not jira.configured:
                answer = "Jira isn't set up in my Agentverse secrets."
            else:
                issues = jira.create_plan(plan)
                answer = "Created " + ", ".join(f"{i['key']} ({i['summary']})" for i in issues) + ". Say `start <KEY> on <project>` to hand one to an agent."
        elif lower.startswith("start"):
            words = text.split(None, 1)[1] if len(text.split(None, 1)) > 1 else ""
            key, _, where = words.partition(" on ")
            project = find_project(cloud.projects(), where)
            if not paired(ctx, sender):
                answer = "Pair first: send `pair <code>` with the code from the team."
            elif not project:
                answer = "Say `start <KEY-12> on <project>` with one of the team's demo projects."
            else:
                issue = jira.issue(key.strip().upper())
                cloud.dispatch(project["id"], mission_from_issue(issue))
                answer = f"Started a Claude agent on **{project['name']}** for {issue['key']}."
        else:
            answer = HELP
    except CloudError as e:
        answer = f"That didn't work: {e}"
    await ctx.send(sender, reply(answer))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


agent.include(chat, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
