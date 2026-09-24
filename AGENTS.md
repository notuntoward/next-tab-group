# AGENTS.md — next-tab-group

This Obsidian plugin manages tab groups, multi-window navigation, and tab
collection by directly manipulating Obsidian's live `WorkspaceLeaf` /
`WorkspaceParent` / `Window` object graph. That graph is also what Obsidian
serializes to `workspace.json` on save, and what gets deserialized back into
windows and tab groups on the next launch.

**This repo has a documented history of AI-introduced regressions in exactly
this area** — the same class of bug ("collect-tabs corrupts the split tree",
"a popout window gets force-closed while something is still using it",
"a keyboard shortcut fires more than once and cancels itself out") has
recurred multiple times under different guises. Before editing
`main.ts`'s window/leaf lifecycle code or `src/ui/collect-tabs-modal.ts`'s
keyboard handling, read this file, then read
`tests/architecture-guardrails.test.ts`, which encodes the specific
invariants below as automated checks with the historical incident each one
prevents.

## Hazard zones

- `main.ts`: `collectTabs`, `closePopoutWindowIfEmpty`, `rotateTabGroups`,
  and anything else that creates, detaches, or closes leaves/windows.
- `src/ui/collect-tabs-modal.ts`: the keyboard/focus/checkbox state machine
  (Space, arrows, Tab-trap, Clear selection, highlight vs. checked state).

Before making further changes to either area, run:

```
git log -p -10 -- main.ts
```

and read the commit messages. Several past fix commits describe the actual
failure mode in detail (split-tree corruption, double-close races, event
thrashing storms) — that context is more useful than re-deriving the same
lesson from scratch.

## Hard rules for the workspace/leaf lifecycle

1. **Never call `.detach()` on anything but an individual `WorkspaceLeaf`.**
   Never manually detach or otherwise mutate a `WorkspaceParent`/split
   container. Obsidian prunes empty containers itself once their leaves are
   gone; a manual `parent.detach()` corrupts Obsidian's internal split tree
   (this shipped for ~2 hours in commit `0fff05f` and was reverted in
   `97bfc70` once it was found to cause exactly this).

2. **Never call Obsidian's destructive whole-layout APIs** (`getLayout`,
   `setLayout`), `requestSaveLayout`, or touch `workspace.json` /
   `vault.adapter` directly for layout purposes. This plugin only
   manipulates live in-memory leaf/parent objects; Obsidian alone owns
   persistence. (An earlier "live-object topology graph" was added
   specifically to get away from the destructive layout APIs — see commit
   `e258296` — before later being found to be entirely unnecessary and
   removed as dead code in `862b2b8`.)

3. **Before closing/force-closing any window**, verify both:
   - it has no `WorkspaceLeaf` left in it, AND
   - it has no open `Modal` in it — check for a `.modal-container` element
     in that window's `document`. `Modal.open()` attaches to whichever
     window was *active* when it was opened, not necessarily the main
     window, so Settings (including the Community plugins tab) can be open
     in a popout that otherwise looks "empty." Force-closing that window
     tears its document down mid-render and leaves a blank, unresponsive
     window behind.

4. **Always guard against a window already being closed** (`win.closed`)
   before calling `.close()` on it again. A "double-closing race condition"
   in `closePopoutWindowIfEmpty` was a real, shipped bug (fixed in
   `97bfc70`).

## Hard rules for modal keyboard/focus handling

5. **Exactly one registration path per keyboard shortcut.** Either
   Obsidian's `Scope` API or a single DOM listener on a single element —
   never both, and never on more than one DOM element. Space was once
   registered in three overlapping places (`scope.register([], ' ')`,
   `scope.register([], 'Space')`, and an `inputEl` DOM listener) in addition
   to the modal's own capture listener; every physical keypress ran the
   handler multiple times, netting out to a check-then-uncheck no-op that
   looked to the user like the key "did nothing." This is a much harder bug
   to notice by inspection or casual testing than an outright crash, because
   the net *visible* effect can be zero.

6. **Do not trust Obsidian's private/internal object fields** (e.g.
   `chooser.selectedItem`) as the sole source of truth for this plugin's own
   tracked UI state. Obsidian can mutate them independently (e.g. during its
   own internal re-render), desyncing them from what your code set up
   moments earlier. Keep exactly one explicitly-owned field
   (`this.highlightedIndex`) as ground truth, and only read Obsidian's
   internals defensively through your own override hooks — never as the
   authoritative value for a decision.

7. **One state, one field.** When two UI elements are meant to represent the
   same underlying fact (e.g. a checkbox and a full-row highlight both
   meaning "this is what gets collected by default"), derive both from the
   same field. Two independently-mutable flags claiming to represent the
   same thing will drift, and the resulting inconsistency reads to a user as
   "the checkbox is lying about what will happen."

8. **jsdom does not replicate real-browser focus/blur side effects that this
   plugin's tests need to reason about.** Concretely: `element.click()` does
   not auto-focus the element in jsdom (real Chromium does), and hiding the
   currently-focused element (`display: none`) does not auto-blur it in
   jsdom (real Chromium blurs it immediately, moving focus to `<body>`).
   Code that reads `document.activeElement` to decide what to do next can
   pass every jsdom test while behaving differently in real Obsidian. When
   writing a regression test for focus-dependent behavior, explicitly
   simulate the real-browser precondition (e.g. `document.body.focus()`
   before the action under test) rather than relying on jsdom's actual,
   non-standard behavior — see the "Clear selection" focus test in
   `tests/collect-tabs-multi-window.test.ts` for the pattern. Where
   possible, avoid depending on `document.activeElement` for control flow at
   all, since it makes this whole class of test-vs-reality mismatch
   possible in the first place.

## Before considering a change to these areas complete

- Run `npm run build` (lint + full test suite + typecheck + esbuild) and
  confirm it passes.
- If the change touches leaf/window creation, detachment, or closing, add or
  update a test in `tests/architecture-guardrails.test.ts` and
  `tests/collect-tabs-multi-window.test.ts` that would fail without the
  change. Prove it fails on the old code before your fix, and passes after,
  the same way the existing tests in that file are documented to.
- Extend `tests/architecture-guardrails.test.ts` (rather than working around
  it) whenever you discover a new footgun class in this codebase — its whole
  purpose is to accumulate the hazards this repo has actually hit, not just
  the ones present when it was written.
