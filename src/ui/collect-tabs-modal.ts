import { App, Notice, SuggestModal, WorkspaceLeaf } from 'obsidian';
import { isLeafDetached } from 'commons/workspace';
import { ownerWindow, setTimeoutIn } from 'commons/windows';
import { addPickerHeader, registerEmacsMotionKeys, closeOnEscapeFromOtherWindows, type PickerHeader } from '../utils/modal';
import type { WindowInfo } from '../../main';
import { TargetHighlighter, type HighlightTarget } from '../utils/target-highlight';
import { matchParts, renderMatchingTitles, statusWords, uniqueTitles, type SearchPart } from '../utils/search';

export type CollectChoice =
    | { kind: 'current'; winInfo: WindowInfo; label: string; checked: boolean; windowIndex: number }
    | { kind: 'all'; label: string; checked: boolean }
    | { kind: 'window'; winInfo: WindowInfo; label: string; checked: boolean; windowIndex: number }
    | ScopeChoice;

/**
 * A generic, caller-defined row (used by the Deduplicate tabs command, whose
 * scopes are tab groups / windows rather than only windows).
 */
export interface ScopeChoice {
    kind: 'scope';
    id: string;
    label: string;
    checked: boolean;
    /** Text/glyph shown in the badge column. */
    badge: string;
    /** Short trailing detail shown after the label (e.g. "2 to close"). */
    detail?: string;
    /** Optional status pill text (e.g. "HERE", "MAIN", "HERE · MAIN"). */
    status?: string;
    /** Indented sub-lines listed under the row (e.g. tabs that will be closed). */
    items?: Array<{ kind: 'close' | 'keep'; text: string }>;
    /** Titles of the tabs this row's scope covers; what typing in the filter searches. */
    searchTitles?: string[];
    /** The window this row stands for, if any (enables Left/Right and window hover). */
    winInfo?: WindowInfo;
}

export interface CollectModalOptions {
    /** Rows to show instead of the window rows (requires currentWindow === null). */
    scopeRows?: ScopeChoice[];
    placeholder?: string;
    actionLabel?: string;
    /** Toast shown when the action is triggered with no row checked. */
    nothingCheckedNotice?: string;
    commandName?: string;
    header?: PickerHeader;
    /** Workspace elements to mark for the currently chosen + checked rows. */
    getTargets?: (chosen: CollectChoice[]) => HighlightTarget[];
    /**
     * Orders windows for the Left/Right keys (clockwise from their screen
     * rectangles, like Switch to window). Omit to disable Left/Right.
     */
    windowRing?: (windows: WindowInfo[]) => WindowInfo[];
    /** Text describing what the action would do for the current selection. */
    getSummary?: (chosen: CollectChoice[], checked: CollectChoice[]) => string;
}

const sessionWindowIndices = new Map<Window | object, number>();
let nextSessionIndex = 2; // 1 is reserved for the main window

export function resetSessionWindowIndices(): void {
    sessionWindowIndices.clear();
    nextSessionIndex = 2;
}

export function getSessionWindowIndex(winInfo: WindowInfo): number {
    const isMain = winInfo.isMainWindow;
    if (isMain) {
        if (winInfo.window) {
            sessionWindowIndices.set(winInfo.window, 1);
        } else {
            sessionWindowIndices.set(winInfo, 1);
        }
        return 1;
    }

    const key: Window | object = winInfo.window ?? winInfo;
    const existing = sessionWindowIndices.get(key);
    if (existing !== undefined) {
        return existing;
    }

    const assigned = nextSessionIndex++;
    sessionWindowIndices.set(key, assigned);
    return assigned;
}

function truncateTitle(str: string, maxLen = 25): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 1) + '…';
}

export interface WindowTabDetails {
    primaryTitle: string;
    secondaryTitle?: string;
    remainingCount?: number;
}

export function getWindowTabDetails(winInfo: WindowInfo): WindowTabDetails {
    const repLeaf = winInfo.representative;
    const repTitle = truncateTitle(repLeaf?.getDisplayText() || 'Untitled');

    const allLeaves: WorkspaceLeaf[] = [];
    if (winInfo.groups) {
        for (const g of winInfo.groups) {
            if (g?.leaves) {
                for (const l of g.leaves) {
                    if (l && !isLeafDetached(l)) {
                        allLeaves.push(l);
                    }
                }
            }
        }
    }

    const totalTabs = Math.max(
        allLeaves.length,
        winInfo.groups?.reduce((acc, g) => acc + (g?.leaves?.length || 0), 0) || 1,
    );

    if (totalTabs <= 1) {
        return { primaryTitle: repTitle };
    }

    const secondLeaf = allLeaves.find((l) => l !== repLeaf);
    const secondTitle = secondLeaf ? truncateTitle(secondLeaf.getDisplayText() || 'Untitled') : undefined;

    if (secondTitle) {
        return {
            primaryTitle: repTitle,
            secondaryTitle: secondTitle,
            remainingCount: totalTabs > 2 ? totalTabs - 2 : undefined,
        };
    }

    return {
        primaryTitle: repTitle,
        remainingCount: totalTabs - 1,
    };
}

