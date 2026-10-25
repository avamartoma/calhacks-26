"""Tests for the hosted agents' shared logic. Run: python3 -m unittest discover agents/hosted"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import opencloud as oc  # noqa: E402

TOKEN = "t" * 40
PROJECT = {"id": "p1", "name": "Notes API", "slug": "notes-api", "description": "", "preview": None, "runs": [
    {"id": "r2", "prompt": "Add a /health endpoint", "status": "done", "detail": "Added it.", "by": "Ava", "startedAt": 2, "finishedAt": 3},
    {"id": "r1", "prompt": "Write the README", "status": "error", "detail": "Not logged in", "by": "Neha", "startedAt": 1, "finishedAt": 2},
]}
REPORT = {"project": {"id": "p1", "name": "Notes API"}, "run": {"id": "r2", "prompt": "Add a /health endpoint", "status": "done", "detail": "Added it.", "by": "Ava", "agent": "claude", "lines": [
    {"kind": "text", "text": "Looking at the routes."},
    {"kind": "tool", "text": "Edit: src/routes.ts"},
    {"kind": "tool", "text": "Bash: npm test"},
    {"kind": "result", "text": "Added GET /health returning ok, and a test."},
]}}


class FakeCloud:
    """Answers like convex/http.ts and records what was asked."""

    def __init__(self, projects=None):
        self.calls, self.projects_ = [], projects if projects is not None else [PROJECT]

    def __call__(self, method, url, headers, body):
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        path = url.split(".convex.site")[1].split("?")[0]
        data = json.loads(body) if body else {}
        self.calls.append((method, path, data))
        answers = {"/fetch/state": {"projects": self.projects_}, "/fetch/run": REPORT, "/fetch/dispatch": {"runId": "r3"}, "/fetch/request": {"job": "j1"},
                   "/fetch/heartbeat": {"jobs": [{"id": "j9", "kind": "chat"}]}, "/fetch/activity": {}, "/fetch/finish": {}}
        if path == "/fetch/dispatch" and not data.get("prompt"):
            return 400, json.dumps({"error": "Describe the work to start"}).encode()
        return 200, json.dumps(answers[path]).encode()


def cloud(fake, name="office"):
    return oc.Cloud(name, url="https://hidden-mink-963.convex.site", token=TOKEN, fetch=fake)


class CloudTest(unittest.TestCase):
    def test_calls_carry_the_token_and_agent_name(self):
        fake = FakeCloud()
        jobs = cloud(fake, "reviewer").heartbeat("agent1qexample", {"x": 1})
        self.assertEqual(jobs, [{"id": "j9", "kind": "chat"}])
        self.assertEqual(fake.calls[0], ("POST", "/fetch/heartbeat", {"name": "reviewer", "address": "agent1qexample", "details": {"x": 1}}))

    def test_errors_from_opencloud_are_raised_with_their_message(self):
        with self.assertRaisesRegex(oc.CloudError, "Describe the work"):
            cloud(FakeCloud()).dispatch("p1", "")

    def test_an_unconfigured_agent_says_what_to_set(self):
        with self.assertRaisesRegex(oc.CloudError, "OPENCLOUD_URL"):
            oc.Cloud("office", url="", token="").projects()


class OfficeTest(unittest.TestCase):
    def test_status_lists_demo_projects_and_their_runs(self):
        text = oc.office_answer("status", cloud(FakeCloud()))
        self.assertIn("**Notes API**: no agents working", text)
        self.assertIn("done: Add a /health endpoint (Ava)", text)
        self.assertIn("failed: Write the README (Neha)", text)

    def test_report_reads_the_latest_run(self):
        text = oc.office_answer("report notes", cloud(FakeCloud()))
        self.assertIn("Added GET /health returning ok", text)
        self.assertIn("Used 2 tool(s)", text)

    def test_starting_work_needs_pairing_and_then_dispatches(self):
        fake = FakeCloud()
        self.assertIn("Pair first", oc.office_answer("mission notes api: add rate limits", cloud(fake)))
        text = oc.office_answer("mission notes api: add rate limits", cloud(fake), paired=True)
        self.assertIn("Started a Claude agent on **Notes API**", text)
        self.assertIn(("POST", "/fetch/dispatch", {"name": "office", "projectId": "p1", "prompt": "add rate limits"}), fake.calls)

    def test_review_queues_the_reviewer_on_the_latest_finished_run(self):
        fake = FakeCloud()
        oc.office_answer("review notes", cloud(fake), paired=True)
        self.assertIn(("POST", "/fetch/request", {"name": "office", "agent": "reviewer", "kind": "review", "projectId": "p1", "runId": "r2", "payload": {}}), fake.calls)

    def test_from_the_web_office_answers_stay_on_that_project(self):
        other = {**PROJECT, "id": "p2", "name": "Weather CLI", "runs": []}
        text = oc.office_answer("status", cloud(FakeCloud([PROJECT, other])), project={"id": "p2", "name": "Weather CLI"}, paired=True)
        self.assertIn("Weather CLI", text)
        self.assertNotIn("Notes API", text)
        hidden = oc.office_answer("status", cloud(FakeCloud([PROJECT])), project={"id": "p9", "name": "Secret"}, paired=True)
        self.assertIn("isn't a team demo project", hidden)

    def test_no_demo_projects_explains_how_to_add_one(self):
        self.assertIn("No team demo projects yet", oc.office_answer("status", cloud(FakeCloud([]))))


class ReviewTest(unittest.TestCase):
    def test_without_a_model_it_reports_what_ran(self):
        text = oc.review_text(REPORT)
        self.assertIn("Evidence: 2 tool call(s), 1 test command(s)", text)
        self.assertIn("**Verdict:** Looks ready", text)

    def test_with_a_model_it_marks_each_check(self):
        ask = lambda system, user: {"checks": [{"check": "GET /health exists", "verdict": "met", "why": "Edited routes"}, {"check": "Has a test", "verdict": "unproven", "why": "No output shown"}], "summary": "Mostly there."}
        text = oc.review_text(REPORT, ask)
        self.assertIn("✓ GET /health exists: met", text)
        self.assertIn("? Has a test: unproven", text)
        self.assertIn("Not ready", text)

    def test_a_run_without_tests_is_not_proven(self):
        report = {"run": {**REPORT["run"], "lines": [{"kind": "result", "text": "Done"}]}}
        self.assertIn("Not proven: no tests were run", oc.review_text(report))


class PlannerTest(unittest.TestCase):
    def test_without_a_model_each_line_becomes_a_story(self):
        plan, modeled = oc.draft_plan("Search box; Enter submits; no-results message")
        self.assertFalse(modeled)
        self.assertEqual([s["summary"] for s in plan["stories"]], ["Search box", "Enter submits", "no-results message"])

    def test_a_model_plan_is_cleaned(self):
        raw = {"epic": {"summary": "Search"}, "stories": [{"summary": "Box", "acceptance_criteria": ["Visible", ""]}, {"summary": ""}]}
        plan, modeled = oc.draft_plan("Search", lambda s, u: raw)
        self.assertTrue(modeled)
        self.assertEqual(plan["stories"], [{"summary": "Box", "description": "", "acceptance_criteria": ["Visible"]}])

    def test_jira_creates_the_epic_then_stories_under_it(self):
        made = []

        def fake(method, url, headers, body):
            fields = json.loads(body)["fields"]
            made.append((fields["issuetype"]["name"], fields["summary"], fields.get("parent")))
            return 201, json.dumps({"key": f"OC-{len(made)}"}).encode()

        jira = oc.Jira("team.atlassian.net", "a@b.c", "tok", "OC", fetch=fake)
        issues = jira.create_plan(oc.fallback_plan("Search box; Enter submits"))
        self.assertEqual(made[0], ("Epic", "Search box", None))
        self.assertEqual(made[1], ("Story", "Search box", {"key": "OC-1"}))
        self.assertEqual(issues, [{"key": "OC-2", "summary": "Search box"}, {"key": "OC-3", "summary": "Enter submits"}])

    def test_jira_only_reads_issues_in_its_project(self):
        with self.assertRaisesRegex(oc.CloudError, "isn't in Jira project OC"):
            oc.Jira("team.atlassian.net", "a@b.c", "tok", "OC", fetch=lambda *a: (200, b"{}")).issue("OTHER-1")


class WatcherTest(unittest.TestCase):
    def test_the_first_look_is_quiet_then_changes_are_reported(self):
        snapshot, changes = oc.run_changes(None, [PROJECT])
        self.assertEqual(changes, [])
        started = {**PROJECT, "runs": [{"id": "r3", "prompt": "Add rate limits", "status": "running", "detail": None, "by": "Ava"}] + PROJECT["runs"]}
        snapshot, changes = oc.run_changes(snapshot, [started])
        self.assertEqual(changes, [("p1", "**Notes API**: Ava started an agent: Add rate limits")])
        finished = {**PROJECT, "runs": [{"id": "r3", "prompt": "Add rate limits", "status": "done", "detail": "Added.", "by": "Ava"}] + PROJECT["runs"]}
        _, changes = oc.run_changes(snapshot, [finished])
        self.assertEqual(changes, [("p1", "**Notes API**: an agent finished: Add rate limits\nAdded.")])

    def test_a_run_that_started_and_failed_between_looks_is_reported(self):
        snapshot, _ = oc.run_changes(None, [{**PROJECT, "runs": []}])
        _, changes = oc.run_changes(snapshot, [{**PROJECT, "runs": [{"id": "r4", "prompt": "x", "status": "error", "detail": "boom", "by": "Ava"}]}])
        self.assertEqual(changes, [("p1", "**Notes API**: an agent failed: x\nboom")])


if __name__ == "__main__":
    unittest.main()
