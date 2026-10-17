import { setIcon, type Modal, type SuggestModal } from 'obsidian';

interface ChooserLike {
    selectedItem?: number;
    values?: unknown[];
    // Real Obsidian's signature is (index: number, event?: Event) -- not a
    // boolean "scroll into view" flag. Callers must not pass a boolean here:
    // see the try/catch usage below.
    setSelectedItem(index: number, event?: unknown): void;
}

/**
 * Calls chooser.setSelectedItem(index) defensively. Real Obsidian's internal
 * forceSetSelectedItem can throw (confirmed on 1.13.7: "TypeError:
 * t.instanceOf is not a function") depending on its internal state and the
 * argument types passed to it. This is an undocumented, private API -- never
 * let a failure here propagate out of a scope-registered key handler.
 */
function setSelectedItemSafely(chooser: ChooserLike, index: number): void {
    try {
        chooser.setSelectedItem(index);
    } catch {
        chooser.selectedItem = index;
    }
}

function getChooser(modal: SuggestModal<unknown>): ChooserLike | undefined {
    return (modal as unknown as { chooser?: ChooserLike }).chooser;
}

/**
 * Maps fuzzy-match index pairs from the full search text to a displayed
 * substring. Matches (or portions of matches) that fall outside the display
 * range are dropped, and surviving offsets are shifted to be relative to the
 * display text.
 */
export function mapFuzzyMatchesToDisplayText(
    searchText: string,
    displayText: string,
    displayOffset: number,
    matches: number[][],
): number[][] {
    const displayEnd = displayOffset + displayText.length;

    return matches
        .map(([start, end]) => {
            const clippedStart = Math.max(start, displayOffset);
            const clippedEnd = Math.min(end, displayEnd);

            if (clippedStart >= clippedEnd) {
                return null;
            }

            return [clippedStart - displayOffset, clippedEnd - displayOffset];
        })
        .filter((m): m is number[] => m !== null);
}

/**
 * Helper utility to break a string down by matching index pairs
 * and render bolded/highlighted HTML elements natively.
 */
export function renderHighlightedText(parentEl: HTMLElement, text: string, matches: number[][]): void {
    if (!matches || matches.length === 0) {
        parentEl.setText(text);
        return;
    }

    let lastIndex = 0;
    for (const [start, end] of matches) {
        // Append unmatched prefix string segment
        if (start > lastIndex) {
            parentEl.createSpan().setText(text.slice(lastIndex, start));
        }
        // Append highlighted match segment
        const highlightSpan = parentEl.createSpan({ cls: 'suggestion-highlight' });
        highlightSpan.setText(text.slice(start, end));

        lastIndex = end;
    }

    // Append trailing leftover text segment
    if (lastIndex < text.length) {
        parentEl.createSpan().setText(text.slice(lastIndex));
    }
}

export interface EmacsMotionOptions {
    /**
     * Returns the item to the left (-1) or right (+1) of the given item, or
     * null when there is none. When provided, Left/Right and Ctrl+B/Ctrl+F
     * select that item while the search box is empty.
     */
    neighbor?: (item: unknown, direction: -1 | 1) => unknown | null;
    /**
     * For modals that own their cursor (AGENTS.md rule 7): read the current
     * item and move the cursor through these instead of Obsidian's private
     * chooser.selectedItem. Both must be given together with 
eighbor.
     */
    cursor?: {
        current: () => unknown;
        select: (item: unknown) => void;
    };
}

/**
 * Selects the neighbor of the highlighted suggestion. Returns true when the
 * key was consumed (even at an edge with no neighbor), false when the
 * highlighted item cannot be determined.
 */
function selectNeighbor(
    modal: SuggestModal<unknown>,
    neighbor: NonNullable<EmacsMotionOptions['neighbor']>,
    direction: -1 | 1,
    cursor?: EmacsMotionOptions['cursor'],
): boolean {
    if (cursor) {
        const currentItem = cursor.current();
        if (currentItem === undefined) return false;
        const target = neighbor(currentItem, direction);
        if (target !== null && target !== undefined) cursor.select(target);
        return true;
    }
    const chooser = getChooser(modal);
    if (!chooser || typeof chooser.setSelectedItem !== 'function' || !Array.isArray(chooser.values)) {
        return false;
    }
    const current = typeof chooser.selectedItem === 'number' ? chooser.selectedItem : 0;
    const values = chooser.values as Array<{ item?: unknown }>;
    const currentItem = values[current]?.item;
    if (currentItem === undefined) {
        return false;
    }
    const target = neighbor(currentItem, direction);
    if (target === null || target === undefined) {
        return true;
    }
    const index = values.findIndex((v) => v?.item === target);
    if (index >= 0) {
        setSelectedItemSafely(chooser, index);
    }
    return true;
}

/**
 * Registers Emacs-style motion keys on a SuggestModal/FuzzySuggestModal.
 *
 * Ctrl+F / Ctrl+B move the input cursor right/left (mirroring the arrow keys),
 * and Ctrl+N / Ctrl+P move the suggestion selection down/up.
 */
