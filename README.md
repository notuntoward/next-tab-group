# Next Tab Group

This plugin provides commands for efficient tab group navigation and workspace manipulation in Obsidian — inspired by Emacs window commands.

---

## Commands

---

## Next Tab Group

**Command ID:** `next-tab-group`

Cycles your cursor between “tab groups”: whole windows with individual tabs inside. This is similar to the Emacs `other-window` command.fileciteturn1file0

The cycling is based on **spatial order**:

1. Top to bottom  
2. Left to right (within each row)

The plugin also remembers which tab was active in each group.

### Examples

Two tab groups side-by-side:

```
┌───────────┬───────────┐
│  Group 1  │  Group 2  │
└───────────┴───────────┘
```

Pressing “Next Tab Group”: Group 1 → Group 2 → Group 1 → …

Four tab groups in a 2×2 grid:

```
┌──────────┬──────────┐
│  Top L   │  Top R   │
├──────────┼──────────┤
│  Bot L   │  Bot R   │
└──────────┴──────────┘
```

Order: Top L → Top R → Bot L → Bot R → Top L → …

The command remembers which tab was active in each group, so switching between groups restores your previous position.

---

## Collect Tabs

**Command ID:** `collect-tabs`

Gathers **all tabs from all other tab groups** into the currently active tab group, then closes all the now-empty tab groups. This is similar to the Emacs `delete-other-windows` (`C-x 1`) command.fileciteturn1file0

### How it works

1. All tabs from non-active tab groups are copied to the active tab group.  
2. The tabs from each non-active group remain grouped together (in spatial order).  
3. The original tabs are then closed from their source groups.  
4. Empty tab groups automatically disappear from the workspace.  

### Use cases

- Quickly consolidate a fragmented workspace with many splits.  
- Combine related tabs scattered across multiple groups.  
- Collapse complex layouts into a single focused view.  
- Preserve all your open files while simplifying the layout.  

**Important:** The tab that was active in the active tab group when you run this command will remain active and focused after the operation completes.

### Example

Before:

```
┌─────────┬─────────────┬───────────┐
│ A.md    │ X.md        │ W.md      │
│ B.md    │ Y.md        │           │
└─────────┴─────────────┴───────────┘
```

After running “Collect Tabs” while in the middle column:

```
┌─────────────────────────────────────┐
│ A.md  B.md  X.md  Y.md  W.md        │
└─────────────────────────────────────┘
```

All files remain open; the layout is simplified into a single focused group.

---

## Rotate Tab Groups

**Command ID:** `rotate-tab-groups`

Toggles the **orientation** of the main editor layout — switching side-by-side tab groups into stacked ones, and stacked groups into side-by-side.

This behavior is *inspired by* Emacs’s `rotate-frame-clockwise` (from the `transpose-frame` package), but it is **not a full 90° matrix rotation** of the entire window grid. Instead, it performs a safe orientation toggle of Obsidian’s split layout using the public layout JSON API.

### What it does

- Reads the current workspace layout with `app.workspace.getLayout()`.  
- Locates split nodes that contain “editor-like” views (Markdown, Canvas, images, PDFs, etc.).  
- For each such split, toggles the `direction` field:
  - `horizontal` → `vertical`  
  - `vertical` → `horizontal`  
- Applies the updated layout using `app.workspace.changeLayout(newLayout)`.  

Only the **direction** of eligible splits is changed; child order is preserved and sidebars are left alone.

---

## Simple Layout Example

### Before rotation

Side-by-side layout:

```
┌───────────┬───────────┐
│   Left    │   Right   │
└───────────┴───────────┘
```

### After rotation

Stacked layout:

```
┌───────────┐
│   Left    │
├───────────┤
│   Right   │
└───────────┘
```

Running the command again flips the orientation back to the original side-by-side layout.

---

## More Complex Layouts

When there are nested splits, the plugin toggles the **direction** of each eligible split independently. No tabs move across quadrants; only the axis of each split changes, and pane order is preserved.

Consider this three-pane layout:

### Before rotation

```
┌───────────┬───────────┐
│     A     │     B     │
│           │           │
│           ├───────────┤
│           │     C     │
└───────────┴───────────┘
```

Interpretation:

- The **outer** container is a **horizontal** split: A on the left, a right-hand stack on the right.  
- The **right** container is a **vertical** split: B above C.

