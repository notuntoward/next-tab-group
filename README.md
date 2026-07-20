# Next Tab Group

[![Build](https://github.com/notuntoward/next-tab-group/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/next-tab-group/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/next-tab-group/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/next-tab-group/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/next-tab-group/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/next-tab-group/actions/workflows/scorecard.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/notuntoward/next-tab-group/badge)](https://securityscorecards.dev/viewer/?uri=github.com/notuntoward/next-tab-group)

This plugin provides commands for efficient tab group navigation, tab/tab-group/window switching, workspace layout manipulation, and tab deduplication in Obsidian, inspired by Emacs window commands. It is fully aware of Obsidian's multi-window setup (the main window and any pop-out windows) and handles them as separate scopes throughout.

# Commands

## Next tab group

**Command ID:** `next`

Cycles your cursor between “tab groups”: whole windows with individual tabs inside. The cycling is similar to the Emacs `other-window` command:

1. Top to bottom  
2. Left to right (within each row)

**Two tab groups side-by-side**:
```
┌───────────┬───────────┐
│  Group 1  │  Group 2  │
└───────────┴───────────┘
```

Pressing the "Next tab group" command: Group 1 -> Group 2 -> Group 1 -> ...

**Four tab groups in a 2×2 grid**:
```
┌──────────┬──────────┐
│  Top L   │  Top R   │
├──────────┼──────────┤
│  Bot L   │  Bot R   │
└──────────┴──────────┘
```

Order: Top L -> Top R -> Bot L -> Bot R -> Top L -> ...

The command remembers which tab was active in each group, so switching between groups restores your previous position.

## Collect Tabs

**Command ID:** `collect-tabs`

Gathers **all tabs from all other tab groups** into the currently active tab group, then closes all the now-empty tab groups. This is similar to the Emacs `delete-other-windows` command.

**Before**:
```
┌─────────┬─────────────┬───────────┐
│ A.md    │ X.md        │ W.md      │
│ B.md    │ Y.md        │           │
└─────────┴─────────────┴───────────┘
```

**After**:
```
┌─────────────────────────────────────┐
│ A.md  B.md  X.md  Y.md  W.md        │
└─────────────────────────────────────┘
```

All files remain open; the layout is simplified into a single focused group. Your cursor stays on the tab you started with.

## Rotate Tab Groups

**Command ID:** `rotate-tab-groups`

Performs a recursive **90° Clockwise Rotation** of the entire workspace layout. This behavior is *inspired by* Emacs’s `rotate-frame-clockwise` (from the `transpose-frame` package).

**Side-by-side panes become stacked** (with the right pane moving to the bottom).
```text
    Before (Side-by-Side)             After (Stacked)
┌─────────────┬─────────────┐      ┌─────────────┐
│             │             │      │      B      │
│      A      │      B      │  ->  ├─────────────┤
│             │             │      │      A      │
└─────────────┴─────────────┘      └─────────────┘
```

<div style="display: flex; justify-content: center; gap: 1rem;">
  <figure style="margin: 0; text-align: center;">
    <img src="images/Greenlandic_Ocean.png" width="100%" />
    <figcaption>Greenlandic Ocean</figcaption>
  </figure>
</div>

<br>



**More complex screen before:**
```text
┌─────────────┬─────────────┐
│             │      B      │
│      A      │             │
│             ├─────────────┤
│             │      C      │
└─────────────┴─────────────┘
```

**More complex screen After:**
```text
┌─────────────┬─────────────┐
│      B      │      C      │
│             │             │
├─────────────┴─────────────┤
│                           │
│             A             │
│                           │
└───────────────────────────┘
```

## Deduplicate Tabs in Group

**Command ID:** `dedupe-tabs-in-group`

Removes duplicate tabs in the **current tab group** that point to the same file. For each duplicated file, the tab that survives is chosen in this order:

1. The currently active tab (if it points to that file).
2. The most recently visited tab in the current tab group (if recency is available).
3. A stable fallback by leaf id.

This command runs without confirmation by default. Enable confirmation in **Settings → Next Tab Group → Confirm before deduplicating in group** to show a dialog listing the tabs to be closed before running it.

## Deduplicate Tabs in All Groups

**Command ID:** `dedupe-tabs-in-all-groups`

Scans **every tab group in the current window** and removes duplicate tabs that point to the same file, leaving at most one tab per note across the window. For each duplicated file, the surviving tab is chosen in this order:

1. The currently active tab.
2. The most recently visited tab in the current tab group.
3. The most recently visited tab in any other group in the current window.
4. A stable fallback by leaf id.

This command shows a confirmation dialog by default, listing every tab it will close (grouped by note, with counts per tab group). Disable the confirmation in **Settings → Next Tab Group → Confirm before deduplicating in all groups**.

## Deduplicate Tabs in All Windows

**Command ID:** `dedupe-tabs-in-all-windows`

Scans **every tab in every window** (the main window and any pop-out windows) and removes duplicate tabs that point to the same file, leaving at most one tab per note across the entire workspace. The surviving tab is chosen in this order:

1. The currently active tab.
2. The most recently visited tab in the active tab group.
3. The most recently visited tab in any other group in the active window.
4. The most recently visited tab in any other window.
5. A stable fallback by leaf id.

This command shows a confirmation dialog by default, listing every tab it will close (grouped by note, with counts per tab group). Disable the confirmation in **Settings → Next Tab Group → Confirm before deduplicating in all windows**.

## Switch to Tab in Group

**Command ID:** `switch-to-tab-in-group`

Opens a fuzzy-completion prompt listing **every tab in the active tab group**. Pick a tab to make it the active (focused) tab. This is handy for quickly jumping between tabs in the current group without reaching for the mouse.

## Switch to Any Tab

**Command ID:** `switch-to-any-tab`

Opens a fuzzy-completion prompt listing **every editor tab across all windows**, newest contexts first. Pick a tab to focus it — the plugin also brings its native window (main or pop-out) to the foreground. Press Enter without typing to jump straight to the most recently used tab that isn't already active.

By default results are clustered by window and then tab group (freshest first). Disable **Settings → Next Tab Group → Group results by tab group and window** to list every tab in a single pure recency order instead.

## Switch to Tab Group

**Command ID:** `switch-to-tab-group`

Opens a fuzzy-completion prompt listing **every tab group across all windows**. Pick a group to focus its most recently active tab (or the tab you last had open there). The active group is marked "Current group"; other groups in the same window get relative labels like "group below" or "right group". Press Enter without typing to jump straight to the next-most-recent group.

Like "Switch to any tab", the listing respects the **Group results by tab group and window** setting.

## Switch to Window

**Command ID:** `switch-to-window`

Opens a fuzzy-completion prompt listing **every Obsidian window** (the main window and each pop-out), ordered by recency of its most recently used tab. Pick a window to focus it and activate its most recent tab. This is the fastest way to move between the main window and pop-out windows.

### What counts as a "duplicate"?

Two tabs count as duplicates when they point to the same file in your vault. Tabs that aren't backed by a file (e.g. the graph view, settings, the daily note calendar) are ignored and never considered duplicates.

### What if a tab's recency is unknown?

The plugin tracks recency by listening for `active-leaf-change` events. After a vault restart, plugin reload, or the first time you run a dedupe command, recency may be unavailable for some tabs. In that case, a stable tie-break by leaf id is used so the result is deterministic.
# Page Color Prop / Supercharged Links Compatibility

The "Switch to…" modals (Switch to any tab, Switch to tab group, Switch to tab in group, Switch to window) respect note colors applied by **Page Color Prop** and link styles from **Supercharged Links**. Every file-backed suggestion row exposes the standard data attributes (`data-path`, `data-href`, `data-link-path`, `data-link-data-href`) along with the `suggestion-title` / `data-link-text` markers those plugins target, so your existing color rules and link themes carry through automatically.

No configuration is required — if Page Color Prop or Supercharged Links is enabled, the modal rows match the rest of your vault.

# Settings

The plugin adds a **Settings → Next Tab Group** tab with the following options:

## Deduplicate tabs

- **Confirm before deduplicating in group** — Show a confirmation dialog listing the tabs to be removed when running "Deduplicate tabs in group". Off by default; enable to prompt before closing tabs in the current group.
- **Confirm before deduplicating in all groups** — Show a confirmation dialog when running "Deduplicate tabs in all groups". On by default; disable to run without prompting.
- **Confirm before deduplicating in all windows** — Show a confirmation dialog when running "Deduplicate tabs in all windows". On by default; disable to run without prompting.

Each confirmation dialog lists every tab to be closed, grouped by note with counts per tab group and per window, before anything is removed.

## Switch tabs

- **Group results by tab group and window** — When on (default), the "Switch to any tab" and "Switch to tab group" modals cluster results by window and then tab group, with the freshest contexts first. When off, every result is listed in a single pure recency order, newest at the top.

# Setting Hotkeys

1. Go to **Settings -> Hotkeys** in Obsidian.
2. Search for:
   - `Next tab group`
   - `Collect tabs`
   - `Rotate tab groups`
   - `Deduplicate tabs in group`
   - `Deduplicate tabs in all groups`
   - `Deduplicate tabs in all windows`
   - `Switch to tab in group`
   - `Switch to any tab`
   - `Switch to tab group`
   - `Switch to window`
3. Assign your preferred shortcuts (e.g., `Cmd+K` sequences or Function keys).

# Running Tests

```bash
npm test
npm run test:typecheck
```

Tests live in `tests/` and use Vitest with jsdom. They cover single-group, multi-group, and multi-window deduplication scenarios, survivor selection, confirmation modal behavior, and non-file tab handling.