export function registerEmacsMotionKeys(
    modal: SuggestModal<unknown>,
    options: EmacsMotionOptions = {},
): void {
    const { inputEl, scope } = modal;

    // Left/Right (and Ctrl+B/Ctrl+F) select the neighboring tab only while
    // the search box is empty; otherwise they keep moving the text cursor.
    // Every key has exactly one registration, here.
    const tryNeighbor = (direction: -1 | 1): boolean => {
        if (!options.neighbor || inputEl.value !== '') {
            return false;
        }
        try {
            return selectNeighbor(modal, options.neighbor, direction, options.cursor);
        } catch {
            return false;
        }
    };

    if (options.neighbor) {
        scope.register([], 'ArrowRight', (evt) => {
            if (!tryNeighbor(1)) return true;
            evt.preventDefault();
            return false;
        });
        scope.register([], 'ArrowLeft', (evt) => {
            if (!tryNeighbor(-1)) return true;
            evt.preventDefault();
            return false;
        });
    }

    scope.register(['Ctrl'], 'F', (evt) => {
        evt.preventDefault();
        if (tryNeighbor(1)) return false;
        const start = inputEl.selectionStart ?? 0;
        const end = inputEl.selectionEnd ?? 0;

        if (start !== end) {
            inputEl.setSelectionRange(end, end);
        } else if (end < inputEl.value.length) {
            inputEl.setSelectionRange(end + 1, end + 1);
        }
        return false;
    });

    scope.register(['Ctrl'], 'B', (evt) => {
        evt.preventDefault();
        if (tryNeighbor(-1)) return false;
        const start = inputEl.selectionStart ?? 0;
        const end = inputEl.selectionEnd ?? 0;

        if (start !== end) {
            inputEl.setSelectionRange(start, start);
        } else if (start > 0) {
            inputEl.setSelectionRange(start - 1, start - 1);
        }
        return false;
    });

    scope.register(['Ctrl'], 'N', (evt) => {
        evt.preventDefault();
        const chooser = getChooser(modal);
        if (!chooser || typeof chooser.setSelectedItem !== 'function') {
            return false;
        }

        const current = typeof chooser.selectedItem === 'number' ? chooser.selectedItem : 0;
        const count = Array.isArray(chooser.values) ? chooser.values.length : 0;
        const next = current + 1;

        if (next >= 0 && next < count) {
            setSelectedItemSafely(chooser, next);
        }
        return false;
    });

    scope.register(['Ctrl'], 'P', (evt) => {
        evt.preventDefault();
        const chooser = getChooser(modal);
        if (!chooser || typeof chooser.setSelectedItem !== 'function') {
            return false;
        }

        const current = typeof chooser.selectedItem === 'number' ? chooser.selectedItem : 0;
        const previous = current - 1;

        if (previous >= 0) {
            setSelectedItemSafely(chooser, previous);
        }
        return false;
    });
}

/** Identity of a picker: shown as a header and used to color it. */
export interface PickerHeader {
    /** Kebab-case id; becomes the `ntg-picker-<kind>` class that sets the accent color. */
    kind: string;
    title: string;
    /** One-line instruction under the title. */
    hint: string;
    /** Lucide icon id. */
    icon: string;
}

/**
 * Adds a title row (icon, title, hint) above the filter input and tags the
 * modal with its `ntg-picker-<kind>` class, so each command's picker looks
 * different (accent stripe + icon + title) instead of all being the same bare
 * search box. Cosmetic only: never throws into the caller's setup.
 */
export function addPickerHeader(modalEl: HTMLElement | undefined, header: PickerHeader): void {
    try {
        if (!modalEl) return;
        modalEl.classList.add('ntg-picker', `ntg-picker-${header.kind}`);
        const inputContainer = modalEl.querySelector('.prompt-input-container');
        const parent = inputContainer?.parentElement ?? modalEl;
        const doc = modalEl.ownerDocument;
        const row = doc.createElement('div');
        row.className = 'ntg-picker-header';
        const icon = doc.createElement('span');
        icon.className = 'ntg-picker-icon';
        setIcon(icon, header.icon);
        const title = doc.createElement('span');
        title.className = 'ntg-picker-title';
        title.textContent = header.title;
        const hint = doc.createElement('span');
        hint.className = 'ntg-picker-hint';
        hint.textContent = header.hint;
        row.append(icon, title, hint);
        parent.insertBefore(row, inputContainer ?? parent.firstChild);
    } catch {
        // purely decorative
    }
}

/**
 * Lets Escape close `modal` even when keyboard focus is in a different
 * Obsidian window (a pop-out stacked over the window the modal opened in).
 *
 * Why: a modal is attached to the document of the window that was active when
 * it opened, and Obsidian's own Escape handling only sees keys typed there.
 * If a pop-out comes to the front, the modal can be completely hidden behind
 * it, keys go to the pop-out, and Escape does nothing, leaving the user stuck
 * with an invisible modal. Obsidian's convention is that Escape always
 * dismisses a modal, so we honor it from every window.
 *
 * The modal's own window is deliberately NOT listened to: Obsidian's Scope
 * already handles Escape there, and a second registration would run the
 * handler twice (see AGENTS.md, one registration path per shortcut).
 *
 * Returns a cleanup function; call it from onClose. Never throws.
 */
export function closeOnEscapeFromOtherWindows(modal: Modal): () => void {
    const attached = new Map<Document, (e: KeyboardEvent) => void>();
    let offRef: (() => void) | undefined;
    try {
        const home = modal.containerEl.ownerDocument;
        const attach = (doc: Document | undefined) => {
            if (!doc || doc === home || attached.has(doc)) return;
            const handler = (e: KeyboardEvent) => {
                if (e.key !== 'Escape' || !modal.containerEl.isConnected) return;
                e.preventDefault();
                e.stopPropagation();
                modal.close();
            };
            doc.addEventListener('keydown', handler, true);
            attached.set(doc, handler);
        };
        const workspace = modal.app.workspace;
        workspace.iterateAllLeaves((leaf) => attach(leaf.view?.containerEl?.ownerDocument));
        const ref = workspace.on('window-open', (_ws, win) => attach(win.document));
        offRef = () => workspace.offref(ref);
    } catch {
        // best effort only
    }
    return () => {
        try {
            offRef?.();
            for (const [doc, handler] of attached) doc.removeEventListener('keydown', handler, true);
            attached.clear();
        } catch {
            // ignore
        }
    };
}