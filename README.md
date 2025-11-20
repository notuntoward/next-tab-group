# Next Tab Group

This plugin provides commands for efficient tab group navigation and workspace manipulation in Obsidian — inspired by Emacs window commands.

# Commands

## Next Tab Group

**Command ID:** `next-tab-group`

Cycles your cursor between “tab groups”: whole windows with individual tabs inside. The cycling is similar to the Emacs `other-window` command:

1. Top to bottom  
2. Left to right (within each row)

**Two tab groups side-by-side**:
```
┌───────────┬───────────┐
│  Group 1  │  Group 2  │
└───────────┴───────────┘
```

Pressing “Next Tab Group”: Group 1 → Group 2 → Group 1 → …

**Four tab groups in a 2×2 grid**:
```
┌──────────┬──────────┐
│  Top L   │  Top R   │
├──────────┼──────────┤
│  Bot L   │  Bot R   │
└──────────┴──────────┘
```

Order: Top L → Top R → Bot L → Bot R → Top L → …

The command remembers which tab was active in each group, so switching between groups restores your previous position.

## Collect Tabs

**Command ID:** `collect-tabs`

Gathers **all tabs from all other tab groups** into the currently active tab group, then closes all the now-empty tab groups. This is similar to the Emacs `delete-other-windows`

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

All files remain open; the layout is simplified into a single focused group.  Your cursor stays on the tab you started with

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

# Setting Hotkeys

1. Go to **Settings → Hotkeys** in Obsidian.  
2. Search for:
   - `Next tab group`
   - `Collect tabs`
   - `Rotate tab groups`
3. Assign your preferred shortcuts (e.g., `Cmd+K` sequences or Function keys).
