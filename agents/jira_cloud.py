"""A narrow Jira Cloud client for the planner: create issues, read them, comment and move them to Done in one
project. Credentials come from .office/jira.json (written by agents/configure.py) or JIRA_* variables, and
are only ever sent to an https://*.atlassian.net site."""
from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable
from urllib.parse import quote, urlencode, urlsplit

CONFIG = Path(os.environ.get("OFFICE_JIRA_CONFIG") or Path(__file__).resolve().parent.parent / ".office" / "jira.json")
KEY = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b")


class JiraError(Exception):
    pass


def jira_site(url: str) -> str:
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host.endswith(".atlassian.net") or parts.username or parts.password or parts.port:
        raise JiraError("The Jira site must look like https://your-team.atlassian.net.")
    return f"https://{host}"


def load_config() -> dict | None:
    env = {k: os.environ.get(f"JIRA_{k.upper()}") for k in ("site", "email", "token", "project")}
    if all(env.values()):
        return env
    try:
        data = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    return data if all(data.get(k) for k in ("site", "email", "token", "project")) else None


def _urllib(method: str, url: str, headers: dict, body: bytes | None):
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def adf(text: str = "", bullets: list[str] | None = None, heading: str | None = None) -> dict:
    """Atlassian Document Format for a paragraph, an optional heading and a bullet list."""
    content = [{"type": "paragraph", "content": [{"type": "text", "text": line}]} for line in text.split("\n\n") if line.strip()]
    if bullets:
        if heading:
            content.append({"type": "heading", "attrs": {"level": 3}, "content": [{"type": "text", "text": heading}]})
        content.append({"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": b}]}]} for b in bullets]})
    return {"type": "doc", "version": 1, "content": content or [{"type": "paragraph", "content": []}]}


def adf_text(node) -> str:
    """Plain text from an ADF document, one line per block."""
    if not isinstance(node, dict):
        return ""
    if node.get("type") == "text":
        return node.get("text", "")
    parts = [adf_text(child) for child in node.get("content", [])]
    joiner = "\n" if node.get("type") in {"doc", "bulletList", "orderedList", "listItem"} else ""
    text = joiner.join(p for p in parts if p)
    return ("- " + text) if node.get("type") == "listItem" else text


class Jira:
    def __init__(self, site: str, email: str, token: str, project: str, fetch: Callable = _urllib):
        self.site, self.project, self.fetch = jira_site(site), project.strip().upper(), fetch
        if not re.fullmatch(r"[A-Z][A-Z0-9]{1,9}", self.project):
            raise JiraError("The Jira project key should look like ONB or WEB2.")
        self._auth = "Basic " + base64.b64encode(f"{email}:{token}".encode()).decode()
        self._types: dict[str, str] | None = None

    def call(self, method: str, path: str, body: dict | None = None):
        headers = {"Authorization": self._auth, "Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        try:
            status, raw = self.fetch(method, self.site + path, headers, data)
        except OSError:
            raise JiraError(f"Couldn't reach {self.site}.") from None
        try:
            parsed = json.loads(raw) if raw else {}
        except ValueError:
            parsed = {}
        if status in (401, 403):
            raise JiraError("Jira refused the credentials. Run agents/configure.py again with a fresh API token.")
        if status >= 400:
            messages = list(parsed.get("errorMessages", [])) + [f"{k}: {v}" for k, v in parsed.get("errors", {}).items()]
            raise JiraError("Jira said: " + ("; ".join(messages) or f"request failed ({status})"))
        return parsed

    def owns(self, key: str) -> bool:
        return key.upper().startswith(self.project + "-")

    def check(self) -> str:
        me = self.call("GET", "/rest/api/3/myself")
        project = self.call("GET", f"/rest/api/3/project/{quote(self.project)}")
        return f"{me.get('displayName', 'you')} on {project.get('name', self.project)} ({self.project})"

    def issue_types(self) -> dict[str, str]:
        """Pick the project's epic and story types by name, falling back to Task."""
        if self._types is None:
            data = self.call("GET", f"/rest/api/3/issue/createmeta/{quote(self.project)}/issuetypes")
            types = data.get("issueTypes") or data.get("values") or []
            by_name = {t["name"].lower(): t["id"] for t in types if not t.get("subtask")}
            story = by_name.get("story") or by_name.get("task")
            if not story:
                raise JiraError(f"Project {self.project} has no Story or Task issue type.")
            self._types = {"epic": by_name.get("epic", ""), "story": story}
        return self._types

    def create(self, summary: str, description: str, criteria: list[str] | None = None, kind: str = "story", parent: str | None = None) -> str:
        types = self.issue_types()
        fields = {"project": {"key": self.project}, "summary": summary[:250], "issuetype": {"id": types[kind] or types["story"]},
                  "description": adf(description, criteria, "Acceptance criteria")}
        if parent:
            fields["parent"] = {"key": parent}
        try:
            return self.call("POST", "/rest/api/3/issue", {"fields": fields})["key"]
        except JiraError:
            if not parent:
                raise
            fields.pop("parent")  # some projects don't allow stories under an epic; keep the story anyway
            return self.call("POST", "/rest/api/3/issue", {"fields": fields})["key"]

    def issue(self, key: str) -> dict:
        if not self.owns(key):
            raise JiraError(f"I only work with {self.project} issues.")
        data = self.call("GET", f"/rest/api/3/issue/{quote(key)}?fields=summary,description,status")
        f = data.get("fields", {})
        return {"key": data.get("key", key), "summary": f.get("summary", ""), "description": adf_text(f.get("description")), "status": (f.get("status") or {}).get("name", "")}

    def open_issues(self, limit: int = 10) -> list[dict]:
        jql = f"project = {self.project} AND statusCategory != Done ORDER BY created DESC"
        data = self.call("GET", "/rest/api/3/search/jql?" + urlencode({"jql": jql, "fields": "summary,status,issuetype", "maxResults": limit}))
        return [{"key": i["key"], "summary": i["fields"].get("summary", ""), "status": i["fields"].get("status", {}).get("name", ""), "type": i["fields"].get("issuetype", {}).get("name", "")} for i in data.get("issues", [])]

    def comment(self, key: str, text: str) -> None:
        if self.owns(key):
            self.call("POST", f"/rest/api/3/issue/{quote(key)}/comment", {"body": adf(text)})

    def finish(self, key: str) -> bool:
        """Move an issue to the project's Done status, if a transition leads there."""
        if not self.owns(key):
            return False
        transitions = self.call("GET", f"/rest/api/3/issue/{quote(key)}/transitions").get("transitions", [])
        done = next((t for t in transitions if (t.get("to", {}).get("statusCategory") or {}).get("key") == "done"), None)
        if not done:
            return False
        self.call("POST", f"/rest/api/3/issue/{quote(key)}/transitions", {"transition": {"id": done["id"]}})
        return True
