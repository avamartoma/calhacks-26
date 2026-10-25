"""Iteration1 office logic for the Fetch.ai agent, kept free of uAgents so it can be tested on its own.

The agent is another client of the local office, like the MCP servers in scripts/: it calls the
loopback API, holds no office credential, and work it starts is attributed to whoever is signed
in to the office. Chat text and office content are data; nothing in them is run as an instruction.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import quote, urlsplit

LOOPBACK = {"127.0.0.1", "localhost"}
CONFIRM_TTL = 600
PAIR_ATTEMPTS = 5
INBOX = 20


class OfficeError(Exception):
    pass


def local_origin(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "http" or parts.hostname not in LOOPBACK or parts.username or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment:
        raise OfficeError("Iteration1 URL must be a local HTTP origin.")
    return f"http://{parts.netloc}"


def same_path(a: str, b: str) -> bool:
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def _urllib_fetch(method: str, url: str, headers: dict, body: bytes | None):
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


class OfficeClient:
    """Python twin of server/office-client.mjs: a browser-style session cookie, nothing secret."""

    def __init__(self, url: str = "http://127.0.0.1:4314", project: str = ".", fetch: Callable = _urllib_fetch):
        self.base = local_origin(url)
        self.port = urlsplit(self.base).port or 80
        self.project = project
        self.fetch = fetch
        self.cookie: str | None = None

    def _call(self, method, url, headers=None, body=None):
        try:
            return self.fetch(method, url, headers or {}, body)
        except OSError:
            raise OfficeError(f"Iteration1 is unavailable at {self.base}. Start it with npm start, then retry.") from None

    def _session(self):
        _, headers, _ = self._call("GET", self.base + "/")
        raw = next((v for k, v in headers.items() if k.lower() == "set-cookie"), "")
        cookie = raw.split(";")[0]
        if not (cookie.startswith(f"office_session_{self.port}=") or cookie.startswith("office_session=")):
            raise OfficeError("Start Iteration1 before connecting this agent.")
        self.cookie = cookie

    def request(self, route: str, body: dict | None = None, retry: bool = True):
        if not self.cookie:
            self._session()
        headers = {"Cookie": self.cookie, "Origin": self.base}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        status, _, raw = self._call("GET" if body is None else "POST", self.base + "/api" + route, headers, data)
        if status == 401 and retry:
            self._session()
            return self.request(route, body, False)
        try:
            parsed = json.loads(raw or b"{}")
        except ValueError:
            parsed = {}
        if status >= 400:
            raise OfficeError(parsed.get("error") or f"Office request failed ({status})")
        return parsed

    def state(self):
        return self.request("/state")

    def rooms(self, state=None):
        state = state or self.state()
        return [r for r in state["rooms"] if not r.get("demo") and not r.get("archived") and same_path(r["path"], self.project)]

    def open(self, name: str):
        existing = self.rooms()
        if existing:
            return existing[0]
        return self.request("/rooms", {"name": name, "path": os.path.realpath(self.project), "demo": False})["room"]

    def dispatch(self, room_id: str, prompt: str):
        return self.request(f"/rooms/{quote(room_id)}/dispatch", {"prompt": prompt})

    def run_doc(self, room_id: str, work_id: str):
        return self.request(f"/rooms/{quote(room_id)}/work/{quote(work_id)}/doc")["doc"]

    def identify(self):
        return self.request("/auth/session")

    def stream(self, opener: Callable = urllib.request.urlopen, timeout: float = 90):
        """Open the office's live state stream (server-sent events). The server pings, so a quiet stream stays open."""
        for attempt in (0, 1):
            if not self.cookie or attempt:
                self._session()
            request = urllib.request.Request(self.base + "/api/events", headers={"Cookie": self.cookie, "Origin": self.base, "Accept": "text/event-stream"})
            try:
                return opener(request, timeout=timeout)
            except urllib.error.HTTPError as e:
                if e.code != 401 or attempt:
                    raise OfficeError(f"Office stream failed ({e.code})") from None
            except OSError:
                raise OfficeError(f"Iteration1 is unavailable at {self.base}. Start it with npm start, then retry.") from None


# --- What the person asked for -------------------------------------------------------------

# ASI:One may reword or wrap what the person typed, so commands are found anywhere in the text.
MISSION = re.compile(r"\b(?:mission\s*[:\-]|(?:start|dispatch|launch|assign|run)\s+(?:a\s+|the\s+|new\s+)?(?:mission|task|job)\b\s*[:\-]?)\s*(?P<p>.+)$", re.I | re.S)
VERB = re.compile(r"^\s*(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:implement|build|fix|add|make|create|refactor|write|update|remove|rename)\s+\S", re.I)
CODE = re.compile(r"^[0-9a-f]{8}$", re.I)
EDGE = " \t\r\n.,;:!?\"'`()[]{}<>*_"


