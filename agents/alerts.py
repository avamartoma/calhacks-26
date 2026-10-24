"""The agent-to-agent message the watcher sends the office agent. Both sides must share this schema."""
import json
import os
from pathlib import Path

from uagents import Model, Protocol
from uagents.crypto import Identity

PROTOCOL = {"name": "iteration1-alerts", "version": "0.1.0"}
STATE = Path(__file__).resolve().parent.parent / ".office"
# Overridable so a local test can run a second office agent without touching the real pairing.
OFFICE_CONFIG = Path(os.environ.get("OFFICE_AGENT_CONFIG") or STATE / "fetch-agent.json")
WATCHER = Path(os.environ.get("OFFICE_WATCHER_CONFIG") or STATE / "fetch-watcher.json")


class OfficeAlert(Model):
    lines: list[str]


def alert_protocol() -> Protocol:
    return Protocol(**PROTOCOL)


def watcher_address() -> str | None:
    """The watcher's address, derived from the seed it keeps beside the office agent's. Read each time so either agent can start first."""
    try:
        return Identity.from_seed(json.loads(WATCHER.read_text(encoding="utf-8"))["seed"], 0).address
    except (OSError, ValueError, KeyError):
        return None
