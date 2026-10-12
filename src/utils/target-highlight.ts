/** A workspace element to mark and the CSS class that marks it. */
export interface HighlightTarget {
    el: HTMLElement | null | undefined;
    cls: string;
}

/**
 * Marks workspace elements (tab headers, tab groups) with CSS classes while a
 * modal is open and reliably removes exactly what it added. Shared by every
 * modal that previews its target in the workspace (switch pickers, dedupe).
 * `set` diffs against the previous call, so repeated calls are cheap and never
 * leave stale marks behind.
 */
export class TargetHighlighter {
    private marked = new Map<HTMLElement, Set<string>>();

    set(targets: HighlightTarget[]): void {
        const wanted = new Map<HTMLElement, Set<string>>();
        for (const { el, cls } of targets) {
            if (!el || !el.isConnected) continue;
            const classes = wanted.get(el) ?? new Set<string>();
            classes.add(cls);
            wanted.set(el, classes);
        }
        for (const [el, classes] of this.marked) {
            const keep = wanted.get(el);
            for (const cls of classes) {
                if (!keep?.has(cls)) el.classList.remove(cls);
            }
        }
        for (const [el, classes] of wanted) {
            for (const cls of classes) el.classList.add(cls);
        }
        this.marked = wanted;
    }

    clear(): void {
        this.set([]);
    }
}
