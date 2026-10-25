"""Run with: python -m unittest discover agents"""
import base64
import json
import unittest

from jira_cloud import Jira, JiraError, adf, adf_text, jira_site
from llm import ask_json, first_json
from planner_core import PlannerAgent, fallback_plan, mission_prompt
from review_core import review

OWNER = "agent1qowner"


def doc(gaps=(), blocks=None):
    return {"title": "Make search keyboard accessible", "status": "review",
            "verification": {"verified": not gaps, "gaps": list(gaps)},
            "blocks": blocks if blocks is not None else [
                {"kind": "brief", "criteria": ["Search is reachable with Tab", "Tests pass"]},
                {"kind": "diff", "attribution": "observed", "text": "src/Search.tsx +tabIndex"},
                {"kind": "test", "attribution": "verified", "command": "npm test", "isCheck": True, "passed": True, "text": "12 passing"}]}


class ReviewTest(unittest.TestCase):
    def test_office_checks_without_a_model(self):
        text = review(doc(["Unchecked criterion: Search is reachable with Tab"]))
        self.assertIn("? Search is reachable with Tab: no passing check recorded", text)
        self.assertIn("✓ Tests pass: checked by the office", text)
        self.assertIn("Test runs: 1 passed, 0 failed", text)
        self.assertIn("Not ready", text)
        self.assertIn("Looks ready to approve", review(doc()))

    def test_self_reported_only_evidence_is_flagged(self):
        blocks = [{"kind": "brief", "criteria": ["Works"]}, {"kind": "note", "attribution": "self-reported", "text": "Done, trust me"}]
        self.assertIn("All evidence is self-reported", review(doc(blocks=blocks)))

    def test_model_verdicts_cite_receipts_and_bad_replies_fall_back(self):
        seen = []

        def ask(system, user):
            seen.append(user)
            return {"criteria": [{"criterion": "Search is reachable with Tab", "verdict": "met", "receipts": [1], "why": "tabIndex added"},
                                 {"criterion": "Tests pass", "verdict": "bogus", "receipts": ["x"], "why": ""}], "summary": "Mostly there."}
        text = review(doc(), ask)
        self.assertIn("✓ Search is reachable with Tab: met per #1. tabIndex added", text)
        self.assertIn("? Tests pass: unproven", text)
        self.assertIn("Mostly there.", text)
        self.assertIn("1. [observed] diff: src/Search.tsx +tabIndex", seen[0])
        self.assertIn("checked by the office", review(doc(), lambda s, u: "not json"))


class FakeJira:
    def __init__(self):
        self.calls, self.created = [], []

    def __call__(self, method, url, headers, body):
        assert url.startswith("https://team.atlassian.net/rest/api/3/")
        assert headers["Authorization"] == "Basic " + base64.b64encode(b"me@x.com:tok").decode()
        path = url.split("/rest/api/3", 1)[1]
        data = json.loads(body) if body else None
        self.calls.append((method, path, data))
        if path == "/issue/createmeta/ONB/issuetypes":
            return 200, json.dumps({"issueTypes": [{"id": "1", "name": "Epic"}, {"id": "2", "name": "Story"}, {"id": "3", "name": "Sub-task", "subtask": True}]}).encode()
        if method == "POST" and path == "/issue":
            key = f"ONB-{len(self.created) + 1}"
            self.created.append((key, data["fields"]))
            return 201, json.dumps({"key": key}).encode()
        if path.startswith("/issue/ONB-2?"):
            return 200, json.dumps({"key": "ONB-2", "fields": {"summary": "Tab to search", "status": {"name": "To Do"},
                                                                 "description": adf("Users reach search by keyboard.", ["Tab focuses search"], "Acceptance criteria")}}).encode()
        if path == "/issue/ONB-2/transitions" and method == "GET":
            return 200, json.dumps({"transitions": [{"id": "11", "to": {"statusCategory": {"key": "indeterminate"}}}, {"id": "31", "to": {"statusCategory": {"key": "done"}}}]}).encode()
        if path.startswith("/search/jql?"):
            return 200, json.dumps({"issues": [{"key": "ONB-2", "fields": {"summary": "Tab to search", "status": {"name": "To Do"}, "issuetype": {"name": "Story"}}}]}).encode()
        if method == "POST":
            return 204, b""
        return 401, b"{}"


class PlannerTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeJira()
        self.jira = Jira("https://team.atlassian.net", "me@x.com", "tok", "onb", fetch=self.fake)
        self.plan = {"epic": {"summary": "Keyboard search", "description": "Make search usable without a mouse"},
                     "stories": [{"summary": "Tab to search", "description": "Focus order", "acceptance_criteria": ["Tab focuses search"]},
                                 {"summary": "Enter submits", "description": "", "acceptance_criteria": []}]}
        self.planner = PlannerAgent(self.jira, owners=lambda: {OWNER}, ask=lambda s, u: self.plan)

    def test_only_the_office_owner_can_plan(self):
        self.assertIn("Pair with iteration1-office first", self.planner.handle("stranger", "plan: anything at all"))
        self.assertEqual(self.fake.calls, [])

    def test_plans_are_drafted_then_created_only_on_confirm(self):
        draft = self.planner.handle(OWNER, "The user wants to plan: keyboard-friendly search")
        self.assertIn("**Epic:** Keyboard search", draft)
        self.assertIn("   - Tab focuses search", draft)
        self.assertEqual(self.fake.created, [])
        done = self.planner.handle(OWNER, "confirm")
        self.assertIn("epic ONB-1, 2 stories", done)
        self.assertIn("start ONB-2", done)
        epic, story = self.fake.created[0][1], self.fake.created[1][1]
        self.assertEqual((epic["issuetype"]["id"], story["issuetype"]["id"], story["parent"]), ("1", "2", {"key": "ONB-1"}))
        self.assertIn("Tab focuses search", adf_text(story["description"]))
        self.assertEqual(self.fake.created[2][1]["description"]["content"][-1]["type"], "bulletList")  # default criterion
        self.assertIn("no plan waiting", self.planner.handle(OWNER, "confirm"))

    def test_starting_a_story_queues_a_mission_for_the_office_agent(self):
        text = self.planner.handle(OWNER, "please start onb-2")
        self.assertIn("Asking the office to start **ONB-2: Tab to search**", text)
        requester, prompt = self.planner.outbox[0]
        self.assertEqual(requester, OWNER)
        self.assertTrue(prompt.startswith("ONB-2: Tab to search\n"))
        self.assertIn("- Tab focuses search", prompt)
        self.assertIn("only work with ONB", self.planner.handle(OWNER, "start WEB-9"))

    def test_progress_is_mirrored_and_only_verified_work_closes_the_issue(self):
        self.assertIsNone(self.planner.on_event("review", "Unrelated task"))
        self.assertIsNone(self.planner.on_event("done", "WEB-1: other project", verified=True))
        self.assertEqual(self.planner.on_event("done", "ONB-2: Tab to search", "not verified: 1 gap(s)", False), "ONB-2: commented (done)")
        self.assertFalse(any(path.endswith("/transitions") for _, path, _ in self.fake.calls))
        self.assertEqual(self.planner.on_event("done", "ONB-2: Tab to search", "verified", True), "ONB-2: moved to Done")
        self.assertIn(("POST", "/issue/ONB-2/transitions", {"transition": {"id": "31"}}), self.fake.calls)
        self.assertEqual(self.planner.on_event("blocked", "ONB-2: Tab to search", "Tests fail"), "ONB-2: commented (blocked)")

    def test_backlog_and_fallback_plan(self):
        self.assertIn("- ONB-2 [To Do] Tab to search", self.planner.handle(OWNER, "show the backlog"))
        plan = fallback_plan("add login; add logout\n- add password reset")
        self.assertEqual([s["summary"] for s in plan.stories], ["add login", "add logout", "add password reset"])
        planner = PlannerAgent(self.jira, owners=lambda: {OWNER}, ask=lambda s, u: "garbage")
        self.assertIn("simple split", planner.handle(OWNER, "plan: add login; add logout"))

    def test_credentials_only_go_to_atlassian(self):
        for site in ["http://team.atlassian.net", "https://evil.com", "https://team.atlassian.net.evil.com", "https://u:p@team.atlassian.net"]:
            with self.assertRaises(JiraError):
                jira_site(site)
        with self.assertRaises(JiraError):
            Jira("https://team.atlassian.net", "a", "b", "not a key")
        bad = Jira("https://team.atlassian.net", "me@x.com", "wrong", "ONB", fetch=lambda *a: (401, b"{}"))
        with self.assertRaises(JiraError) as e:
            bad.check()
        self.assertIn("refused the credentials", str(e.exception))

    def test_mission_prompt_and_model_json(self):
        self.assertTrue(mission_prompt({"key": "ONB-3", "summary": "S", "description": "D"}).startswith("ONB-3: S\n\nD"))
        self.assertEqual(first_json('Sure! ```json\n{"a": {"b": 1}}\n``` done'), {"a": {"b": 1}})
        captured = {}

        def post(url, headers, body):
            captured.update(url=url, auth=headers["Authorization"], body=json.loads(body))
            return {"choices": [{"message": {"content": '{"ok": true}'}}]}
        self.assertEqual(ask_json("sys", "hi", post=post, key="k1"), {"ok": True})
        self.assertEqual((captured["url"], captured["auth"], captured["body"]["model"]), ("https://api.asi1.ai/v1/chat/completions", "Bearer k1", "asi1"))
        self.assertIsNone(ask_json("sys", "hi", post=lambda *a: (_ for _ in ()).throw(OSError()), key="k1"))


if __name__ == "__main__":
    unittest.main()
