# ASI:One agents for the web office (Agentverse hosted)

The same four agents as `agents/` (office, watcher, reviewer, planner), rewritten to run on Agentverse and work with the web office through Convex instead of a local office. They check in every few seconds, take the jobs people queue in the web office, and answer in ASI:One.

- **Office** answers about the team's demo projects (`status`, `report`, `review`, `mission`) in ASI:One and in the web office's chat.
- **Reviewer** checks whether an agent run's output supports what was asked, when someone clicks **Ask the reviewer**.
- **Planner** drafts Jira stories from an idea, creates them, and starts one as a Claude agent run.
- **Watcher** notices when runs on demo projects start, finish or fail, and messages ASI:One users who said `watch`.

They only read and start work on **team demo projects**: projects whose owner ticked *Team demo project* under **ASI:One agents** in the web office. Runs they start use that owner's Claude connection.

## Files

- `opencloud.py`: everything the agents share. Standard library only and tested (`python3 -m unittest discover agents/hosted`).
- `chat.py`: ASI:One's chat protocol, and pairing with a team code.
- `office.py`, `reviewer.py`, `watcher.py`, `planner.py`: one agent each.
- `dist/`: each agent as one file with the shared code inlined, made by `python3 agents/hosted/bundle.py` and not committed.

## Setting them up

1. **Convex** (once, by someone with access to the deployment): set the agents' shared token.
   ```sh
   npx convex env set FETCH_AGENT_TOKEN "$(openssl rand -hex 32)" --deployment hidden-mink-963
   npx convex env list --deployment hidden-mink-963 --include-values | grep FETCH_AGENT_TOKEN   # copy it for step 3
   ```
2. **Agentverse**: at agentverse.ai → **Agents → Launch an agent → Blank agent**, create four hosted agents named `opencloud-office`, `opencloud-reviewer`, `opencloud-watcher` and `opencloud-planner`.
3. Run `python3 agents/hosted/bundle.py` (the bundles aren't committed), then in each agent replace the code with the matching file from `agents/hosted/dist/`, and add these under **Agent Secrets**:
   - `OPENCLOUD_URL`: `https://hidden-mink-963.convex.site`
   - `OPENCLOUD_AGENT_TOKEN`: the token from step 1
   - `ASI1_API_KEY`: optional, for written reviews and plans
   - Office and planner: `OPENCLOUD_PAIR_CODE`, a code you give the team, so only they can start work from ASI:One
   - Planner: `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_PROJECT`
4. Start each agent. Within a few seconds, its dot in the web office's **ASI:One agents** panel turns green.
5. In ASI:One, find the office agent by name and say `pair <code>`, then `status`.

Never commit the token, the Jira token or the pair code. They belong in Convex and Agentverse secrets only.
