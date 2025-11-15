# Next Tab Group

This plugin provides one command, **Next Tab Group** (`next-tab-group`), which cycles your cursor between "tab groups": whole windows with individual tabs inside.  This is similar to the Emacs `other-window` command.

### Examples
```
┌───────────┬───────────┐
│  Group 1  │  Group 2  │
└───────────┴───────────┘
```
Pressing "Next Tab Group": Group 1 → Group 2 → Groupe 1 → ...
```
┌──────────┬──────────┐
│  Top L   │  Top R   │
├──────────┼──────────┤
│  Bot L   │  Bot R   │
└──────────┴──────────┘
```
Order: Top L → Top R → Bot L → Bot R → Top L → ...

### Obsidian built-ins

Obsidian already comes with four commands for tab group navigation:

- Focus on tab group above: `editor:focus-top`
- Focus on tab group below: `editor:focus-bottom`
- Focus on tab group to the left: `editor:focus-left`
- Focus on tab group to the right: `editor:focus-right`

But why remember all of that when `Next Tab Group` does the same in one command -- and only a single hotkey, if you set one.

### Setting Hotkeys

1. Go to Settings → Hotkeys
2. Search for "Next tab group"
3. Assign your preferred hotkey
