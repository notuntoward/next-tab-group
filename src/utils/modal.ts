import type { SuggestModal } from 'obsidian';

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
 * Registers Emacs-style motion keys on a SuggestModal/FuzzySuggestModal.
 *
 * Ctrl+F / Ctrl+B move the input cursor right/left (mirroring the arrow keys),
 * and Ctrl+N / Ctrl+P move the suggestion selection down/up.
 */
export function registerEmacsMotionKeys(modal: SuggestModal<unknown>): void {
    const { inputEl, scope } = modal;

    scope.register(['Ctrl'], 'F', (evt) => {
        evt.preventDefault();
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