@dataclass
class Intent:
    kind: str
    arg: str = ""


def code_tokens(text: str) -> list[str]:
    """Whitespace-separated tokens shaped like a pairing code. A UUID stays one token, so its parts never count."""
    return [w.strip(EDGE).lower() for w in text.split() if CODE.match(w.strip(EDGE))]


def parse(text: str) -> Intent:
    t = text.strip()
    low = t.lower()
    if not t or low.strip(EDGE) in {"hi", "hello", "hey", "help", "what can you do"}:
        return Intent("help")
    if m := MISSION.search(t):
        return Intent("mission", m.group("p").strip())
    if re.search(r"\b(?:cancel|never ?mind)\b", low) or low.strip(EDGE) in {"no", "n", "stop"}:
        return Intent("cancel")
    if re.search(r"\b(?:confirm(?:s|ed)?|go ahead|dispatch it)\b", low) or low.strip(EDGE) in {"yes", "y", "go", "do it"}:
        return Intent("confirm")
    if re.search(r"\b(?:alerts?|notifications?|what did i miss|missed)\b", low):
        return Intent("alerts")
    if re.search(r"\b(?:approvals?|permissions?|waiting on me|needs? (?:my )?approval)\b", low):
        return Intent("approvals")
    if not re.search(r"\b(?:ready for|in|awaiting|waiting for) review\b", low) and (m := re.search(r"\breview\b\s*(?:of|on)?\s*(?:task\s*)?#?(?P<arg>[^?]*)", t, re.I)):
        return Intent("review", m.group("arg").strip(EDGE))
    if m := re.search(r"\b(?:run ?doc|report|receipts?|evidence|how did)\b\s*(?:for|on|of|about)?\s*(?:task\s*)?#?(?P<arg>.*)$", t, re.I | re.S):
        return Intent("doc", re.sub(r"\s+(?:go|went|turn out|end up)$", "", m.group("arg").strip(EDGE), flags=re.I))
    if VERB.match(t):
        return Intent("mission", t)
    if re.search(r"\b(?:status|blocked|blockers?|progress|what'?s (?:happening|going on)|any updates?|working on|ready for review|tasks?|office)\b", low):
        return Intent("status")
    if re.search(r"\bpair(?:ing|ed)?\b", low) or code_tokens(t):
        return Intent("pair")
    if re.search(r"\b(?:help|what can you do)\b", low):
        return Intent("help")
    return Intent("unknown", t)


# --- Who may use it -------------------------------------------------------------------------

@dataclass
class Gate:
    """Owners are sender addresses paired with a code that is only shown in the local terminal."""

    owners: set[str] = field(default_factory=set)
    code: str = field(default_factory=lambda: secrets.token_hex(4))
    failures: int = 0
    save: Callable[[set[str]], None] = lambda owners: None
    log: Callable[[str], None] = lambda line: None

    @property
    def locked(self) -> bool:
        return self.failures >= PAIR_ATTEMPTS

    def allowed(self, sender: str) -> bool:
        return sender in self.owners

    def pair(self, sender: str, text: str) -> str:
        """Pair a sender whose message contains the current code anywhere as its own word."""
        if sender in self.owners:
            return "This address is already paired with the office."
        tokens = code_tokens(text)
        if not tokens:
            return "This office is private. If it's yours, send `pair <code>` using the code printed in the agent's terminal."
        if self.locked:
            self.log(f"PAIRING LOCKED: refused {sender}. Restart the agent to get a new code.")
            return "Pairing is locked after too many wrong codes. Restart the agent to get a new code."
        if not any(secrets.compare_digest(token, self.code) for token in tokens):
            self.failures += 1
            self.log(f"Wrong pairing code from {sender} ({self.failures}/{PAIR_ATTEMPTS}).")
            if self.locked:
                self.log(f"PAIRING LOCKED after {PAIR_ATTEMPTS} wrong codes. Restart the agent to get a new code.")
            return "That pairing code is not right. Use the code printed in the agent's terminal."
        self.owners.add(sender)
        self.save(self.owners)
        self.code = secrets.token_hex(4)  # single use
        self.log(f"Paired {sender}. Next pairing code: {self.code}")
        return "Paired. You can now read this office and start missions from here. Say `help` to see what I can do."


# --- Replies ------------------------------------------------------------------------------