export function describeWindow(winInfo: WindowInfo): string {
    const details = getWindowTabDetails(winInfo);
    if (!details.secondaryTitle) {
        return details.remainingCount ? `${details.primaryTitle}, +${details.remainingCount}` : details.primaryTitle;
    }
    if (details.remainingCount !== undefined && details.remainingCount > 0) {
        return `${details.primaryTitle}, ${details.secondaryTitle}, +${details.remainingCount}`;
    }
    return `${details.primaryTitle}, ${details.secondaryTitle}`;
}

export class CollectTabsModal extends SuggestModal<CollectChoice> {
    public static activeModal: CollectTabsModal | null = null;
    public isOpen = false;

    // Single list of selectable rows; all selection state lives on these.
    private rows: CollectChoice[];
    private actionLabel: string;
    private nothingCheckedNotice: string;
    private commandName: string;
    private header: PickerHeader;
    private getTargets?: (chosen: CollectChoice[]) => HighlightTarget[];
    private getSummary?: (chosen: CollectChoice[], checked: CollectChoice[]) => string;
    private windowRing?: (windows: WindowInfo[]) => WindowInfo[];
    private summaryEl?: HTMLElement;
    /** Row under the mouse: a transient preview that never moves the keyboard cursor. */
    private hovered: CollectChoice | null = null;
    private stopWindowHover?: () => void;
    private stopEscape?: () => void;
    private cancelTimers: Array<() => void> = [];
    private readonly highlighter = new TargetHighlighter();
    private onPick: (choice: CollectChoice | CollectChoice[]) => void;

    public highlightedIndex = 0;
    private handleKeyDown?: (evt: KeyboardEvent) => void;

    // Persistent footer toolbar and action buttons
    public toolbarEl?: HTMLElement;
    public selectAllBtn?: HTMLButtonElement;
    public clearSelectionBtn?: HTMLButtonElement;
    public cancelBtn?: HTMLButtonElement;
    public collectBtn?: HTMLButtonElement;

    constructor(
        app: App,
        currentWindow: WindowInfo | null,
        otherWindows: WindowInfo[],
        onPick: (choice: CollectChoice | CollectChoice[]) => void,
        options: CollectModalOptions = {},
    ) {
        super(app);
        this.onPick = onPick;
        this.actionLabel = options.actionLabel ?? 'Collect';
        this.nothingCheckedNotice = options.nothingCheckedNotice ?? 'Nothing checked.';
        this.commandName = options.commandName ?? 'collect-tabs';
        this.header = options.header ?? {
            kind: 'collect',
            title: 'Collect tabs',
            hint: 'Check the windows whose tabs should be gathered into one tab group.',
            icon: 'combine',
        };
        this.getTargets = options.getTargets;
        this.getSummary = options.getSummary;
        this.windowRing = options.windowRing;

        // Clean row content with no prefix text; status is conveyed by the badge & column grid.
        // The HERE row starts checked: it is what Enter/Collect acts on by default,
        // and the checkbox must reflect that truthfully instead of relying solely
        // on the keyboard-current highlight to convey "this will be collected".
        if (currentWindow === null) {
            this.rows = options.scopeRows ?? [];
        } else {
            const currentIdx = getSessionWindowIndex(currentWindow);
            const currentRow: CollectChoice = {
                kind: 'current',
                winInfo: currentWindow,
                label: describeWindow(currentWindow),
                checked: true,
                windowIndex: currentIdx,
            };

            const allRow: CollectChoice = {
                kind: 'all',
                label: 'All windows',
                checked: false,
            };

            const windowRows: CollectChoice[] = otherWindows.map((w) => {
                const idx = getSessionWindowIndex(w);
                return {
                    kind: 'window' as const,
                    winInfo: w,
                    label: describeWindow(w),
                    checked: false,
                    windowIndex: idx,
                };
            });
            this.rows = [currentRow, allRow, ...windowRows];
        }
        // Filter and instructions hierarchy:
        // 1. Filter input
        // 2. Window list
        // 3. Action toolbar
        // 4. Keyboard hints
        this.setPlaceholder(options.placeholder ?? 'Select windows to gather tabs from');
        this.setInstructions([
            { command: '↑↓', purpose: 'navigate' },
            ...(options.windowRing ? [{ command: '←→', purpose: 'neighbor window' }] : []),
            { command: 'space', purpose: 'toggle' },
            { command: '↵', purpose: this.actionLabel.toLowerCase() },
            { command: 'esc', purpose: 'cancel' },
        ]);
    }

    public getFocusableControls(): HTMLElement[] {
        if (!this.modalEl) return [];

        const controls: HTMLElement[] = [];

        // 1. Filter input
        if (this.inputEl && !this.inputEl.disabled) {
            controls.push(this.inputEl);
        }

        // 2. Toolbar buttons in forward order: Select all, Clear selection (when visible & enabled), Cancel, Collect
        if (this.selectAllBtn && !this.selectAllBtn.disabled) {
            controls.push(this.selectAllBtn);
        }
        if (
            this.clearSelectionBtn &&
            !this.clearSelectionBtn.disabled &&
            this.clearSelectionBtn.style.display !== 'none'
        ) {
            controls.push(this.clearSelectionBtn);
        }
        if (this.cancelBtn && !this.cancelBtn.disabled) {
            controls.push(this.cancelBtn);
        }
        if (this.collectBtn && !this.collectBtn.disabled) {
            controls.push(this.collectBtn);
        }

        // Close button removed per spec (redundant with ESC and Cancel button)

        return controls;
    }

