"""Set up Jira and the ASI:One model key for the planner and reviewer. Run it on the office computer:

    python agents/configure.py

Secrets are typed without echo and saved only in .office/ (git-ignored, readable only by you).
Create a Jira API token at https://id.atlassian.com/manage-profile/security/api-tokens and an ASI:One
API key at https://asi1.ai (developer settings). Press Enter to keep a value that is already saved.
"""
from __future__ import annotations

import getpass
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from jira_cloud import CONFIG as JIRA_CONFIG, Jira, JiraError, jira_site  # noqa: E402
from llm import KEY_FILE, ask_json  # noqa: E402


def load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}


def save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    temp.chmod(0o600)
    temp.replace(path)


def ask(label: str, current: str = "", secret: bool = False) -> str:
    shown = "(saved)" if secret and current else current
    prompt = f"{label}{f' [{shown}]' if shown else ''}: "
    value = (getpass.getpass(prompt) if secret else input(prompt)).strip()
    return value or current


def main() -> None:
    print(__doc__)
    jira = load(JIRA_CONFIG)
    if ask("Set up Jira now? (y/n)", "y").lower().startswith("y"):
        while True:
            jira["site"] = ask("Jira site, e.g. https://your-team.atlassian.net", jira.get("site", ""))
            jira["email"] = ask("Atlassian account email", jira.get("email", ""))
            jira["token"] = ask("Jira API token", jira.get("token", ""), secret=True)
            jira["project"] = ask("Jira project key, e.g. ONB", jira.get("project", "")).upper()
            try:
                jira["site"] = jira_site(jira["site"])
                print("Checking Jira…", Jira(jira["site"], jira["email"], jira["token"], jira["project"]).check())
                save(JIRA_CONFIG, jira)
                print(f"Saved to {JIRA_CONFIG}")
                break
            except JiraError as e:
                print(f"That didn't work: {e}")
                if not ask("Try again? (y/n)", "y").lower().startswith("y"):
                    break

    model = load(KEY_FILE)
    if ask("Set up the ASI:One model key now? (y/n)", "y").lower().startswith("y"):
        model["key"] = ask("ASI:One API key", model.get("key", ""), secret=True)
        reply = ask_json("You are a connectivity check.", 'Return {"ok": true}.', key=model["key"])
        if isinstance(reply, dict) and reply.get("ok"):
            save(KEY_FILE, model)
            print(f"The key works. Saved to {KEY_FILE}")
        else:
            print("ASI:One didn't accept that key (or is unreachable); nothing was saved.")
    print("Done. Restart the agents (agents/run_all.py) to use the new settings.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")