Now run **Rotate Tab Groups**:

- Outer split: `horizontal → vertical`.  
- Inner right split: `vertical → horizontal`.

### After rotation

```
┌───────────┐
│     A     │
├───────────┬───────────┐
│     B     │     C     │
└───────────┴───────────┘
```

Observations:

- A now occupies the top row, full width.  
- B and C form a horizontal split in the row beneath A.  
- B and C are the **same height** and share the lower half of the screen.  
- There are still exactly **three** pane groups.  
- Order is preserved: A still “comes before” the B/C row, and B still comes before C.

### Rotating again

Running **Rotate Tab Groups** a second time flips both splits back:

- Outer split: `vertical → horizontal`.  
- Inner split: `horizontal → vertical`.  

Restoring the original layout:

```
┌───────────┬───────────┐
│     A     │     B     │
│           │           │
│           ├───────────┤
│           │     C     │
└───────────┴───────────┘
```

So for any arrangement built of nested splits, **two rotations always return you to the original structure**. Only the orientation of splits changes; no panes are reordered.

---

## Why This Behavior (Technical API Constraints)

Obsidian’s plugin API does **not** officially support manipulating live `WorkspaceSplit` or `WorkspaceTabs` objects. Doing so can cause blank screens, inconsistent UI state, or layouts that cannot be restored cleanly.

The rotation feature is therefore implemented entirely via the **layout JSON**:

1. **Read** the current layout:  
   `const layout = app.workspace.getLayout();`

2. **Transform** the JSON structure:  
   - Walk the tree.  
   - Identify `split` nodes whose subtrees contain editor-like views.  
   - Toggle their `direction` (`horizontal` ↔ `vertical`).  
   - Leave sidebars and non-editor-only areas untouched.  
   - Do **not** reorder child arrays.

3. **Apply** the updated layout:  
   `await app.workspace.changeLayout(layout);`

### Key constraints

- Only `horizontal` / `vertical` split directions are exposed; pane sizes are relative and not directly accessible as pixels.  
- Sidebar panes (File Explorer, Search, etc.) should not be modified, so the plugin uses heuristics to limit changes to editor areas.  
- `changeLayout` expects a structurally valid layout with the same leaves; arbitrary mutations can break things, so this implementation is intentionally conservative.

Because of these constraints, the command is a **safe orientation toggle**, not a full geometric rotation like in Emacs.

---

## Comparison with Emacs `rotate-frame-clockwise`

| Feature / Behavior                          | Emacs (`rotate-frame-clockwise`) | This Plugin (`rotate-tab-groups`) |
|---------------------------------------------|----------------------------------|-----------------------------------|
| Full 90° rotation of window grid            | ✔ Yes                            | ✘ No                              |
| Moves panes across quadrants                | ✔ Yes                            | ✘ No (order preserved)           |
| Flips local split orientation               | ✘ Not the main goal              | ✔ Yes                             |
| Uses internal/frame APIs                    | ✔ (Emacs internals)              | ✘ (uses Obsidian layout JSON)    |
| Safe within Obsidian’s public API           | N/A                              | ✔ Yes                             |
| Reversible with two rotations               | ✔ Yes                            | ✔ Yes                             |
| Supports arbitrary complex window matrices  | ✔ Yes                            | ⚠ Predictable but simpler        |

**Summary:**

- Emacs’s version performs a **true geometric rotation** of a window matrix.  
- This plugin performs a **direction toggle** of eligible splits, giving a similar feel for many layouts while remaining within Obsidian’s API guarantees.

---

## Obsidian Built-ins

Obsidian includes directional navigation commands for tab groups:fileciteturn1file0

- Focus on tab group above: `editor:focus-top`  
- Focus on tab group below: `editor:focus-bottom`  
- Focus on tab group to the left: `editor:focus-left`  
- Focus on tab group to the right: `editor:focus-right`  

The **Next Tab Group** command provides a simple, single-hotkey alternative that cycles through tab groups without needing directional bindings.

---

## Setting Hotkeys

1. Go to **Settings → Hotkeys** in Obsidian.  
2. Search for:
   - “Next tab group”  
   - “Collect tabs”  
   - “Rotate tab groups”  
3. Assign your preferred shortcuts.

These three commands together give you a fast, keyboard-driven workflow for navigating, consolidating, and reorienting your tab groups.