    public handleTabNavigation(evt: KeyboardEvent): boolean {
        if (evt.key !== 'Tab') return false;

        const controls = this.getFocusableControls();
        if (controls.length === 0) return false;

        const active = this.containerEl.ownerDocument.activeElement as HTMLElement | null;
        const currentIndex = active ? controls.indexOf(active) : -1;

        evt.preventDefault();

        if (evt.shiftKey) {
            const prevIndex = currentIndex <= 0 ? controls.length - 1 : currentIndex - 1;
            controls[prevIndex].focus();
        } else {
            const nextIndex = currentIndex === -1 || currentIndex >= controls.length - 1 ? 0 : currentIndex + 1;
            controls[nextIndex].focus();
        }

        return true;
    }

    public setHighlightedIndex(index: number): void {
        const currentSuggestions = this.getSuggestions(this.inputEl?.value ?? '');
        const target = Math.max(0, Math.min(index, Math.max(0, currentSuggestions.length - 1)));
        this.highlightedIndex = target;

        const chooser = (this as any).chooser;
        if (chooser) {
            chooser.selectedItem = target;
            // Obsidian's real chooser.setSelectedItem(index, event?) expects an
            // Event (or undefined) as its second argument -- NOT a boolean.
            // Passing `true` (confirmed on Obsidian 1.13.7) makes its internal
            // forceSetSelectedItem throw ("t.instanceOf is not a function") when
            // it tries to type-check the "event". That throw is uncaught here
            // and would otherwise unwind this entire function -- skipping our
            // own updateHighlightVisuals() below, and (since onOpen() calls this
            // synchronously) everything onOpen() sets up afterward, including
            // the ArrowUp/ArrowDown scope registrations. Call with no second
            // argument (we have no real event to give it) and keep the try/catch
            // as defense-in-depth against future Obsidian internal changes. We
            // already keep chooser.selectedItem and our own highlightedIndex in
            // sync directly above/elsewhere, and render our own highlight via
            // updateHighlightVisuals(), so this call is a best-effort nicety
            // (Obsidian's own scroll-into-view) that must never be allowed to
            // break the rest of modal setup if it fails.
            if (typeof chooser.setSelectedItem === 'function') {
                try {
                    chooser.setSelectedItem(target);
                } catch {
                    // ignore: see comment above
                }
            }
        }

        this.updateHighlightVisuals();
    }

    public moveHighlight(delta: number): void {
        this.setHighlightedIndex(this.highlightedIndex + delta);
    }

    /**
     * Workspace marks. Checked rows are what Enter acts on and get the solid
     * marks. The keyboard cursor row and the hovered row (mouse only) get a
     * dashed, lighter preview of the same marks. Hover disappears when the
     * mouse leaves; checked rows stay. The summary describes the checked rows
     * only, because that is exactly what the action does.
     */
    public syncTargetHighlight(): void {
        if (!this.getTargets && !this.getSummary) return;
        try {
            const checked = [...this.getCheckedRows()];
            const targets: HighlightTarget[] = this.getTargets ? [...this.getTargets(checked)] : [];
            if (this.getTargets) {
                const solid = new Set(targets.map((t) => `${t.cls}|${t.el ? this.elKey(t.el) : ''}`));
                const previewRows: CollectChoice[] = [];
                for (const row of [this.getHighlightedItem(), this.hovered]) {
                    if (row && !row.checked && !previewRows.includes(row)) previewRows.push(row);
                }
                for (const row of previewRows) {
                    for (const t of this.getTargets([row])) {
                        if (solid.has(`${t.cls}|${t.el ? this.elKey(t.el) : ''}`)) continue;
                        targets.push({ el: t.el, cls: `${t.cls}-preview` });
                    }
                }
            }
            if (this.getTargets) this.highlighter.set(targets);
            if (this.summaryEl && this.getSummary) this.summaryEl.setText(this.getSummary(checked, checked));
        } catch {
            this.highlighter.clear();
        }
    }

    private elementKeys = new WeakMap<HTMLElement, number>();
    private nextElementKey = 1;
    private elKey(el: HTMLElement): number {
        let key = this.elementKeys.get(el);
        if (key === undefined) {
            key = this.nextElementKey++;
            this.elementKeys.set(el, key);
        }
        return key;
    }

    /** Sets (or clears) the mouse-hover row and repaints; never touches the keyboard cursor. */
    public setHoveredRow(row: CollectChoice | null): void {
        if (this.hovered === row) return;
        this.hovered = row;
        this.updateHighlightVisuals();
    }

    private rowWinInfo(row: CollectChoice): WindowInfo | undefined {
        return row.kind === 'all' ? undefined : row.winInfo;
    }

    /**
     * Left/Right: the window row `direction` steps from `row` in the ring order
     * of windows (clockwise like Switch to window), wrapping at the ends. From a
     * row that is not a window (All windows, a tab group) it enters the ring at
     * the current window. Null when there are fewer than two window rows.
     */
    public windowNeighbor(row: CollectChoice, direction: -1 | 1): CollectChoice | null {
        const winRows = this.getSuggestions(this.inputEl?.value ?? '').filter((r) => this.rowWinInfo(r));
        if (winRows.length < 2) return null;
        const wins = winRows.map((r) => this.rowWinInfo(r)!);
        const ring = this.windowRing ? this.windowRing(wins).filter((w) => wins.includes(w)) : wins;
        const own = this.rowWinInfo(row);
        let target: WindowInfo | undefined;
        if (!own) {
            target = ring.find((w) => w.isCurrentWindow) ?? ring[0];
        } else {
            const at = ring.indexOf(own);
            if (at < 0) return null;
            target = ring[(at + direction + ring.length) % ring.length];
        }
        return winRows.find((r) => this.rowWinInfo(r) === target) ?? null;
    }