HELP = """I'm the Iteration1 office agent. I watch a local office where coding agents (Codex, Claude, Cursor) work on one project.

- **status**: tasks, blockers and who is working
- **report on <task>**: the run doc for a task: what was done and what is verified versus only self-reported
- **review <task>**: ask the reviewer agent which acceptance criteria the evidence actually supports
- **approvals**: commands waiting for you in the office
- **alerts**: what the watcher noticed recently (blocked tasks, work ready for review, new approvals)
- **mission: <what to build>**: hand a new mission to the office's implementation manager (I'll ask you to confirm first)

Command approvals and stopping agents stay in the Iteration1 app on the owner's computer."""

STOP = {"the", "task", "for", "and", "with", "that", "this", "one", "please"}
ORDER = {"blocked": 0, "working": 1, "review": 2, "queued": 3, "done": 4}


def _tasks(room):
    return sorted((t for t in room.get("workItems", []) if not t.get("archived")), key=lambda t: t.get("createdAt", 0))


def _clip(text: str, n: int = 160) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


def status_text(room, approvals) -> str:
    tasks = _tasks(room)
    agents = [a for a in room.get("agents", []) if a.get("status") != "ejected"]
    lines = [f"**{room['name']}**" + (" (paused)" if room.get("paused") else ""), f"Goal: {_clip(room.get('goal') or 'none yet')}", ""]
    if tasks:
        counts = {}
        for t in tasks:
            counts[t["status"]] = counts.get(t["status"], 0) + 1
        lines.append("Tasks: " + ", ".join(f"{n} {s}" for s, n in sorted(counts.items(), key=lambda kv: ORDER.get(kv[0], 9))))
        for i, t in sorted(enumerate(tasks, 1), key=lambda it: (ORDER.get(it[1]["status"], 9), it[0]))[:8]:
            extra = f": blocked by {_clip(t['blocker'], 120)}" if t.get("blocker") and t["status"] == "blocked" else ""
            lines.append(f"{i}. [{t['status']}] {_clip(t['title'], 90)}{extra}")
    else:
        lines.append("No tasks yet. Say `mission: <what to build>` to start one.")
    busy = [a for a in agents if a.get("turnId") or a.get("status") == "working"]
    if busy:
        lines += ["", "Working now: " + ", ".join(f"{a['name']} ({a.get('provider') or 'codex'})" for a in busy[:6])]
    if approvals:
        lines += ["", f"{len(approvals)} approval request(s) are waiting in the office app."]
    return "\n".join(lines)


def approvals_text(approvals) -> str:
    if not approvals:
        return "Nothing is waiting for approval."
    lines = [f"{len(approvals)} request(s) waiting. Approve or decline them in the Iteration1 app; I can't approve commands from chat."]
    lines += [f"- {_clip(a.get('command') or a.get('method') or 'request', 140)}" for a in approvals[:6]]
    return "\n".join(lines)


def pick_task(room, query: str):
    tasks = _tasks(room)
    if not tasks:
        return None
    q = query.strip().lower()
    if not q:
        return max(tasks, key=lambda t: t.get("updatedAt", 0))
    if q.isdigit() and 1 <= int(q) <= len(tasks):
        return tasks[int(q) - 1]
    matches = [t for t in tasks if q in t["title"].lower()]
    if not matches:
        words = [w for w in re.findall(r"\w+", q) if len(w) > 2 and w not in STOP]
        matches = [t for t in tasks if words and all(w in t["title"].lower() for w in words)]
    return max(matches, key=lambda t: t.get("updatedAt", 0)) if matches else None


def doc_text(doc) -> str:
    v = doc.get("verification", {})
    who = doc.get("agent") or {}
    lines = [f"**{doc['title']}** [{doc['status']}]"]
    if who:
        lines.append(f"Owner: {who.get('name')} ({who.get('provider')}, {who.get('model') or 'model unknown'})")
    lines.append("Verified: yes" if v.get("verified") else f"Verified: no ({v.get('label', 'no checks recorded')})")
    for gap in v.get("gaps", [])[:4]:
        lines.append(f"- missing: {_clip(gap, 140)}")
    receipts = [b for b in doc.get("blocks", []) if b.get("attribution")][-6:]
    if receipts:
        lines += ["", "Latest receipts:"]
        for b in receipts:
            check = (" ✓" if b.get("passed") else " ✗") if b.get("isCheck") else ""
            lines.append(f"- [{b['attribution']}] {b.get('kind', 'note')}{check}: {_clip(b.get('command') or b.get('text', ''), 140)}")
    lines += ["", "Self-reported receipts are claims from the agent's own tool; only verified ones were checked by the office."]
    return "\n".join(lines)


# --- The conversation ----------------------------------------------------------------------

