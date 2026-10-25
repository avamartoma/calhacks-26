"""ASI:One's model, used by the reviewer and planner for judgment and drafting. Optional: without a key
both fall back to rule-based behavior. The key comes from ASI1_API_KEY or .office/asi1.json."""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

URL = "https://api.asi1.ai/v1/chat/completions"
MODEL = os.environ.get("ASI1_MODEL", "asi1")
KEY_FILE = Path(__file__).resolve().parent.parent / ".office" / "asi1.json"


def api_key() -> str | None:
    if os.environ.get("ASI1_API_KEY"):
        return os.environ["ASI1_API_KEY"]
    try:
        return json.loads(KEY_FILE.read_text(encoding="utf-8-sig")).get("key")
    except (OSError, ValueError):
        return None


def _post(url: str, headers: dict, body: bytes) -> dict:
    request = urllib.request.Request(url, data=body, method="POST", headers=headers)
    with urllib.request.urlopen(request, timeout=60) as res:
        return json.loads(res.read())


def first_json(text: str):
    """The first JSON object in a reply, tolerating code fences and prose around it."""
    text = re.sub(r"```(?:json)?", "", text)
    start = text.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(text)):
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except ValueError:
                    break
        start = text.find("{", start + 1)
    return None


def ask_json(system: str, user: str, post: Callable = _post, key: str | None = None):
    """Ask for a JSON object. Returns None when no key is set or the model fails, so callers fall back."""
    key = key or api_key()
    if not key:
        return None
    body = json.dumps({"model": MODEL, "temperature": 0.2, "messages": [
        {"role": "system", "content": system + "\nAnswer with one JSON object only."},
        {"role": "user", "content": user}]}).encode()
    try:
        reply = post(URL, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, body)
        return first_json(reply["choices"][0]["message"]["content"])
    except (OSError, urllib.error.URLError, KeyError, IndexError, TypeError, ValueError):
        return None
