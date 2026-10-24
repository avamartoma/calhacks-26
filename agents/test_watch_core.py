"""Run with: python -m unittest discover agents"""
import copy
import os
import tempfile
import unittest

from office_core import Gate, OfficeAgent, OfficeClient
from watch_core import Repeats, changes, parse_sse


def snapshot(project):
    return {"rooms": [{"id": "r1", "name": "Office", "path": project, "demo": False, "goal": "Ship search", "paused": False,
                       "workItems": [{"id": "w1", "title": "Search", "status": "working", "createdAt": 1},
                                     {"id": "w2", "title": "Docs", "status": "blocked", "blocker": "No access", "createdAt": 2}]},
                      {"id": "demo", "name": "Demo", "path": project, "demo": True, "workItems": []}],
            "approvals": []}


class WatchTest(unittest.TestCase):
    def setUp(self):
        self.project = tempfile.mkdtemp()
        self.before = snapshot(self.project)
        self.after = copy.deepcopy(self.before)

    def task(self, task_id):
        return next(t for t in self.after["rooms"][0]["workItems"] if t["id"] == task_id)

    def test_first_snapshot_is_a_baseline(self):
        self.assertEqual(changes(None, self.after, self.project), [])
        self.assertEqual(changes(self.before, self.after, self.project), [])

    def test_transitions_become_plain_lines(self):
        self.task("w1").update(status="blocked", blocker="Tests fail")
        self.task("w2").update(status="working", blocker="")
        self.after["approvals"] = [{"id": "p1", "roomId": "r1", "command": "npm install"}, {"id": "p2", "roomId": "other", "command": "rm"}]
        self.after["rooms"][0].update(paused=True, goal="Ship search v2")
        self.assertEqual(changes(self.before, self.after, self.project), [
            "Office paused.", "New mission: Ship search v2", "Blocked: Search (Tests fail)", "Unblocked: Docs",
            "Approval needed in the office app: npm install"])

    def test_done_reports_verification(self):
        self.task("w1")["status"] = "review"
        self.task("w2")["status"] = "done"
        seen = []
        lines = changes(self.before, self.after, self.project, lambda room, task: seen.append((room, task)) or "not verified: 1 gap(s)")
        self.assertEqual(lines, ["Ready for review: Search", "Done: Docs (not verified: 1 gap(s))"])
        self.assertEqual(seen, [("r1", "w2")])

    def test_other_projects_demo_rooms_and_archived_tasks_are_ignored(self):
        self.after["rooms"][1]["workItems"] = [{"id": "d", "title": "Demo", "status": "blocked"}]
        self.task("w1").update(status="blocked", archived=True)
        self.assertEqual(changes(self.before, self.after, self.project), [])
        self.assertEqual(changes(self.before, self.after, os.path.dirname(self.project)), [])

    def test_sse_frames(self):
        frames = [b'data: {"a": 1}\n', b"\n", b": ping\n", b"\n", b'data: {"a":\n', b"data: 2}\n", b"\n", b"data: nope\n", b"\n"]
        self.assertEqual(list(parse_sse(frames)), [{"a": 1}, {"a": 2}])

    def test_repeats_are_dropped_for_a_minute(self):
        now = [0.0]
        repeats = Repeats(clock=lambda: now[0])
        self.assertEqual(repeats.fresh(["Blocked: Search", "Blocked: Search"]), ["Blocked: Search"])
        now[0] = 30
        self.assertEqual(repeats.fresh(["Blocked: Search"]), [])
        now[0] = 91
        self.assertEqual(repeats.fresh(["Blocked: Search"]), ["Blocked: Search"])

    def test_office_agent_keeps_recent_alerts_for_owners(self):
        gate = Gate()
        agent = OfficeAgent(OfficeClient(project=self.project, fetch=lambda *a: (500, {}, b"")), gate)
        agent.handle("me", f"pair {gate.code}")
        self.assertIn("No alerts yet", agent.handle("me", "what did I miss?"))
        agent.remember([f"Blocked: task {i}" for i in range(25)])
        text = agent.handle("me", "alerts")
        self.assertIn("Blocked: task 24 (just now)", text)
        self.assertNotIn("task 14 ", text)
        self.assertEqual(len(agent.inbox), 20)
        self.assertIn("private", agent.handle("stranger", "alerts"))


if __name__ == "__main__":
    unittest.main()
