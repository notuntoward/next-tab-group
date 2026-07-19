import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
} from './mocks/obsidian';

type TestPlugin = NextTabGroupPlugin & {
    getTabGroupMeta: (tab: TabInfo) => string;
    getTabSearchText: (tab: TabInfo) => string;
    renderTabGroupSuggestion: (group: TabGroupInfo, el: HTMLElement) => void;
    renderWindowSuggestion: (item: WindowInfo, el: HTMLElement) => void;
};

interface TabGroupInfo {
    group: MockWorkspaceParent;
    leaves: WorkspaceLeaf[];
    representative: WorkspaceLeaf;
    lastActive: number;
    label: string;
    relativeLabel: string | null;
    isCurrentGroup: boolean;
    window: Window | undefined;
}

interface WindowInfo {
    window: Window | undefined;
    groups: TabGroupInfo[];
    representative: WorkspaceLeaf;
    lastActive: number;
    label: string;
    isCurrentWindow: boolean;
}

interface TabInfo {
    leaf: WorkspaceLeaf;
    group: TabGroupInfo;
    lastActive: number;
}

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

// Obsidian augments HTMLElement with empty()/addClass()/createDiv()/setText().
// jsdom lacks them, so build a thin wrapper that delegates to real DOM.
type AugmentedEl = HTMLElement & {
    empty(): void;
    addClass(cls: string): void;
    setText(text: string): void;
    createDiv(opts: { cls: string }): AugmentedEl;
};

function augment(el: HTMLElement): AugmentedEl {
    const a = el as AugmentedEl;
    a.empty = function (this: HTMLElement) {
        while (this.firstChild) this.removeChild(this.firstChild);
    };
    a.addClass = function (this: HTMLElement, cls: string) {
        this.classList.add(cls);
    };
    a.setText = function (this: HTMLElement, text: string) {
        this.textContent = text;
    };
    a.createDiv = function (this: HTMLElement, opts: { cls: string }) {
        const child = document.createElement('div');
        child.classList.add(opts.cls);
        this.appendChild(child);
        return augment(child);
    };
    return a;
}

function rowEl(): AugmentedEl {
    return augment(document.createElement('div'));
}

function makeGroup(
    container: MockWorkspaceContainer,
    opts: {
        leaves: MockWorkspaceLeaf[];
        isCurrentGroup: boolean;
        relativeLabel: string | null;
        representative?: MockWorkspaceLeaf;
    },
): TabGroupInfo {
    const group = new MockWorkspaceParent(container);
    for (const leaf of opts.leaves) leaf.setParent(group);
    return {
        group,
        leaves: opts.leaves,
        representative: opts.representative ?? opts.leaves[0],
        lastActive: 0,
        label: `${opts.isCurrentGroup ? 'Current group — ' : ''}Representative · ${opts.leaves.length} tabs`,
        relativeLabel: opts.relativeLabel,
        isCurrentGroup: opts.isCurrentGroup,
        window: container.win,
    };
}

describe('tab group row metadata', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;

    beforeEach(() => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', window);
        plugin = createPlugin(app);
    });

    it('uses current group plus count for the current group', () => {
        const leaves = [
            new MockWorkspaceLeaf('A.md').setId('a'),
            new MockWorkspaceLeaf('B.md').setId('b'),
            new MockWorkspaceLeaf('C.md').setId('c'),
        ];
        const group = makeGroup(container, { leaves, isCurrentGroup: true, relativeLabel: null });

        const el = rowEl();
        plugin.renderTabGroupSuggestion(group, el);

        const primary = el.querySelector('.ntg-nav-primary')!.textContent;
        const secondary = el.querySelector('.ntg-nav-secondary')!.textContent;
        expect(primary).toBe('A.md');
        expect(secondary).toBe('Current group · 3 tabs');
    });

    it('uses relative label plus count for a non-current group', () => {
        const leaves = [new MockWorkspaceLeaf('Only.md').setId('only')];
        const group = makeGroup(container, { leaves, isCurrentGroup: false, relativeLabel: 'Right group' });

        const el = rowEl();
        plugin.renderTabGroupSuggestion(group, el);

        const secondary = el.querySelector('.ntg-nav-secondary')!.textContent;
        expect(secondary).toBe('Right group · 1 tab');
    });

    it('falls back to Other group when no relative label exists', () => {
        const leaves = [
            new MockWorkspaceLeaf('A.md').setId('a'),
            new MockWorkspaceLeaf('B.md').setId('b'),
        ];
        const group = makeGroup(container, { leaves, isCurrentGroup: false, relativeLabel: null });

        const el = rowEl();
        plugin.renderTabGroupSuggestion(group, el);

        const secondary = el.querySelector('.ntg-nav-secondary')!.textContent;
        expect(secondary).toBe('Other group · 2 tabs');
    });
});

describe('window row metadata', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;

    beforeEach(() => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', window);
        plugin = createPlugin(app);
    });

    it('renders the main window with most-recent tab and group count', () => {
        const rep = new MockWorkspaceLeaf('Note-02.md').setId('rep');
        const group = makeGroup(container, { leaves: [rep], isCurrentGroup: true, relativeLabel: null });
        const item: WindowInfo = {
            window: window,
            groups: [group, group],
            representative: rep as unknown as WorkspaceLeaf,
            lastActive: 0,
            label: 'Main window',
            isCurrentWindow: true,
        };

        const el = rowEl();
        plugin.renderWindowSuggestion(item, el);

        const primary = el.querySelector('.ntg-nav-primary')!.textContent;
        const secondary = el.querySelector('.ntg-nav-secondary')!.textContent;
        expect(primary).toBe('Main window');
        expect(secondary).toBe('Most recent: Note-02.md · 2 groups');
    });

    it('renders a pop-out with most-recent tab and group count', () => {
        const rep = new MockWorkspaceLeaf('Other.md').setId('rep');
        const group = makeGroup(container, { leaves: [rep], isCurrentGroup: false, relativeLabel: 'Left group' });
        const item: WindowInfo = {
            window: {} as Window,
            groups: [group],
            representative: rep as unknown as WorkspaceLeaf,
            lastActive: 0,
            label: 'Pop-out',
            isCurrentWindow: false,
        };

        const el = rowEl();
        plugin.renderWindowSuggestion(item, el);

        const primary = el.querySelector('.ntg-nav-primary')!.textContent;
        const secondary = el.querySelector('.ntg-nav-secondary')!.textContent;
        expect(primary).toBe('Pop-out');
        expect(secondary).toBe('Most recent: Other.md · 1 group');
    });
});

describe('search text remains richer than display text', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;

    beforeEach(() => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', window);
        plugin = createPlugin(app);
    });

    it('tab search text includes the full group label', () => {
        const a = new MockWorkspaceLeaf('A.md').setId('a');
        const b = new MockWorkspaceLeaf('B.md').setId('b');
        const group = makeGroup(container, { leaves: [a, b], isCurrentGroup: true, relativeLabel: null });
        const tab: TabInfo = { leaf: a as unknown as WorkspaceLeaf, group, lastActive: 0 };

        const text = plugin.getTabSearchText(tab);
        expect(text).toContain('A.md');
        expect(text).toContain(group.label);
        expect(text).toContain('Representative');
    });
});
