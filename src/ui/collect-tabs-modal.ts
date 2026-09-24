import { App, SuggestModal } from 'obsidian';
import { registerEmacsMotionKeys } from '../utils/modal';
import type { WindowInfo } from '../../main';

export type CollectChoice =
    | { kind: 'current'; winInfo: WindowInfo; label: string; checked: boolean }
    | { kind: 'all'; label: string; checked: boolean }
    | { kind: 'window'; winInfo: WindowInfo; label: string; checked: boolean }
    | { kind: 'check-all'; label: string }
    | { kind: 'clear-selection'; label: string };

export function describeWindow(winInfo: WindowInfo): string {
    const repTitle = winInfo.representative.getDisplayText() || 'Untitled';
    const totalTabs = winInfo.groups.reduce((acc, g) => acc + g.leaves.length, 0);
    return totalTabs > 1 ? `${repTitle}, +${totalTabs - 1} more` : repTitle;
}

export class CollectTabsModal extends SuggestModal<CollectChoice> {
    private currentRow: CollectChoice & { kind: 'current' };
    private allRow: CollectChoice & { kind: 'all' };
    private windowRows: Array<CollectChoice & { kind: 'window' }>;
    private otherWindowsCount: number;
    private onPick: (choice: CollectChoice | CollectChoice[]) => void;

    constructor(
        app: App,
        currentWindow: WindowInfo,
        otherWindows: WindowInfo[],
        onPick: (choice: CollectChoice | CollectChoice[]) => void,
    ) {
        super(app);
        this.onPick = onPick;
        this.otherWindowsCount = otherWindows.length;

        // Section 3: Consistent row order at every window count
        // 1. "This window" row - always first
        this.currentRow = {
            kind: 'current',
            winInfo: currentWindow,
            label: `This window - ${describeWindow(currentWindow)}`,
            checked: false,
        };

        // 2. "All windows" row - always second, and always present
        this.allRow = {
            kind: 'all',
            label: 'All windows',
            checked: false,
        };

        // 3. One row per other window, ordered by most-recently-focused first
        this.windowRows = otherWindows.map((w) => ({
            kind: 'window' as const,
            winInfo: w,
            label: `Window - ${describeWindow(w)}`,
            checked: false,
        }));

        this.setPlaceholder('Collect tabs from...');
        this.setInstructions([
            { command: '↑↓', purpose: 'navigate' },
            { command: 'space', purpose: 'toggle' },
            { command: '↵', purpose: 'collect' },
            { command: 'esc', purpose: 'cancel' },
        ]);
    }

    onOpen(): void {
        super.onOpen();
        registerEmacsMotionKeys(this);

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

    public checkAll(): void {
        this.currentRow.checked = true;
        this.allRow.checked = true;
        for (const w of this.windowRows) {
            w.checked = true;
        }
        this.refreshSuggestions();
    }

    public clearSelection(): void {
        this.currentRow.checked = false;
        this.allRow.checked = false;
        for (const w of this.windowRows) {
            w.checked = false;
        }
        this.refreshSuggestions();
    }

    public toggleRow(choice: CollectChoice): void {
        if (choice.kind === 'check-all') {
            this.checkAll();
        } else if (choice.kind === 'clear-selection') {
            this.clearSelection();
        } else {
            choice.checked = !choice.checked;
            this.refreshSuggestions();
        }
    }

    public getHighlightedItem(): CollectChoice | undefined {
        const chooser = (this as any).chooser;
        const currentSuggestions = this.getSuggestions(this.inputEl?.value ?? '');
        if (chooser && typeof chooser.selectedItem === 'number') {
            const index = Math.max(0, Math.min(chooser.selectedItem, currentSuggestions.length - 1));
            return currentSuggestions[index];
        }
        return currentSuggestions[0];
    }

    public handleSpace(): void {
        const item = this.getHighlightedItem();
        if (item) {
            this.toggleRow(item);
        }
    }

    private refreshSuggestions(): void {
        const chooser = (this as any).chooser;
        const prevIndex = typeof chooser?.selectedItem === 'number' ? chooser.selectedItem : undefined;

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
    }

    public buildChoices(): CollectChoice[] {
        const list: CollectChoice[] = [
            this.currentRow,
            this.allRow,
            ...this.windowRows,
        ];

        // "Check all windows" appears only when there are at least 3 real window rows above it
        // (i.e. otherWindows.length >= 2, meaning 3+ total open windows).
        if (this.otherWindowsCount >= 2) {
            list.push({
                kind: 'check-all',
                label: 'Check all windows',
            });
        }

        // "Clear selection" appears only while at least one row somewhere above it is currently checked.
        if (this.hasAnyChecked()) {
            list.push({
                kind: 'clear-selection',
                label: 'Clear selection',
            });
        }

        return list;
    }

    getSuggestions(query: string): CollectChoice[] {
        const choices = this.buildChoices();
        const q = query.trim().toLowerCase();
        if (!q) return choices;
        return choices.filter((c) => c.label.toLowerCase().includes(q));
    }

    renderSuggestion(choice: CollectChoice, el: HTMLElement): void {
        el.empty();
        el.addClass('ntg-nav-row');
        el.addClass('ntg-collect-row');

        if (choice.kind === 'check-all' || choice.kind === 'clear-selection') {
            el.removeClass('ntg-checked');
            el.removeClass('is-checked');
            el.addClass('ntg-control-row');
            if (choice.kind === 'check-all' || (choice.kind === 'clear-selection' && this.otherWindowsCount < 2)) {
                el.addClass('ntg-control-separator');
            }
            el.createSpan({ cls: 'ntg-action-label', text: choice.label });
            return;
        }

        if (choice.checked) {
            el.addClass('ntg-checked');
            el.addClass('is-checked');
        } else {
            el.removeClass('ntg-checked');
            el.removeClass('is-checked');
        }

        const checkbox = el.createEl('input', {
            type: 'checkbox',
            cls: 'ntg-checkbox collect-tabs-row-checkbox',
        }) as HTMLInputElement;
        checkbox.checked = choice.checked;
        checkbox.disabled = true;

        el.createSpan({ cls: 'ntg-row-label', text: choice.label });
    }

    selectSuggestion(value: CollectChoice, evt: MouseEvent | KeyboardEvent): void {
        if (value.kind === 'check-all') {
            this.checkAll();
            return;
        }
        if (value.kind === 'clear-selection') {
            this.clearSelection();
            return;
        }
        super.selectSuggestion(value, evt);
    }

    onChooseSuggestion(choice: CollectChoice, _evt?: MouseEvent | KeyboardEvent): void {
        if (choice.kind === 'check-all') {
            this.checkAll();
            return;
        }
        if (choice.kind === 'clear-selection') {
            this.clearSelection();
            return;
        }

        const checked = this.getCheckedRows();
        if (checked.length > 0) {
            this.onPick(checked);
        } else {
            this.onPick(choice);
        }
    }
}
