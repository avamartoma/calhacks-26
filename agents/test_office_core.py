"""Run with: python -m unittest discover agents"""
import json
import os
import tempfile
import unittest

from office_core import Gate, OfficeAgent, OfficeClient, OfficeError, code_tokens, local_origin, parse

OWNER, STRANGER = "agent1qowner", "agent1qstranger"


class FakeOffice:
    """Answers like the office's HTTP API and records what was posted."""

    def __init__(self, project):
        self.project, self.posts = project, []
        self.room = {"id": "r1", "name": "Office", "path": project, "demo": False, "goal": "Ship search", "paused": False,
                     "agents": [{"id": "a1", "name": "Ada", "provider": "codex", "status": "working", "turnId": "t"}],
                     "workItems": [{"id": "w1", "title": "Make search keyboard accessible", "status": "blocked", "blocker": "Tests fail", "createdAt": 1, "updatedAt": 5},
                                   {"id": "w2", "title": "Write docs", "status": "review", "createdAt": 2, "updatedAt": 3}]}

    def __call__(self, method, url, headers, body):
        if url.endswith(":4314/"):
            return 200, {"Set-Cookie": "office_session_4314=abc; HttpOnly"}, b""
        assert headers["Cookie"] == "office_session_4314=abc" and headers["Origin"] == "http://127.0.0.1:4314"
        route = url.split("/api", 1)[1]
        if route == "/state":
            return 200, {}, json.dumps({"rooms": [self.room, {**self.room, "id": "demo", "demo": True}], "approvals": [{"roomId": "r1", "command": "npm test"}]}).encode()
        if route == "/rooms/r1/work/w1/doc":
            return 200, {}, json.dumps({"doc": {"title": "Make search keyboard accessible", "status": "blocked", "agent": {"name": "Ada", "provider": "codex", "model": "gpt"},
                                                "verification": {"verified": False, "label": "No checks recorded", "gaps": ["Search is reachable with Tab"]},
                                                "blocks": [{"kind": "test", "attribution": "self-reported", "text": "1 passing"}]}}).encode()
        if method == "POST" and route == "/rooms/r1/dispatch":
            self.posts.append(json.loads(body))
            return 200, {}, b"{}"
        return 400, {}, json.dumps({"error": "Pause the office before starting a new mission."}).encode()


