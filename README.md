# Next Tab Group

This plugin provides commands for efficient tab group navigation and management in Obsidian, similar to Emacs window commands.

## Commands

### Next Tab Group

**Command ID:** `next-tab-group`

Cycles your cursor between "tab groups": whole windows with individual tabs inside. This is similar to the Emacs `other-window` command.

**How it works:** Pressing this command focuses the next tab group in spatial order (top to bottom, left to right), cycling back to the first when reaching the last.

#### Examples

Two tab groups side-by-side:
```
┌───────────┬───────────┐
│  Group 1  │  Group 2  │
└───────────┴───────────┘
```
Pressing "Next Tab Group": Group 1 → Group 2 → Group 1 → ...

Four tab groups in a 2×2 grid:
```
┌──────────┬──────────┐
│  Top L   │  Top R   │
├──────────┼──────────┤
│  Bot L   │  Bot R   │
└──────────┴──────────┘
```
Order: Top L → Top R → Bot L → Bot R → Top L → ...

The command remembers which tab was active in each group, so switching between groups restores your previous position.

### Collect Tabs

**Command ID:** `collect-tabs`

Gathers all tabs from all other tab groups into the currently active tab group, then closes all the now-empty tab groups. This is similar to the Emacs `delete-other-windows` (C-x 1) command.

**How it works:**
1. All tabs from non-active tab groups are copied to the active tab group
2. The tabs from each non-active group remain grouped together (in spatial order) 
3. The original tabs are then closed from their source groups
4. Empty tab groups automatically disappear from the workspace

**Use cases:**
- Quickly consolidate a fragmented workspace with many splits
- Combine related tabs scattered across multiple groups
- Collapse complex layouts into a single focused view
- Preserve all your open files while simplifying the layout

**Important:** The tab that was active in the active tab group when you run this command will remain active and focused after the operation completes.

## Obsidian Built-ins

Obsidian already comes with directional navigation commands for tab groups:

- Focus on tab group above: `editor:focus-top`
- Focus on tab group below: `editor:focus-bottom`
- Focus on tab group to the left: `editor:focus-left`
- Focus on tab group to the right: `editor:focus-right`

The "Next Tab Group" command provides a simpler alternative that only requires one hotkey instead of remembering directional keys.

## Setting Hotkeys

1. Go to Settings → Hotkeys
2. Search for "Next tab group" or "Collect tabs"
3. Assign your preferred hotkeys
