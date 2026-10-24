export const illustrativeDiff = `Illustrative React patch — scripted demo fixture
--- a/src/Search.tsx
+++ b/src/Search.tsx
@@ ProjectSearch
- const matches = projects.filter(p => p.name.includes(query));
+ const term = query.trim().toLocaleLowerCase();
+ const matches = projects.filter(p =>
+   (p.name + ' ' + p.detail).toLocaleLowerCase().includes(term));
+ <p role="status">{matches.length} projects found</p>
+ {matches.length === 0 && <button onClick={() => {
+   setQuery(''); searchInput.current?.focus();
+ }}>Clear search</button>}`;
export const passingTranscript = `Scripted test transcript (not a live agent run)
PASS empty query returns all projects
PASS case-insensitive query matches project name
PASS query matches project description
PASS unmatched query returns an empty result
Manual sample check: Clear search restores results and focuses the input.
Summary: 4 named search checks pass; keyboard recovery inspected.`;
export const failingTranscript = `Scripted test transcript (not a live agent run)
FAIL case-insensitive query matches project name
Query: "CUSTOMER"; expected 1 match; received 0.
Next: normalize both query and searchable text; rerun regression checks.
Exit: 1`;