    /**
     * Hovering another window (the modal's own window is covered by the
     * backdrop) previews its row. Listeners are per window, added once per
     * distinct window and all removed on close.
     */
    private attachWindowHover(): void {
        const ownWin = this.modalEl?.ownerDocument?.defaultView ?? null;
        const cleanups: Array<() => void> = [];
        const seen = new Set<Window>();
        for (const row of this.rows) {
            const win = this.rowWinInfo(row)?.window;
            if (!win || win === ownWin || seen.has(win)) continue;
            seen.add(win);
            const doc = win.document;
            if (!doc?.addEventListener) continue;
            const over = () => this.setHoveredRow(row);
            const out = () => { if (this.hovered === row) this.setHoveredRow(null); };
            doc.addEventListener('mousemove', over, true);
            doc.documentElement?.addEventListener('mouseleave', out);
            cleanups.push(() => {
                doc.removeEventListener('mousemove', over, true);
                doc.documentElement?.removeEventListener('mouseleave', out);
            });
        }
        this.stopWindowHover = () => cleanups.forEach((c) => c());
    }
    public updateHighlightVisuals(): void {
        this.syncTargetHighlight();
        const container = this.resultContainerEl ?? this.modalEl?.querySelector('.prompt-results') ?? this.modalEl;
        if (!container) return;

        const suggestionItems = Array.from(container.querySelectorAll<HTMLElement>('.suggestion-item'));
        suggestionItems.forEach((item, i) => {
            if (i === this.highlightedIndex) {
                item.addClass('is-selected');
                item.addClass('ntg-keyboard-current');
            } else {
                item.removeClass('is-selected');
                item.removeClass('ntg-keyboard-current');
            }
        });

        const rowItems = Array.from(container.querySelectorAll<HTMLElement>('.ntg-collect-row'));
        const hoveredAt = this.hovered ? this.getSuggestions(this.inputEl?.value ?? '').indexOf(this.hovered) : -1;
        rowItems.forEach((row, i) => {
            row.classList.toggle('ntg-hover', i === hoveredAt);
            if (i === this.highlightedIndex) {
                row.addClass('is-selected');
                row.addClass('ntg-keyboard-current');
            } else {
                row.removeClass('is-selected');
                row.removeClass('ntg-keyboard-current');
            }
        });
    }

    open(): void {
        if (
            CollectTabsModal.activeModal &&
            CollectTabsModal.activeModal !== this &&
            CollectTabsModal.activeModal.isOpen &&
            CollectTabsModal.activeModal.modalEl?.isConnected
        ) {
            try {
                CollectTabsModal.activeModal.close();
            } catch {
                // ignore
            }
            new Notice(`Existing ${this.commandName} command cancelled`);
        }
        CollectTabsModal.activeModal = this;
        try {
            // Obsidian's Modal.open() silently does nothing (no onOpen, no DOM, no
            // error) if the instance's own 'isOpen' flag is already truthy. Never
            // set this.isOpen before super.open(); doing so shipped a command that
            // appeared to do nothing at all on real Obsidian.
            super.open();
            this.isOpen = true;
        } catch (err) {
            this.isOpen = false;
            if (CollectTabsModal.activeModal === this) {
                CollectTabsModal.activeModal = null;
            }
            throw err;
        }
    }

    onOpen(): void {
        super.onOpen();
        const win = ownerWindow(this.containerEl);
        const doc = this.containerEl.ownerDocument;
        this.stopEscape = closeOnEscapeFromOtherWindows(this);
        if (this.containerEl) {
            this.containerEl.addClass('ntg-collect-modal-container');
        }

        if (this.modalEl) {
            this.modalEl.addClass('ntg-collect-modal');
            addPickerHeader(this.modalEl, this.header);

            // Ensure input type is 'text' so WebKit never renders a native search cancel button
            if (this.inputEl) {
                this.inputEl.type = 'text';
            }

            // Remove redundant 'X' close / clear button per spec
            const removeRedundantX = () => {
                const selectors = [
                    '.modal-close-button',
                    '.search-input-clear-button',
                    '.prompt-input-container .search-input-clear-button',
                ];
                const roots = [
                    this.modalEl,
                    this.containerEl,
                    this.modalEl?.parentElement,
                    this.modalEl?.ownerDocument?.body,
                ];
                for (const root of roots) {
                    if (!root) continue;
                    for (const sel of selectors) {
                        const found = root.querySelectorAll<HTMLElement>(sel);
                        found.forEach((el) => {
                            if (el.closest('.collect-tabs-action-toolbar')) return;
                            el.style.setProperty('display', 'none', 'important');
                            el.remove();
                        });
                    }
                }
            };

            removeRedundantX();
            if (win) {
                this.cancelTimers.push(setTimeoutIn(win, removeRedundantX, 0));
                this.cancelTimers.push(setTimeoutIn(win, removeRedundantX, 50));
            }

            // Find prompt or modal container to place persistent action toolbar above keyboard hints
            const promptEl = (this.modalEl.querySelector('.prompt') as HTMLElement) ?? this.modalEl;
            const instructionsEl = promptEl.querySelector('.prompt-instructions');

            // Build persistent footer toolbar with stable opposite groups
            this.toolbarEl = doc.createElement('div');
            this.toolbarEl.className = 'collect-tabs-action-toolbar ntg-action-toolbar';

            // Left subgroup: [Select all] [Clear selection]
            const leftGroup = this.toolbarEl.createDiv({ cls: 'ntg-toolbar-left' });
            this.selectAllBtn = leftGroup.createEl('button', {
                cls: 'ntg-btn ntg-btn-select-all',
                text: 'Select all',
                attr: { type: 'button' },
            });
            this.selectAllBtn.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                this.checkAll();
            });

