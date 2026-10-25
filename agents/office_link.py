"""How an ASI:One agent appears inside the Iteration1 app: it checks in with the local office, reports what it
did, and takes work the page queues for it. Uses the same loopback session as every other office client."""
from __future__ import annotations

from typing import Callable

from office_core import OfficeClient, OfficeError

HEARTBEAT_SECONDS = 4.0


class OfficeLink:
    def __init__(self, office: OfficeClient, name: str, address: str, details: Callable[[], dict] = dict, log: Callable[[str], None] = print):
        self.office, self.name, self.address, self.details, self.log = office, name, address, details, log
        self.reachable = True

    def beat(self) -> list[dict]:
        """Check in; returns jobs to run now. Quiet while the office is down, so a stopped office isn't noisy."""
        try:
            jobs = self.office.request("/fetch/heartbeat", {"name": self.name, "address": self.address, "details": self.details()}).get("jobs", [])
            if not self.reachable:
                self.log("Back in touch with the office app.")
            self.reachable = True
            return jobs
        except OfficeError as e:
            if self.reachable:
                self.log(f"Can't check in with the office app ({e}). Will keep trying.")
            self.reachable = False
            return []

    def report(self, kind: str, text: str, room_id: str = "", task_id: str = "") -> None:
        body = {"name": self.name, "kind": kind, "text": text[:6000]}
        if room_id:
            body["roomId"] = room_id
        if task_id:
            body["taskId"] = task_id
        try:
            self.office.request("/fetch/activity", body)
        except OfficeError:
            pass

    def finish(self, job_id: str, ok: bool, result: dict) -> None:
        try:
            self.office.request(f"/fetch/jobs/{job_id}", {"name": self.name, "status": "done" if ok else "failed", "result": result})
        except OfficeError as e:
            self.log(f"Couldn't report job {job_id}: {e}")
