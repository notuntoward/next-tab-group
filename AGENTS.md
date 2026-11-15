# AGENTS.md — next-tab-group

## Task scope and validation

Cache exact instructions per checkout/task; read guides only for changed areas.
Restore only missing/changed sections after compaction.
- Docs/instructions-only: text/link/format checks, not application tests/builds,
  browsers, installs or consumer sweeps. This qualifies completion gates below.
- Publication-only: reuse green checks/artifacts for unchanged code, dependencies,
  build inputs AND linked commons; validate unchecked pending source once.
- Source changes: targeted iteration tests, required final checks once; reuse
  composite steps and verify their bundle rather than rebundling.
Keep fresh Git branch/identity/message/hook checks and final remote-tip verification.

## Shared library: commons

Use commons for workspace/window/tab/focus, per-window timers/clipboard, modal,
search, geometry, page-color and line-flash helpers; never duplicate its
undocumented Obsidian adapters in plugin code. For an owned-area change, consult
the installed module exports and relevant commons guide sections. Change commons
with a regression test if needed, never a local copy. Docs/publication-only work
does not require opening the library or rebuilding its consumers.
Local adoption uses file:../obsidian-commons; obey the library's existing
commons-adoption branch and explicit-ref/tag-disabled publication rules.


## Workspace and picker safety

Before changing lifecycle or picker keyboard/focus behavior, read the relevant
sections of [the regression guide](docs/AGENT-REGRESSIONS.md) and the cited
architecture/collection tests. Detailed behavior rules remain intact; history
lookup is conditional and bounded rather than ten full patches per change.
Only detach leaves; never mutate container/layout persistence. Close only
already-open, modal-free windows with no leaves. Keep captured destination
snapshots, include destination tabs in multi-collection, use the canonical commons
model/recency, one shortcut registration and one owned UI state. Checked, cursor
and hover states are distinct; only checked rows are collected. Preserve native
modal opening, real-browser focus preconditions and searchable recognizable titles.
The production build includes lint, full units, types and bundle; do not repeat them.