            this.clearSelectionBtn = leftGroup.createEl('button', {
                cls: 'ntg-btn ntg-btn-clear-selection',
                text: 'Clear selection',
                attr: { type: 'button' },
            });
            this.clearSelectionBtn.disabled = !this.hasAnyChecked();
            this.clearSelectionBtn.style.display = this.hasAnyChecked() ? '' : 'none';
            this.clearSelectionBtn.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                this.clearSelection();
            });

            // Right subgroup: [Cancel] [Collect]
            const rightGroup = this.toolbarEl.createDiv({ cls: 'ntg-toolbar-right' });
            this.cancelBtn = rightGroup.createEl('button', {
                cls: 'ntg-btn ntg-btn-cancel',
                text: 'Cancel',
                attr: { type: 'button' },
            });
            this.cancelBtn.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                this.close();
            });

            this.collectBtn = rightGroup.createEl('button', {
                cls: 'mod-cta ntg-btn ntg-btn-collect',
                text: this.actionLabel,
                attr: { type: 'button' },
            });
            this.collectBtn.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                this.executeCollection();
            });

            if (instructionsEl && instructionsEl.parentElement) {
                instructionsEl.parentElement.insertBefore(this.toolbarEl, instructionsEl);
            } else {
                promptEl.appendChild(this.toolbarEl);
            }

            if (this.getSummary && this.toolbarEl.parentElement) {
                this.summaryEl = doc.createElement('div');
                this.summaryEl.className = 'ntg-picker-summary';
                this.toolbarEl.parentElement.insertBefore(this.summaryEl, this.toolbarEl);
                this.syncTargetHighlight();
            }

            // Tab / Shift+Tab and Space key handling
            this.handleKeyDown = (evt: KeyboardEvent) => {
                if (evt.key === 'Tab') {
                    this.handleTabNavigation(evt);
                    return;
                }

                if (evt.key === ' ' || evt.code === 'Space') {
                    const active = this.containerEl.ownerDocument.activeElement as HTMLElement | null;
                    if (active && active.tagName === 'BUTTON') {
                        evt.preventDefault();
                        evt.stopPropagation();
                        active.click();
                        return;
                    }

                    evt.preventDefault();
                    evt.stopPropagation();
                    this.handleSpace();
                }
            };
            this.modalEl.addEventListener('keydown', this.handleKeyDown, true);
        }

        // Hook chooser.setSelectedItem if present
        const chooser = (this as any).chooser;
        if (chooser) {
            const orig = chooser.setSelectedItem?.bind(chooser);
            chooser.setSelectedItem = (index: number, scroll?: unknown) => {
                // Obsidian passes the mouse event when the pointer moves over a
                // row. That is only a hover preview: it must not move the
                // keyboard cursor or Obsidian's own selection.
                const type = (scroll as { type?: unknown } | null | undefined)?.type;
                if (typeof type === 'string' && /^(mouse|pointer)/.test(type)) {
                    this.setHoveredRow(this.getSuggestions(this.inputEl?.value ?? '')[index] ?? null);
                    return;
                }
                // See the matching comment in setHighlightedIndex(): Obsidian's
                // real setSelectedItem can throw internally depending on its
                // internal state and the (mismatched) argument types plugins
                // typically pass it. Never let that break our own bookkeeping
                // below or whatever caller (ours or Obsidian's own) invoked this.
                try {
                    if (orig) orig(index, scroll as never);
                    else chooser.selectedItem = index;
                } catch {
                    chooser.selectedItem = index;
                }
                this.highlightedIndex = index;
                this.updateHighlightVisuals();
            };
        }

        // Initialize keyboard-current highlight to index 0 (the HERE row).
        this.setHighlightedIndex(0);

        // Defensive re-assertion: Obsidian's SuggestModal can (re)render its
        // suggestion list and reset its internal chooser.selectedItem after
        // onOpen() returns, independent of the synchronous call above. Re-apply
        // the HERE-row highlight once more on the next tick so it wins over any
        // such later reset. This mirrors the established pattern already used by
        // NavigationSuggestModal in main.ts for the same class of problem.
        if (win) {
            this.cancelTimers.push(setTimeoutIn(win, () => {
                if (!this.isOpen) return;
                this.setHighlightedIndex(0);
            }, 0));
        }

        // Left/Right and Ctrl+B/F move through windows in space (clockwise ring),
        // like Switch to window; Up/Down move through the list (recency).
        registerEmacsMotionKeys(
            this,
            this.windowRing
                ? {
                    neighbor: (item, direction) => this.windowNeighbor(item as CollectChoice, direction),
                    cursor: {
                        current: () => this.getHighlightedItem(),
                        select: (item) => {
                            const at = this.getSuggestions(this.inputEl?.value ?? '').indexOf(item as CollectChoice);
                            if (at >= 0) this.setHighlightedIndex(at);
                        },
                    },
                }
                : {},
        );
        this.attachWindowHover();

        this.scope.register([], 'ArrowDown', (evt) => {
            evt.preventDefault();
            this.moveHighlight(1);
            return false;
        });

        this.scope.register([], 'ArrowUp', (evt) => {
            evt.preventDefault();
            this.moveHighlight(-1);
            return false;
        });

        // Space is handled exclusively by the modalEl capture listener above
        // (this.handleKeyDown). Do not also register it on this.scope or on
        // this.inputEl: Obsidian's Scope dispatches key events independently of
        // DOM propagation, so registering the same key in multiple places causes
        // a single physical keypress to run handleSpace() more than once, which
        // nets out to a check-then-immediate-uncheck no-op.
    }

    onClose(): void {
        this.cancelTimers.splice(0).forEach((cancel) => cancel());
        this.stopEscape?.();
        this.stopEscape = undefined;
        this.stopWindowHover?.();
        this.stopWindowHover = undefined;
        this.hovered = null;
        this.highlighter.clear();
        this.isOpen = false;
        if (CollectTabsModal.activeModal === this) {
            CollectTabsModal.activeModal = null;
        }
        if (this.modalEl && this.handleKeyDown) {
            this.modalEl.removeEventListener('keydown', this.handleKeyDown, true);
        }
        super.onClose();
    }

    public updateToolbarState(): void {
        this.syncTargetHighlight();
        const hasChecked = this.hasAnyChecked();
        if (this.clearSelectionBtn) {
            this.clearSelectionBtn.disabled = !hasChecked;
            this.clearSelectionBtn.style.display = hasChecked ? '' : 'none';
        }
    }

    public hasAnyChecked(): boolean {
        return this.rows.some((r) => r.checked);
    }

    public getCheckedRows(): CollectChoice[] {
        return this.rows.filter((r) => r.checked);
    }

    public syncRowVisuals(choice: CollectChoice): void {
        const container = this.resultContainerEl ?? this.modalEl?.querySelector('.prompt-results') ?? this.modalEl;
        if (!container) return;
        const currentSuggestions = this.getSuggestions(this.inputEl?.value ?? '');
        const index = currentSuggestions.indexOf(choice);
        if (index === -1) return;

        const rowEls = container.querySelectorAll<HTMLElement>('.suggestion-item');
        const rowEl = rowEls[index];
        if (!rowEl) return;

        const checkbox = rowEl.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (checkbox) {
            checkbox.checked = choice.checked;
        }
        if (choice.checked) {
            rowEl.addClass('is-checked');
            rowEl.addClass('ntg-checked');
        } else {
            rowEl.removeClass('is-checked');
            rowEl.removeClass('ntg-checked');
        }
    }

    public syncAllRowVisuals(): void {
        const container = this.resultContainerEl ?? this.modalEl?.querySelector('.prompt-results') ?? this.modalEl;
        if (!container) return;
        const currentSuggestions = this.getSuggestions(this.inputEl?.value ?? '');
        const rowEls = container.querySelectorAll<HTMLElement>('.suggestion-item');
        rowEls.forEach((rowEl, i) => {
            const choice = currentSuggestions[i];
            if (!choice) return;
            const checkbox = rowEl.querySelector<HTMLInputElement>('input[type="checkbox"]');
            if (checkbox) {
                checkbox.checked = choice.checked;
            }
            if (choice.checked) {
                rowEl.addClass('is-checked');
                rowEl.addClass('ntg-checked');
            } else {
                rowEl.removeClass('is-checked');
                rowEl.removeClass('ntg-checked');
            }
        });
    }

    public checkAll(): void {
        for (const r of this.rows) {
            r.checked = true;
        }
        this.syncAllRowVisuals();
        this.updateToolbarState();
    }

    public clearSelection(): void {
        for (const r of this.rows) {
            r.checked = false;
        }
        this.syncAllRowVisuals();
        this.updateToolbarState();
        // clearSelection() is only ever reached via the clearSelectionBtn click
        // handler, and updateToolbarState() just hid that button (display: none)
        // because nothing is checked anymore. In a real browser, hiding the
        // currently-focused element blurs it immediately, moving focus to
        // <body> -- so checking document.activeElement here is unreliable (it
        // already reads as something other than clearSelectionBtn by the time we
        // get here). Unconditionally return focus to the filter input instead:
        // that's the row-browsing context where Spacebar toggles the highlighted
        // row, whereas focus left on <body> or a BUTTON makes Spacebar do nothing
        // useful (or activate that button per handleKeyDown), silently breaking
        // row toggling by keyboard.
        this.inputEl.focus();
    }

    public toggleRow(choice: CollectChoice): void {
        choice.checked = !choice.checked;
        const currentSuggestions = this.getSuggestions(this.inputEl?.value ?? '');
        const targetIndex = currentSuggestions.indexOf(choice);
        if (targetIndex !== -1) {
            this.highlightedIndex = targetIndex;
        }
        this.syncRowVisuals(choice);
        this.updateToolbarState();
    }

    public getHighlightedItem(): CollectChoice | undefined {
        // this.highlightedIndex is the single source of truth for the current
        // selection. It is kept in sync with Obsidian's internal chooser via
        // setHighlightedIndex() and the hooked chooser.setSelectedItem(), so it
        // must not be shadowed by reading chooser.selectedItem directly here:
        // Obsidian can mutate that field on its own (e.g. during its internal
        // suggestion re-rendering) without going through our hook, which would
        // otherwise desync the highlighted row from what onOpen() established.
        const currentSuggestions = this.getSuggestions(this.inputEl?.value ?? '');
        const index = Math.max(0, Math.min(this.highlightedIndex, currentSuggestions.length - 1));
        return currentSuggestions[index] ?? currentSuggestions[0];
    }

    public handleSpace(): void {
        const item = this.getHighlightedItem();
        if (item) {
            this.toggleRow(item);
        }
    }

    /**
     * Shared execution used by both Enter and the action button. Acts on
     * exactly the checked rows. The highlighted row is only a cursor: an
     * unchecked row is never acted on, and with nothing checked the modal stays
     * open and a toast says so.
     */
    public executeCollection(): void {
        const checked = this.getCheckedRows();
        if (checked.length === 0) {
            new Notice(this.nothingCheckedNotice);
            return;
        }
        this.onPick(checked.length === 1 ? checked[0] : checked);
        this.close();
    }
    public buildChoices(): CollectChoice[] {
        // Suggestion list contains strictly selectable targets.
        // It never gains, loses, reorders, or resizes when selection changes.
        return [...this.rows];
    }

    /**
     * What typing in the filter searches for a row: the titles of the tabs it
     * covers, its window number and its HERE/MAIN words. Never counts or
     * "N to close" text, which a user would not think to type.
     */
    private rowSearchParts(row: CollectChoice): SearchPart[] {
        if (row.kind === 'all') return [{ text: row.label }];
        const winInfo = row.kind === 'scope' ? row.winInfo : row.winInfo;
        const parts: SearchPart[] = [];
        if (winInfo) {
            const index = row.kind === 'scope' ? row.badge : String(row.windowIndex);
            parts.push({ text: `Window ${index}` });
            const status = row.kind === 'scope'
                ? statusWords(row.status)
                : [
                    ...(row.kind === 'current' ? ['here'] : []),
                    ...(winInfo.isMainWindow ? ['main'] : []),
                ];
            for (const word of status) parts.push({ text: word });
        } else {
            parts.push({ text: row.label });
        }
        const titles = row.kind === 'scope' && row.searchTitles
            ? row.searchTitles
            : winInfo
                ? (winInfo.groups ?? []).flatMap((g) => (g.leaves ?? []).filter((l) => !isLeafDetached(l)).map((l) => l.getDisplayText()))
                : [];
        for (const title of uniqueTitles(titles)) parts.push({ text: title, show: true });
        return parts;
    }

    getSuggestions(query: string): CollectChoice[] {
        const choices = this.buildChoices();
        if (!query.trim()) return choices;
        return choices.filter((c) => matchParts(query, this.rowSearchParts(c)).length > 0);
    }
    renderSuggestion(choice: CollectChoice, el: HTMLElement): void {
        el.empty();
        el.addClass('ntg-nav-row');
        el.addClass('ntg-collect-row');
        el.addClass('ntg-grid-row');

        // Mouse hover previews the row (and its windows) until the mouse leaves.
        el.addEventListener('mouseenter', () => this.setHoveredRow(choice));
        el.addEventListener('mouseleave', () => { if (this.hovered === choice) this.setHoveredRow(null); });

        // Mouse clicks anywhere on a window row toggle checked state without closing modal
        el.addEventListener(
            'click',
            (evt: MouseEvent) => {
                evt.preventDefault();
                evt.stopPropagation();
                evt.stopImmediatePropagation();
                this.toggleRow(choice);
            },
            true,
        );

        if (choice.checked) {
            el.addClass('ntg-checked');
            el.addClass('is-checked');
            if (el.parentElement?.classList.contains('suggestion-item')) {
                el.parentElement.addClass('ntg-checked');
                el.parentElement.addClass('is-checked');
            }
        } else {
            el.removeClass('ntg-checked');
            el.removeClass('is-checked');
            if (el.parentElement?.classList.contains('suggestion-item')) {
                el.parentElement.removeClass('ntg-checked');
                el.parentElement.removeClass('is-checked');
            }
        }

        const isCurrent = choice === this.getHighlightedItem();
        if (isCurrent) {
            el.addClass('is-selected');
            el.addClass('ntg-keyboard-current');
            if (el.parentElement?.classList.contains('suggestion-item')) {
                el.parentElement.addClass('is-selected');
                el.parentElement.addClass('ntg-keyboard-current');
            }
        } else {
            el.removeClass('is-selected');
            el.removeClass('ntg-keyboard-current');
            if (el.parentElement?.classList.contains('suggestion-item')) {
                el.parentElement.removeClass('is-selected');
                el.parentElement.removeClass('ntg-keyboard-current');
            }
        }

        // Column 1 - Checkbox column (fixed width)
        const colCheckbox = el.createSpan({ cls: 'ntg-col-checkbox' });
        const checkbox = colCheckbox.createEl('input', {
            type: 'checkbox',
            cls: 'ntg-checkbox collect-tabs-row-checkbox',
        }) as HTMLInputElement;
        checkbox.checked = choice.checked;
        checkbox.disabled = true;

        // Column 2 - Graphical Tag Badge (fixed width & height, unadorned digit or glyph)
        const colBadge = el.createSpan({ cls: 'ntg-col-badge' });
        const badge = colBadge.createSpan({ cls: 'ntg-window-badge' });

        if (choice.kind === 'all') {
            badge.addClass('ntg-badge-all');
            badge.createSpan({ cls: 'ntg-badge-glyph', text: '⧉' });
        } else if (choice.kind === 'scope') {
            badge.setText(choice.badge);
        } else {
            badge.setText(String(choice.windowIndex));
        }

        // Column 3 - Description column (structured tab titles or "All windows")
        const colContent = el.createSpan({ cls: 'ntg-col-content' });
        colContent.title = choice.label;
        if (choice.kind === 'scope' && choice.items?.length) colContent.addClass('ntg-col-content-multiline');

        if (choice.kind === 'all') {
            colContent.createSpan({ cls: 'ntg-desc-primary', text: 'All windows' });
        } else if (choice.kind === 'scope') {
            colContent.createSpan({ cls: 'ntg-desc-primary', text: choice.label });
            if (choice.detail) {
                colContent.createSpan({ cls: 'ntg-desc-count', text: choice.detail });
            }
            if (choice.items && choice.items.length > 0) {
                const maxItems = 6;
                const list = colContent.createDiv({ cls: 'ntg-scope-items' });
                for (const item of choice.items.slice(0, maxItems)) {
                    list.createDiv({ cls: `ntg-scope-item ntg-scope-item-${item.kind}`, text: (item.kind === 'close' ? '✕ ' : '✓ keeps ') + item.text });
                }
                if (choice.items.length > maxItems) {
                    list.createDiv({ cls: 'ntg-scope-item ntg-scope-item-more', text: `+${choice.items.length - maxItems} more` });
                }
            }
        } else {
            const details = getWindowTabDetails(choice.winInfo);
            colContent.createSpan({ cls: 'ntg-desc-primary', text: details.primaryTitle });

            if (details.secondaryTitle) {
                colContent.createSpan({ cls: 'ntg-desc-separator', text: '·' });
                colContent.createSpan({ cls: 'ntg-desc-secondary', text: details.secondaryTitle });
            }

            if (details.remainingCount !== undefined && details.remainingCount > 0) {
                colContent.createSpan({ cls: 'ntg-desc-count', text: `+${details.remainingCount}` });
            }
        }

        // While filtering, list the matching tab titles this row does not already
        // show, so a row never appears for a reason the user cannot see.
        const query = this.inputEl?.value ?? '';
        if (query.trim()) {
            const shownTitles: string[] = [];
            if (choice.kind === 'scope') {
                shownTitles.push(...(choice.items ?? []).map((i) => i.text));
            } else if (choice.kind !== 'all') {
                const d = getWindowTabDetails(choice.winInfo);
                shownTitles.push(d.primaryTitle, ...(d.secondaryTitle ? [d.secondaryTitle] : []));
            }
            renderMatchingTitles(
                el,
                matchParts(query, this.rowSearchParts(choice)),
                (title) => shownTitles.some((s) => s === truncateTitle(title) || s.startsWith(title)),
            );
        }

        // Column 4 - Status column (fixed width, HERE, MAIN, HERE · MAIN, or empty)
        const colStatus = el.createSpan({ cls: 'ntg-col-status' });
        if (choice.kind === 'scope') {
            if (choice.status) {
                const cls = choice.status === 'HERE · MAIN' ? 'ntg-pill-here-main' : choice.status === 'MAIN' ? 'ntg-pill-main' : 'ntg-pill-here';
                colStatus.createSpan({ cls: `ntg-status-pill ${cls}`, text: choice.status });
            }
        } else if (choice.kind !== 'all') {
            const isMainWin = Boolean(
                choice.winInfo.isMainWindow
            );
            if (choice.kind === 'current') {
                if (isMainWin) {
                    colStatus.createSpan({ cls: 'ntg-status-pill ntg-pill-here-main', text: 'HERE · MAIN' });
                } else {
                    colStatus.createSpan({ cls: 'ntg-status-pill ntg-pill-here', text: 'HERE' });
                }
            } else if (isMainWin) {
                colStatus.createSpan({ cls: 'ntg-status-pill ntg-pill-main', text: 'MAIN' });
            }
        }
    }

    selectSuggestion(value: CollectChoice, evt: MouseEvent | KeyboardEvent): void {
        if (evt instanceof MouseEvent || (evt as any)?.type === 'click') {
            this.toggleRow(value);
            return;
        }

        super.selectSuggestion(value, evt);
    }

    onChooseSuggestion(_choice: CollectChoice, _evt?: MouseEvent | KeyboardEvent): void {
        // Enter on the cursor row must not act on an unchecked row.
        this.executeCollection();
    }
}

