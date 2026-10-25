"""Writes one self-contained file per hosted agent to agents/hosted/dist/, with opencloud.py and chat.py
inlined, for pasting into Agentverse's editor when an agent can only have one file.

    python agents/hosted/bundle.py
"""
from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
AGENTS = ["office", "reviewer", "watcher", "planner"]
LOCAL = re.compile(r"^from (opencloud|chat) import .*$", re.M)


def body(path: Path) -> str:
    """A module's code without its __future__ import or its local imports."""
    text = path.read_text(encoding="utf-8")
    text = text.replace("from __future__ import annotations\n", "")
    return LOCAL.sub("", text).strip() + "\n"


def bundle(name: str) -> str:
    agent = (HERE / f"{name}.py").read_text(encoding="utf-8")
    parts = [body(HERE / "opencloud.py")]
    if "from chat import" in agent:
        parts.append(body(HERE / "chat.py"))
    parts.append(body(HERE / f"{name}.py"))
    header = f'"""opencloud {name} agent for Agentverse, bundled by agents/hosted/bundle.py. Edit the files in agents/hosted/, not this one."""\n'
    return header + "from __future__ import annotations\n\n" + "\n\n".join(parts)


def main() -> None:
    out = HERE / "dist"
    out.mkdir(exist_ok=True)
    for name in AGENTS:
        (out / f"{name}.py").write_text(bundle(name), encoding="utf-8")
        print(f"wrote {out / f'{name}.py'}")


if __name__ == "__main__":
    main()