@dataclass
class OfficeAgent:
    office: OfficeClient
    gate: Gate
    office_name: str = "Fetch.ai office"
    pending: dict[str, tuple[str, float]] = field(default_factory=dict)
    clock: Callable[[], float] = time.time
    inbox: list[tuple[float, str]] = field(default_factory=list)
    outbox: list[tuple] = field(default_factory=list)  # requests for sibling agents, sent by the uAgents layer

    def remember(self, lines: list[str]) -> None:
        """Keep the watcher's latest alerts, in case a pushed message never reaches the chat."""
        now = self.clock()
        self.inbox = (self.inbox + [(now, line) for line in lines])[-INBOX:]

    def alerts_text(self) -> str:
        if not self.inbox:
            return "No alerts yet. When the watcher agent is running, I'll message you when tasks block, finish or need approval."
        now = self.clock()
        ago = lambda t: "just now" if now - t < 60 else f"{int((now - t) // 60)} min ago" if now - t < 3600 else f"{int((now - t) // 3600)} h ago"
        return "Recent alerts, newest last:\n" + "\n".join(f"- {line} ({ago(t)})" for t, line in self.inbox[-10:])

    def handle(self, sender: str, text: str) -> str:
        if not self.gate.allowed(sender):
            return self.gate.pair(sender, text)
        intent = parse(text)
        if intent.kind == "pair":
            return "This address is already paired with the office."
        try:
            return self._owner(sender, intent)
        except OfficeError as e:
            return f"The office said: {e}"

    def local(self, room_id: str, text: str) -> str:
        """A message typed in the office app. The person at this computer owns the office, so no pairing,
        and the answer is about the project they have open."""
        intent = parse(text)
        if intent.kind == "pair":
            return "No pairing needed here: you're already in the office app. Pairing is for ASI:One."
        try:
            return self._owner(f"local:{room_id}", intent, room_id)
        except OfficeError as e:
            return f"The office said: {e}"

    def _room(self, create: bool = False):
        rooms = self.office.rooms()
        if rooms:
            return rooms[0]
        return self.office.open(self.office_name) if create else None

    def _owner(self, sender: str, intent: Intent, room_id: str = "") -> str:
        if intent.kind == "help":
            return HELP
        if intent.kind == "alerts":
            return self.alerts_text()
        if intent.kind == "cancel":
            return "Cancelled. Nothing was sent to the office." if self.pending.pop(sender, None) else "Nothing to cancel."
        if intent.kind == "mission":
            prompt = intent.arg.strip()
            if len(prompt) < 8:
                return "Describe the mission in a sentence, for example `mission: make the search box keyboard accessible`."
            self.pending[sender] = (prompt[:12000], self.clock() + CONFIRM_TTL)
            return (f"Ready to hand this to the office's implementation manager:\n\n> {_clip(prompt, 400)}\n\n"
                    "It replaces the current mission and agents may edit the project. Reply `confirm` within 10 minutes, or `cancel`.")
        if intent.kind == "confirm":
            prompt, expires = self.pending.pop(sender, ("", 0))
            if not prompt or expires < self.clock():
                return "There is no mission waiting for confirmation. Say `mission: <what to build>` first."
            return self.dispatch(prompt, room_id)
        state = self.office.state()
        room = next((r for r in state["rooms"] if r["id"] == room_id), None) if room_id else next(iter(self.office.rooms(state)), None)
        if room is None:
            return "There's no office for this project yet. Say `mission: <what to build>` to start one."
        approvals = [a for a in state.get("approvals", []) if a.get("roomId") == room["id"]]
        if intent.kind == "status":
            return status_text(room, approvals)
        if intent.kind == "approvals":
            return approvals_text(approvals)
        if intent.kind == "doc":
            task = pick_task(room, intent.arg)
            if not task:
                return "I couldn't find that task. Say `status` for the numbered list, then `report on 2`."
            return doc_text(self.office.run_doc(room["id"], task["id"]))
        if intent.kind == "review":
            task = pick_task(room, intent.arg)
            if not task:
                return "I couldn't find that task. Say `status` for the numbered list, then `review 2`."
            self.outbox.append(("review", sender, room["id"], task["id"]))
            return f"Asked the reviewer agent to check **{_clip(task['title'], 100)}** against its acceptance criteria. Its answer will follow."
        return "I didn't catch that. " + HELP

    def dispatch(self, prompt: str, room_id: str = "") -> str:
        """Start a mission. Used after an owner confirms here, or when the planner starts a Jira story an owner chose."""
        room = next((r for r in self.office.state()["rooms"] if r["id"] == room_id), None) if room_id else None
        room = room or self._room(create=True)
        self.office.dispatch(room["id"], prompt[:12000])
        return f"Mission sent to **{room['name']}**. Say `status` to follow it; any command approvals appear in the office app."
