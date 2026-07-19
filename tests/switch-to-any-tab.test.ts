import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
    MockFuzzySuggestModal,
} from './mocks/obsidian';

type TestPlugin = NextTabGroupPlugin & {
    switchToAnyTab: () => void;
    getLeavesInFocusedWindow: () => WorkspaceLeaf[];
    buildNavigationModel: (activeLeaf: WorkspaceLeaf | null) => WorkspaceNavigationModel;
    buildTabGroupInfos: (leaves: WorkspaceLeaf[], activeLeaf: WorkspaceLeaf | null) => TabGroupInfo[];
    buildTabInfos: (groups: TabGroupInfo[]) => TabInfo[];
    getTabSearchText: (tab: TabInfo) => string;
    renderTabSuggestion: (tab: TabInfo, el: HTMLElement, labels: Map<Window | undefined, string>, showGroup: boolean, showWindow: boolean) => void;
    buildWindowLabels: (model: WorkspaceNavigationModel) => Map<Window | undefined, string>;
};

interface WorkspaceNavigationModel {
    locations: LeafLocation[];
    windows: WindowInfo[];
    groups: TabGroupInfo[];
    tabs: TabInfo[];
}

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

interface TabInfo {
    leaf: WorkspaceLeaf;
    group: TabGroupInfo;
    lastActive: number;
}

interface WindowInfo {
    window: Window | undefined;
    groups: TabGroupInfo[];
    representative: WorkspaceLeaf;
    lastActive: number;
    label: string;
    isCurrentWindow: boolean;
}

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

function leaf(
    id: string,
    file: string,
    parent: MockWorkspaceParent,
    container: MockWorkspaceContainer | null = null
): MockWorkspaceLeaf {
    const l = new MockWorkspaceLeaf(file).setId(id).setParent(parent);
    if (container) l.setContainer(container);
    return l;
}

function asLeaf(leaf: MockWorkspaceLeaf): WorkspaceLeaf {
    return leaf as unknown as WorkspaceLeaf;
}

interface LeafLocation {
    leaf: WorkspaceLeaf;
    window: Window | undefined;
    group: MockWorkspaceParent | null;
}

function loc(leaf: MockWorkspaceLeaf): LeafLocation {
    const container = leaf.getContainer() as unknown as { win?: Window } | null;
    return {
        leaf: leaf as unknown as WorkspaceLeaf,
        window: container?.win,
        group: (leaf.parent as MockWorkspaceParent) ?? null,
    };
}

// Obsidian augments HTMLElement with empty()/addClass()/createDiv()/setText(),
// which jsdom lacks. Build a thin wrapper that delegates to real DOM.
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

