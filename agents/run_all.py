"""Start every Iteration1 agent in this terminal and keep them running.

    .office/runtime/agent-venv/Scripts/python agents/run_all.py      (bin/python on macOS and Linux)

Runs the office, watcher, reviewer and planner agents with their output prefixed by name, restarts any
that exits (waiting longer after each quick crash), and stops them all on Ctrl+C. The office itself
(npm start) runs separately.
"""
from __future__ import annotations

import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
AGENTS = ["office_agent", "watcher_agent", "reviewer_agent", "planner_agent"]
STABLE = 60  # an agent that ran this long before exiting is restarted right away


def pipe(name: str, stream) -> None:
    for line in iter(stream.readline, b""):
        sys.stdout.write(f"{name:>8} | {line.decode('utf-8', 'replace').rstrip()}\n")
        sys.stdout.flush()


def supervise(script: str, stop: threading.Event) -> None:
    name, delay = script.removesuffix("_agent"), 2.0
    while not stop.is_set():
        started = time.time()
        proc = subprocess.Popen([sys.executable, "-u", str(HERE / f"{script}.py")], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        threading.Thread(target=pipe, args=(name, proc.stdout), daemon=True).start()
        while proc.poll() is None and not stop.is_set():
            time.sleep(0.5)
        if stop.is_set():
            proc.terminate()
            return
        delay = 2.0 if time.time() - started > STABLE else min(delay * 2, 60.0)
        print(f"{name:>8} | exited with code {proc.returncode}; restarting in {delay:.0f}s", flush=True)
        stop.wait(delay)


def main() -> None:
    sys.stdout.reconfigure(errors="backslashreplace")
    stop = threading.Event()
    threads = []
    for script in AGENTS:
        thread = threading.Thread(target=supervise, args=(script, stop), daemon=True)
        thread.start()
        threads.append(thread)
        time.sleep(1.5)  # the office agent creates the pairing config the others read
    print("All agents started. Press Ctrl+C to stop them.", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("Stopping agents…", flush=True)
        stop.set()
        for thread in threads:
            thread.join(timeout=10)


if __name__ == "__main__":
    main()
