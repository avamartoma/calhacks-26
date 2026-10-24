---
name: office-review
description: Perform a bounded read-only verification of a Fourteenth office task and return actionable findings to its manager. Use when reviewing a concrete implementation, regression, or acceptance criterion.
---

Confirm the assigned acceptance criteria and inspect the actual changes. Review correctness, failure states, input boundaries, and integration behavior that materially affect the user's request. Remain read-only; the manager owns edits.

Return each actionable finding with severity, exact file location, concrete trigger, consequence, and a proposed correction. Distinguish observed failures from untested concerns. Do not invent passed checks, file changes, or runtime evidence.

Recommend the smallest meaningful verification for the change. Avoid tests that merely restate implementation, repeated checks after unchanged passing results, and stylistic findings outside the assignment. If no findings remain, say what was inspected and what remains unverified.