describe('switchToAnyTab', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let rootContainer: MockWorkspaceContainer;
    let windowContainer: MockWorkspaceContainer;

    beforeEach(() => {
        app = new MockApp();
        // Use the global `window` for the main container so the plugin's
        // `win === window` main-window check matches (as in real Obsidian).
        rootContainer = new MockWorkspaceContainer('root', globalThis.window);
        windowContainer = new MockWorkspaceContainer('window', {} as Window);
        plugin = createPlugin(app);
    });

    it('leaves in another window do not appear when a focused window is identifiable', () => {
        const groupMain = new MockWorkspaceParent(rootContainer);
        const groupWin = new MockWorkspaceParent(windowContainer);

        const mainA = leaf('mainA', 'Main-A.md', groupMain, rootContainer);
        const mainB = leaf('mainB', 'Main-B.md', groupMain, rootContainer);
        const winA = leaf('winA', 'Win-A.md', groupWin, windowContainer);

        app.workspace.rootLeaves = [mainA, mainB];
        app.workspace.allLeaves = [mainA, mainB, winA];
        app.workspace.setActiveLeaf(mainA);

        const leaves = plugin.getLeavesInFocusedWindow();
        expect(leaves.map((l) => (l as unknown as MockWorkspaceLeaf).id)).toEqual(['mainA', 'mainB']);
    });

    it('the fallback includes all leaves when focused-window identity is unavailable', () => {
        const groupMain = new MockWorkspaceParent(rootContainer);
        const groupWin = new MockWorkspaceParent(windowContainer);

        const mainA = leaf('mainA', 'Main-A.md', groupMain, rootContainer);
        const winA = leaf('winA', 'Win-A.md', groupWin, windowContainer);

        app.workspace.rootLeaves = [mainA];
        app.workspace.allLeaves = [mainA, winA];
        app.workspace.activeLeaf = null;

        const leaves = plugin.getLeavesInFocusedWindow();
        expect(leaves.map((l) => (l as unknown as MockWorkspaceLeaf).id)).toEqual(['mainA', 'winA']);
    });

    it('tabs sort newest-first', () => {
        const group = new MockWorkspaceParent(rootContainer);
        const older = leaf('older', 'Old.md', group, rootContainer);
        const newer = leaf('newer', 'New.md', group, rootContainer);
        plugin.leafLastActive.set('older', 100);
        plugin.leafLastActive.set('newer', 200);

        app.workspace.rootLeaves = [older, newer];
        app.workspace.allLeaves = [older, newer];
        app.workspace.setActiveLeaf(older);

        let captured: MockFuzzySuggestModal<TabInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<TabInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToAnyTab();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        expect(captured).toBeDefined();
        const items = captured!.getItems();
        expect(items[0].leaf).toBe(asLeaf(newer));
        expect(items[1].leaf).toBe(asLeaf(older));
    });

    it('keeps the active tab at its recency position (not pushed to the bottom)', () => {
        const group = new MockWorkspaceParent(rootContainer);
        const older = leaf('older', 'Old.md', group, rootContainer);
        const middle = leaf('middle', 'Mid.md', group, rootContainer);
        const active = leaf('active', 'Active.md', group, rootContainer);
        plugin.leafLastActive.set('older', 100);
        plugin.leafLastActive.set('middle', 200);
        plugin.leafLastActive.set('active', 300);

        app.workspace.rootLeaves = [older, middle, active];
        app.workspace.allLeaves = [older, middle, active];
        app.workspace.setActiveLeaf(active);

        let captured: MockFuzzySuggestModal<TabInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<TabInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToAnyTab();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        // Pure recency order: the active (most recent) tab stays at the top of
        // the list; the default selection (most recent non-active) is handled
        // by the modal's initial index, not by reordering.
        const items = captured!.getItems();
        expect((items[0].leaf as unknown as MockWorkspaceLeaf).id).toBe('active');
        expect((items[1].leaf as unknown as MockWorkspaceLeaf).id).toBe('middle');
        expect((items[2].leaf as unknown as MockWorkspaceLeaf).id).toBe('older');
    });

    it('each TabInfo references its correct TabGroupInfo', () => {
        const group1 = new MockWorkspaceParent(rootContainer);
        const group2 = new MockWorkspaceParent(rootContainer);
        const a = leaf('a', 'A.md', group1, rootContainer);
        const b = leaf('b', 'B.md', group2, rootContainer);

        app.workspace.rootLeaves = [a, b];
        app.workspace.allLeaves = [a, b];
        app.workspace.setActiveLeaf(a);

        let captured: MockFuzzySuggestModal<TabInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<TabInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToAnyTab();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        const items = captured!.getItems();
        const tabA = items.find((t) => (t.leaf as unknown as MockWorkspaceLeaf).id === 'a')!;
        const tabB = items.find((t) => (t.leaf as unknown as MockWorkspaceLeaf).id === 'b')!;
        expect(tabA.group.group).toBe(group1);
        expect(tabB.group.group).toBe(group2);
    });

    it('search text includes both tab title and group label', () => {
        const group1 = new MockWorkspaceParent(rootContainer);
        const group2 = new MockWorkspaceParent(rootContainer);
        const a = leaf('a', 'A.md', group1, rootContainer);
        const b = leaf('b', 'B.md', group2, rootContainer);
        plugin.leafLastActive.set('a', 100);
        plugin.leafLastActive.set('b', 200);

        app.workspace.rootLeaves = [a, b];
        app.workspace.allLeaves = [a, b];
        app.workspace.setActiveLeaf(a);

        const groups = plugin.buildTabGroupInfos([loc(a), loc(b)], asLeaf(a));
        const tabs = plugin.buildTabInfos(groups);
        const text = plugin.getTabSearchText(tabs[0]);
        expect(text).toContain('B.md');
        expect(text).toContain(groups[0].label);
    });

    it('choosing a tab activates exactly that leaf', () => {
        const group = new MockWorkspaceParent(rootContainer);
        const a = leaf('a', 'A.md', group, rootContainer);
        const b = leaf('b', 'B.md', group, rootContainer);

        app.workspace.rootLeaves = [a, b];
        app.workspace.allLeaves = [a, b];
        app.workspace.setActiveLeaf(a);

        let captured: MockFuzzySuggestModal<TabInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<TabInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToAnyTab();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        const items = captured!.getItems();
        const tabB = items.find((t) => (t.leaf as unknown as MockWorkspaceLeaf).id === 'b')!;
        captured!.onChooseItem(tabB);
        expect(app.workspace.activeLeaf).toBe(b);
    });

    it('lists tabs from every window, not just the focused one', () => {
        const groupMain = new MockWorkspaceParent(rootContainer);
        const groupWin = new MockWorkspaceParent(windowContainer);

        const mainA = leaf('mainA', 'Main-A.md', groupMain, rootContainer);
        const winA = leaf('winA', 'Win-A.md', groupWin, windowContainer);

        app.workspace.rootLeaves = [mainA];
        app.workspace.allLeaves = [mainA, winA];
        app.workspace.setActiveLeaf(mainA);

        let captured: MockFuzzySuggestModal<TabInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<TabInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToAnyTab();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        const ids = captured!.getItems().map((t) => (t.leaf as unknown as MockWorkspaceLeaf).id);
        expect(ids).toContain('mainA');
        expect(ids).toContain('winA');
    });

    it('starts with the most recent tab in the current window, not a more recent pop-out tab', () => {
        const groupMain = new MockWorkspaceParent(rootContainer);
        const groupWin = new MockWorkspaceParent(windowContainer);

        const mainA = leaf('mainA', 'Main-A.md', groupMain, rootContainer);
        const mainB = leaf('mainB', 'Main-B.md', groupMain, rootContainer);
        const winA = leaf('winA', 'Win-A.md', groupWin, windowContainer);

        // The pop-out tab is the most recently visited overall, but the user is
        // in the main window (active tab mainA), so the top item must be the
        // most recent main-window tab (mainB).
        plugin.leafLastActive.set('mainA', 100);
        plugin.leafLastActive.set('mainB', 300);
        plugin.leafLastActive.set('winA', 400);

        app.workspace.rootLeaves = [mainA, mainB];
        app.workspace.allLeaves = [mainA, mainB, winA];
        app.workspace.setActiveLeaf(mainA);

        let captured: MockFuzzySuggestModal<TabInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<TabInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToAnyTab();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        const items = captured!.getItems();
        expect((items[0].leaf as unknown as MockWorkspaceLeaf).id).toBe('mainB');
        // Active tab is demoted within the current-window block, so it sits
        // before any other-window tab (winA) and is not the last item.
        expect((items[1].leaf as unknown as MockWorkspaceLeaf).id).toBe('mainA');
        expect((items[items.length - 1].leaf as unknown as MockWorkspaceLeaf).id).toBe('winA');
    });

    it('appends the numbered window label to the secondary text when more than one window exists', () => {
        const groupMain = new MockWorkspaceParent(rootContainer);
        const groupWin = new MockWorkspaceParent(windowContainer);

        const mainA = leaf('mainA', 'Main-A.md', groupMain, rootContainer);
        const winA = leaf('winA', 'Win-A.md', groupWin, windowContainer);

        app.workspace.allLeaves = [mainA, winA];
        app.workspace.setActiveLeaf(mainA);
        const model = plugin.buildNavigationModel(asLeaf(mainA));
        const labels = plugin.buildWindowLabels(model);
        const tabInWin = model.tabs.find((t) => (t.leaf as unknown as MockWorkspaceLeaf).id === 'winA')!;

        const el = rowEl();
        plugin.renderTabSuggestion(tabInWin, el, labels, true, true);

        const secondary = el.querySelector('.ntg-nav-secondary')!.textContent!;
        expect(secondary).toContain('Pop-out 1');
        expect(secondary).toContain('tab');
    });

    it('omits the window label from the secondary text with a single window', () => {
        const group = new MockWorkspaceParent(rootContainer);
        const a = leaf('a', 'A.md', group, rootContainer);

        app.workspace.allLeaves = [a];
        app.workspace.setActiveLeaf(a);
        const model = plugin.buildNavigationModel(asLeaf(a));
        const labels = plugin.buildWindowLabels(model);
        const tab = model.tabs[0];

        const el = rowEl();
        plugin.renderTabSuggestion(tab, el, labels, false, false);

        const secondary = el.querySelector('.ntg-nav-secondary')!.textContent!;
        expect(secondary).toBe('');
        expect(secondary).not.toContain('Main window');
        expect(secondary).not.toContain('Pop-out');
        expect(secondary).not.toContain('tab');
    });

    it('shows the window label but not the group when there is one window and many groups', () => {
        const groupMain = new MockWorkspaceParent(rootContainer);
        const groupMain2 = new MockWorkspaceParent(rootContainer);

        const a = leaf('a', 'A.md', groupMain, rootContainer);
        const b = leaf('b', 'B.md', groupMain2, rootContainer);

        app.workspace.allLeaves = [a, b];
        app.workspace.setActiveLeaf(a);
        const model = plugin.buildNavigationModel(asLeaf(a));
        const labels = plugin.buildWindowLabels(model);
        const tab = model.tabs[0];

        const el = rowEl();
        // Single window: showWindow false. Multiple groups: showGroup true.
        plugin.renderTabSuggestion(tab, el, labels, true, false);

        const secondary = el.querySelector('.ntg-nav-secondary')!.textContent!;
        expect(secondary).toContain('tab');
        expect(secondary).not.toContain('Main window');
        expect(secondary).not.toContain('Pop-out');
    });

    it('numbers distinct pop-out windows so they are distinguishable', () => {
        const popout2 = new MockWorkspaceContainer('window', {} as Window);

        const groupMain = new MockWorkspaceParent(rootContainer);
        const groupWin = new MockWorkspaceParent(windowContainer);
        const groupWin2 = new MockWorkspaceParent(popout2);

        const mainA = leaf('mainA', 'Main-A.md', groupMain, rootContainer);
        const winA = leaf('winA', 'Win-A.md', groupWin, windowContainer);
        const winB = leaf('winB', 'Win-B.md', groupWin2, popout2);

        app.workspace.allLeaves = [mainA, winA, winB];
        app.workspace.setActiveLeaf(mainA);
        const model = plugin.buildNavigationModel(asLeaf(mainA));
        const labels = plugin.buildWindowLabels(model);

        expect(labels.get(rootContainer.win)).toBe('Main window');
        expect(labels.get(windowContainer.win)).toBe('Pop-out 1');
        expect(labels.get(popout2.win)).toBe('Pop-out 2');

        const tabInWin2 = model.tabs.find((t) => (t.leaf as unknown as MockWorkspaceLeaf).id === 'winB')!;
        const el = rowEl();
        plugin.renderTabSuggestion(tabInWin2, el, labels, true, true);
        const secondary = el.querySelector('.ntg-nav-secondary')!.textContent!;
        expect(secondary).toContain('Pop-out 2');
    });
});
