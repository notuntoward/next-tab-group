import { App, Notice, SuggestModal, WorkspaceLeaf } from 'obsidian';
import { registerEmacsMotionKeys } from '../utils/modal';
import type { WindowInfo } from '../../main';

export type CollectChoice =
    | { kind: 'current'; winInfo: WindowInfo; label: string; checked: boolean; windowIndex: number }
    | { kind: 'all'; label: string; checked: boolean }
    | { kind: 'window'; winInfo: WindowInfo; label: string; checked: boolean; windowIndex: number };

const sessionWindowIndices = new Map<Window | object, number>();
let nextSessionIndex = 2; // 1 is reserved for the main window

export function resetSessionWindowIndices(): void {
    sessionWindowIndices.clear();
    nextSessionIndex = 2;
}

export function getSessionWindowIndex(winInfo: WindowInfo): number {
    const isMain = winInfo.isMainWindow || (typeof window !== 'undefined' && winInfo.window === window);
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
                    if (l && !(l as any).detached) {
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

    private currentRow: CollectChoice & { kind: 'current' };
    private allRow: CollectChoice & { kind: 'all' };
    private windowRows: Array<CollectChoice & { kind: 'window' }>;
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
        currentWindow: WindowInfo,
        otherWindows: WindowInfo[],
        onPick: (choice: CollectChoice | CollectChoice[]) => void,
    ) {
        super(app);
        this.onPick = onPick;

        // Clean row content with no prefix text; status is conveyed by the badge & column grid
        const currentIdx = getSessionWindowIndex(currentWindow);
        this.currentRow = {
            kind: 'current',
            winInfo: currentWindow,
            label: describeWindow(currentWindow),
            checked: false,
            windowIndex: currentIdx,
        };

        this.allRow = {
            kind: 'all',
            label: 'All windows',
            checked: false,
        };

        this.windowRows = otherWindows.map((w) => {
            const idx = getSessionWindowIndex(w);
            return {
                kind: 'window' as const,
                winInfo: w,
                label: describeWindow(w),
                checked: false,
                windowIndex: idx,
            };
        });

        // Filter and instructions hierarchy:
        // 1. Filter input
        // 2. Window list
        // 3. Action toolbar
        // 4. Keyboard hints
        this.setPlaceholder('Filter windows…');
        this.setInstructions([
            { command: '↑↓', purpose: 'navigate' },
            { command: 'space', purpose: 'toggle' },
            { command: '↵', purpose: 'collect' },
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

        const active = (this.modalEl?.ownerDocument || document).activeElement as HTMLElement | null;
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
            if (typeof chooser.setSelectedItem === 'function') {
                chooser.setSelectedItem(target, true);
            }
        }

        this.updateHighlightVisuals();
    }

    public moveHighlight(delta: number): void {
        const chooser = (this as any).chooser;
        const current = typeof chooser?.selectedItem === 'number' ? chooser.selectedItem : this.highlightedIndex;
        this.setHighlightedIndex(current + delta);
    }

    public updateHighlightVisuals(): void {
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
        rowItems.forEach((row, i) => {
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
            CollectTabsModal.activeModal.isOpen
        ) {
            try {
                CollectTabsModal.activeModal.close();
            } catch {
                // ignore
            }
            new Notice('Existing collect-tabs command cancelled');
        }
        this.isOpen = true;
        CollectTabsModal.activeModal = this;
        super.open();
    }

    onOpen(): void {
        super.onOpen();
        if (this.containerEl) {
            this.containerEl.addClass('ntg-collect-modal-container');
        }

        if (this.modalEl) {
            this.modalEl.addClass('ntg-collect-modal');

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
            if (typeof window !== 'undefined') {
                window.setTimeout(removeRedundantX, 0);
                window.setTimeout(removeRedundantX, 50);
            }

            // Find prompt or modal container to place persistent action toolbar above keyboard hints
            const promptEl = (this.modalEl.querySelector('.prompt') as HTMLElement) ?? this.modalEl;
            const instructionsEl = promptEl.querySelector('.prompt-instructions');

            // Build persistent footer toolbar with stable opposite groups
            this.toolbarEl = document.createElement('div');
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
                text: 'Collect',
                attr: { type: 'button' },
            });
            this.collectBtn.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                this.executeCollection();
            });

            if (instructionsEl) {
                promptEl.insertBefore(this.toolbarEl, instructionsEl);
            } else {
                promptEl.appendChild(this.toolbarEl);
            }

            // Tab / Shift+Tab and Space key handling
            this.handleKeyDown = (evt: KeyboardEvent) => {
                if (evt.key === 'Tab') {
                    this.handleTabNavigation(evt);
                    return;
                }

                if (evt.key === ' ' || evt.code === 'Space') {
                    const active = (this.modalEl?.ownerDocument || document).activeElement as HTMLElement | null;
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

        if (this.inputEl) {
            this.inputEl.addEventListener('keydown', (evt: KeyboardEvent) => {
                if (evt.key === ' ' || evt.code === 'Space') {
                    evt.preventDefault();
                    evt.stopPropagation();
                    this.handleSpace();
                }
            }, true);
        }

        // Hook chooser.setSelectedItem if present
        const chooser = (this as any).chooser;
        if (chooser) {
            const orig = chooser.setSelectedItem?.bind(chooser);
            chooser.setSelectedItem = (index: number, scroll?: boolean) => {
                if (orig) orig(index, scroll);
                else chooser.selectedItem = index;
                this.highlightedIndex = index;
                this.updateHighlightVisuals();
            };
        }

        // Initialize keyboard-current highlight to index 0 (the HERE row)
        this.setHighlightedIndex(0);

        registerEmacsMotionKeys(this);

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

        this.scope.register([], ' ', (evt) => {
            evt.preventDefault();
            this.handleSpace();
            return false;
        });

        this.scope.register([], 'Space', (evt) => {
            evt.preventDefault();
            this.handleSpace();
            return false;
        });
    }

    onClose(): void {
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
        const hasChecked = this.hasAnyChecked();
        if (this.clearSelectionBtn) {
            this.clearSelectionBtn.disabled = !hasChecked;
            this.clearSelectionBtn.style.display = hasChecked ? '' : 'none';
        }
    }

    public hasAnyChecked(): boolean {
        return this.currentRow.checked || this.allRow.checked || this.windowRows.some((w) => w.checked);
    }

    public getCheckedRows(): CollectChoice[] {
        const list: CollectChoice[] = [];
        if (this.currentRow.checked) list.push(this.currentRow);
        if (this.allRow.checked) list.push(this.allRow);
        for (const w of this.windowRows) {
            if (w.checked) list.push(w);
        }
        return list;
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
        this.currentRow.checked = true;
        this.allRow.checked = true;
        for (const w of this.windowRows) {
            w.checked = true;
        }
        this.syncAllRowVisuals();
        this.updateToolbarState();
    }

    public clearSelection(): void {
        this.currentRow.checked = false;
        this.allRow.checked = false;
        for (const w of this.windowRows) {
            w.checked = false;
        }
        this.syncAllRowVisuals();
        this.updateToolbarState();
        const active = (this.modalEl?.ownerDocument || document).activeElement;
        if (active === this.clearSelectionBtn) {
            if (this.selectAllBtn) {
                this.selectAllBtn.focus();
            } else {
                this.inputEl.focus();
            }
        }
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
        const chooser = (this as any).chooser;
        const currentSuggestions = this.getSuggestions(this.inputEl?.value ?? '');
        if (chooser && typeof chooser.selectedItem === 'number') {
            const index = Math.max(0, Math.min(chooser.selectedItem, currentSuggestions.length - 1));
            return currentSuggestions[index];
        }
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
     * Shared collection execution method used by both Enter key and Collect button.
     * 1. If one or more rows are checked -> collects checked set.
     * 2. If nothing is checked -> collects highlighted default row.
     */
    public executeCollection(fallbackChoice?: CollectChoice): void {
        const checked = this.getCheckedRows();
        if (checked.length > 0) {
            this.onPick(checked);
            this.close();
            return;
        }

        const target = fallbackChoice ?? this.getHighlightedItem() ?? this.currentRow;
        this.onPick(target);
        this.close();
    }

    /** Backward-compatible alias for executeCollection */
    public executeCollect(): void {
        this.executeCollection();
    }

    private refreshSuggestions(): void {
        const chooser = (this as any).chooser;
        const prevIndex = typeof chooser?.selectedItem === 'number' ? chooser.selectedItem : this.highlightedIndex;

        if (typeof (this as any).updateSuggestions === 'function') {
            (this as any).updateSuggestions();
        } else if (this.inputEl && typeof this.inputEl.dispatchEvent === 'function') {
            this.inputEl.dispatchEvent(new Event('input'));
        }

        const newSuggestions = this.getSuggestions(this.inputEl?.value ?? '');
        if (chooser) {
            chooser.values = newSuggestions;
            if (typeof chooser.setSelectedItem === 'function' && typeof prevIndex === 'number') {
                const target = Math.max(0, Math.min(prevIndex, newSuggestions.length - 1));
                chooser.setSelectedItem(target, true);
            }
        }
        this.setHighlightedIndex(prevIndex);
    }

    public buildChoices(): CollectChoice[] {
        // Suggestion list contains strictly selectable targets.
        // It never gains, loses, reorders, or resizes when selection changes.
        return [
            this.currentRow,
            this.allRow,
            ...this.windowRows,
        ];
    }

    getSuggestions(query: string): CollectChoice[] {
        const choices = this.buildChoices();
        const q = query.trim().toLowerCase();
        if (!q) return choices;
        return choices.filter((c) => {
            if (c.label.toLowerCase().includes(q)) return true;
            if (c.kind === 'current' || c.kind === 'window') {
                if (String(c.windowIndex) === q) return true;
            }
            return false;
        });
    }

    renderSuggestion(choice: CollectChoice, el: HTMLElement): void {
        el.empty();
        el.addClass('ntg-nav-row');
        el.addClass('ntg-collect-row');
        el.addClass('ntg-grid-row');

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
        } else {
            badge.setText(String(choice.windowIndex));
        }

        // Column 3 - Description column (structured tab titles or "All windows")
        const colContent = el.createSpan({ cls: 'ntg-col-content' });
        colContent.title = choice.label;

        if (choice.kind === 'all') {
            colContent.createSpan({ cls: 'ntg-desc-primary', text: 'All windows' });
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

        // Column 4 - Status column (fixed width, HERE, MAIN, HERE · MAIN, or empty)
        const colStatus = el.createSpan({ cls: 'ntg-col-status' });
        if (choice.kind !== 'all') {
            const isMainWin = Boolean(
                choice.winInfo.isMainWindow ||
                (typeof window !== 'undefined' && choice.winInfo.window === window)
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

    onChooseSuggestion(choice: CollectChoice, _evt?: MouseEvent | KeyboardEvent): void {
        this.executeCollection(choice);
    }
}

