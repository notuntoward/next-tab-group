import { App, SuggestModal } from 'obsidian';
import { registerEmacsMotionKeys } from '../utils/modal';
import type { WindowInfo } from '../../main';

export type CollectChoice =
    | { kind: 'current'; winInfo: WindowInfo; label: string }
    | { kind: 'all'; label: string }
    | { kind: 'window'; winInfo: WindowInfo; label: string };

export function describeWindow(winInfo: WindowInfo): string {
    const repTitle = winInfo.representative.getDisplayText() || 'Untitled';
    const totalTabs = winInfo.groups.reduce((acc, g) => acc + g.leaves.length, 0);
    return totalTabs > 1 ? `${repTitle}, +${totalTabs - 1} more` : repTitle;
}

export class CollectTabsModal extends SuggestModal<CollectChoice> {
    private choices: CollectChoice[];
    private onPick: (choice: CollectChoice) => void;

    constructor(
        app: App,
        currentWindow: WindowInfo,
        otherWindows: WindowInfo[],
        onPick: (choice: CollectChoice) => void,
    ) {
        super(app);
        this.onPick = onPick;

        if (otherWindows.length === 1) {
            // N = 2: Exactly one main window and one popup window.
            // Only possible options for merging are "this window" or "all windows".
            this.choices = [
                {
                    kind: 'current',
                    winInfo: currentWindow,
                    label: `This window - ${describeWindow(currentWindow)}`,
                },
                {
                    kind: 'all',
                    label: 'All windows',
                },
            ];
        } else {
            // N > 2: First "all windows", then each of the N-1 windows not in focus.
            this.choices = [
                {
                    kind: 'all',
                    label: 'All windows',
                },
                ...otherWindows.map((w) => ({
                    kind: 'window' as const,
                    winInfo: w,
                    label: `Window - ${describeWindow(w)}`,
                })),
            ];
        }

        this.setPlaceholder('Collect tabs from...');
        this.setInstructions([
            { command: '↑↓', purpose: 'navigate' },
            { command: '↵', purpose: 'collect' },
            { command: 'esc', purpose: 'cancel' },
        ]);
    }

    onOpen(): void {
        super.onOpen();
        registerEmacsMotionKeys(this);
    }

    getSuggestions(query: string): CollectChoice[] {
        const q = query.trim().toLowerCase();
        if (!q) return this.choices;
        return this.choices.filter((c) => c.label.toLowerCase().includes(q));
    }

    renderSuggestion(choice: CollectChoice, el: HTMLElement): void {
        el.empty();
        el.addClass('ntg-nav-row');
        el.createSpan({ text: choice.label });
    }

    onChooseSuggestion(choice: CollectChoice, _evt: MouseEvent | KeyboardEvent): void {
        this.onPick(choice);
    }
}
