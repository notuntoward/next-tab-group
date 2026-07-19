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
    buildTabGroupInfos: (leaves: WorkspaceLeaf[], activeLeaf: WorkspaceLeaf | null) => TabGroupInfo[];
    buildTabInfos: (groups: TabGroupInfo[]) => TabInfo[];
    getTabSearchText: (tab: TabInfo) => string;
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

interface TabInfo {
    leaf: WorkspaceLeaf;
    group: TabGroupInfo;
    lastActive: number;
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

describe('switchToAnyTab', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let rootContainer: MockWorkspaceContainer;
    let windowContainer: MockWorkspaceContainer;

    beforeEach(() => {
        app = new MockApp();
        rootContainer = new MockWorkspaceContainer('root', {} as Window);
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

        const groups = plugin.buildTabGroupInfos([asLeaf(a), asLeaf(b)], asLeaf(a));
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
});