class OfficeAgentTest(unittest.TestCase):
    def setUp(self):
        self.project = tempfile.mkdtemp()
        self.fake = FakeOffice(self.project)
        self.saved = []
        self.logged = []
        self.gate = Gate(save=lambda owners: self.saved.append(set(owners)), log=self.logged.append)
        self.agent = OfficeAgent(OfficeClient(project=self.project, fetch=self.fake), self.gate)

    def pair(self):
        return self.agent.handle(OWNER, f"pair {self.gate.code}")

    def test_only_paired_senders_reach_the_office(self):
        self.assertIn("private", self.agent.handle(STRANGER, "status"))
        self.assertIn("Paired", self.pair())
        self.assertEqual(self.saved, [{OWNER}])
        self.assertIn("private", self.agent.handle(STRANGER, "status"))

    def test_pairing_codes_are_single_use_and_lock_after_guesses(self):
        code = self.gate.code
        self.pair()
        self.assertIn("not right", self.agent.handle(STRANGER, f"pair {code}"))
        for _ in range(4):
            self.agent.handle(STRANGER, "pair 00000000")
        self.assertIn("locked", self.agent.handle(STRANGER, f"pair {self.gate.code}"))
        self.assertFalse(self.gate.allowed(STRANGER))
        self.assertTrue(any("PAIRING LOCKED after 5" in line for line in self.logged))
        self.assertTrue(any(line.startswith("Paired agent1qowner. Next pairing code:") for line in self.logged))

    def test_pairing_code_is_found_in_reworded_messages(self):
        text = f"The user would like to pair with the Iteration1 office using the code **{self.gate.code.upper()}**."
        self.assertIn("Paired", self.agent.handle(OWNER, text))

    def test_messages_without_a_code_do_not_count_against_pairing(self):
        for _ in range(10):
            self.assertIn("private", self.agent.handle(STRANGER, "what's the status of my office?"))
        session = "session 3f2b8c1a-1d2e-4f5a-9b8c-7d6e5f4a3b2c"
        self.assertIn("private", self.agent.handle(STRANGER, session))
        self.assertEqual(self.gate.failures, 0)

    def test_status_lists_blockers_and_waiting_approvals(self):
        self.pair()
        text = self.agent.handle(OWNER, "what's blocked?")
        self.assertIn("1. [blocked] Make search keyboard accessible: blocked by Tests fail", text)
        self.assertIn("Ada (codex)", text)
        self.assertIn("1 approval request", text)
        self.assertIn("npm test", self.agent.handle(OWNER, "any approvals?"))

    def test_report_separates_verified_from_self_reported(self):
        self.pair()
        text = self.agent.handle(OWNER, "report on search")
        self.assertIn("Verified: no", text)
        self.assertIn("missing: Search is reachable with Tab", text)
        self.assertIn("[self-reported] test", text)
        self.assertIn("Make search", self.agent.handle(OWNER, "how did task 1 go?"))

    def test_missions_dispatch_only_after_confirmation(self):
        self.pair()
        self.assertIn("confirm", self.agent.handle(OWNER, "mission: make the search box keyboard accessible"))
        self.assertEqual(self.fake.posts, [])
        self.assertIn("Cancelled", self.agent.handle(OWNER, "cancel"))
        self.assertIn("no mission waiting", self.agent.handle(OWNER, "confirm"))
        self.agent.handle(OWNER, "fix the flaky login test")
        self.assertIn("Mission sent", self.agent.handle(OWNER, "confirm"))
        self.assertEqual(self.fake.posts, [{"prompt": "fix the flaky login test"}])

    def test_confirmations_expire(self):
        self.pair()
        now = [1000.0]
        self.agent.clock = lambda: now[0]
        self.agent.handle(OWNER, "mission: rename the settings panel")
        now[0] += 601
        self.assertIn("no mission waiting", self.agent.handle(OWNER, "confirm"))

    def test_office_errors_are_reported_not_raised(self):
        self.pair()
        self.fake.room["id"] = "r2"
        self.agent.handle(OWNER, "mission: add a dark mode toggle")
        self.assertIn("The office said: Pause the office", self.agent.handle(OWNER, "confirm"))

    def test_other_projects_and_demo_rooms_are_ignored(self):
        self.pair()
        self.fake.room["path"] = os.path.dirname(self.project)
        self.assertIn("no office for this project", self.agent.handle(OWNER, "status").lower())

    def test_only_loopback_offices(self):
        for url in ["http://example.com:4314", "https://127.0.0.1:4314", "http://user:pw@127.0.0.1:4314", "http://127.0.0.1:4314/api"]:
            with self.assertRaises(OfficeError):
                local_origin(url)

    def test_intents(self):
        cases = {"hi": "help", "status": "status", "tasks": "status", "pair abc123": "pair", "yes": "confirm",
                 "start a mission: ship it": "mission", "implement OAuth refresh": "mission", "update the README": "mission",
                 "any updates?": "status", "show the run doc for 2": "doc", "do a barrel roll": "unknown",
                 "The user wants the current status of the office.": "status", "Please list pending approvals": "approvals",
                 "User asks: report on search": "doc", "The user says: mission: add dark mode": "mission",
                 "The user confirms the mission.": "confirm", "please cancel that": "cancel", "pair 1a2b3c4d": "pair"}
        for text, kind in cases.items():
            self.assertEqual(parse(text).kind, kind, text)
        self.assertEqual(parse("show the run doc for 2").arg, "2")
        self.assertEqual(parse("The user says: mission: add dark mode").arg, "add dark mode")
        self.assertEqual(code_tokens("code: `1A2B3C4D`."), ["1a2b3c4d"])


if __name__ == "__main__":
    unittest.main()
