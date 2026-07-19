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
    switchToWindow: () => void;
    buildWindowInfos: (groups: TabGroupInfo[], activeLeaf: WorkspaceLeaf | null) => WindowInfo[];
    formatWindowLabel: (win: Window | undefined, groups: TabGroupInfo[], representative: WorkspaceLeaf) => string;
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

describe('switchToWindow', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let rootContainer: MockWorkspaceContainer;
    let windowContainer: MockWorkspaceContainer;

    beforeEach(() => {
        app = new MockApp();
        rootContainer = new MockWorkspaceContainer('root', globalThis.window as Window);
        windowContainer = new MockWorkspaceContainer('window', {} as Window);
        plugin = createPlugin(app);
    });

    it('multiple groups sharing one Window produce one WindowInfo', () => {
        const group1 = new MockWorkspaceParent(rootContainer);
        const group2 = new MockWorkspaceParent(rootContainer);
        const a = leaf('a', 'A.md', group1, rootContainer);
        const b = leaf('b', 'B.md', group2, rootContainer);

        app.workspace.rootLeaves = [a, b];
        app.workspace.allLeaves = [a, b];
        app.workspace.setActiveLeaf(a);

        const groups = plugin.buildTabGroupInfos([asLeaf(a), asLeaf(b)], asLeaf(a));
        const windows = plugin.buildWindowInfos(groups, asLeaf(a));
        expect(windows).toHaveLength(1);
        expect(windows[0].groups).toHaveLength(2);
    });

    it('the main window label begins Main window', () => {
        const group = new MockWorkspaceParent(rootContainer);
        const a = leaf('a', 'A.md', group, rootContainer);

        app.workspace.rootLeaves = [a];
        app.workspace.allLeaves = [a];
        app.workspace.setActiveLeaf(a);

        const groups = plugin.buildTabGroupInfos([asLeaf(a)], asLeaf(a));
        const windows = plugin.buildWindowInfos(groups, asLeaf(a));
        expect(windows[0].label).toContain('Main window');
    });

    it('a non-main window label begins Pop-out', () => {
        const group = new MockWorkspaceParent(windowContainer);
        const a = leaf('a', 'A.md', group, windowContainer);

        app.workspace.rootLeaves = [];
        app.workspace.allLeaves = [a];
        app.workspace.setActiveLeaf(a);

        const groups = plugin.buildTabGroupInfos([asLeaf(a)], asLeaf(a));
        const windows = plugin.buildWindowInfos(groups, asLeaf(a));
        expect(windows[0].label).toContain('Pop-out');
    });

    it('windows sort by their most-recent group activity', () => {
        const groupMain1 = new MockWorkspaceParent(rootContainer);
        const groupMain2 = new MockWorkspaceParent(rootContainer);
        const groupWin = new MockWorkspaceParent(windowContainer);

        const mainA = leaf('mainA', 'Main-A.md', groupMain1, rootContainer);
        const mainB = leaf('mainB', 'Main-B.md', groupMain2, rootContainer);
        const winA = leaf('winA', 'Win-A.md', groupWin, windowContainer);

        plugin.leafLastActive.set('mainA', 100);
        plugin.leafLastActive.set('mainB', 300);
        plugin.leafLastActive.set('winA', 200);

        app.workspace.rootLeaves = [mainA, mainB];
        app.workspace.allLeaves = [mainA, mainB, winA];
        app.workspace.setActiveLeaf(mainA);

        const groups = plugin.buildTabGroupInfos([asLeaf(mainA), asLeaf(mainB), asLeaf(winA)], asLeaf(mainA));
        const windows = plugin.buildWindowInfos(groups, asLeaf(mainA));
        // Main window has most recent activity (mainB at 300), pop-out at 200
        expect(windows[0].label).toContain('Main window');
        expect(windows[1].label).toContain('Pop-out');
    });

    it('choosing a window activates its representative leaf', () => {
        const groupMain = new MockWorkspaceParent(rootContainer);
        const groupWin = new MockWorkspaceParent(windowContainer);

        const mainA = leaf('mainA', 'Main-A.md', groupMain, rootContainer);
        const winA = leaf('winA', 'Win-A.md', groupWin, windowContainer);

        app.workspace.rootLeaves = [mainA];
        app.workspace.allLeaves = [mainA, winA];
        app.workspace.setActiveLeaf(mainA);

        let captured: MockFuzzySuggestModal<WindowInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<WindowInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToWindow();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        const items = captured!.getItems();
        const winItem = items.find((w) => !w.isCurrentWindow)!;
        captured!.onChooseItem(winItem);
        expect(app.workspace.activeLeaf).toBe(winA);
    });

    it('no pop-outs yields exactly one window item', () => {
        const group = new MockWorkspaceParent(rootContainer);
        const a = leaf('a', 'A.md', group, rootContainer);

        app.workspace.rootLeaves = [a];
        app.workspace.allLeaves = [a];
        app.workspace.setActiveLeaf(a);

        const groups = plugin.buildTabGroupInfos([asLeaf(a)], asLeaf(a));
        const windows = plugin.buildWindowInfos(groups, asLeaf(a));
        expect(windows).toHaveLength(1);
    });

    it('a pop-out with several groups displays the correct group count', () => {
        const group1 = new MockWorkspaceParent(windowContainer);
        const group2 = new MockWorkspaceParent(windowContainer);
        const group3 = new MockWorkspaceParent(windowContainer);

        const a = leaf('a', 'A.md', group1, windowContainer);
        const b = leaf('b', 'B.md', group2, windowContainer);
        const c = leaf('c', 'C.md', group3, windowContainer);

        app.workspace.rootLeaves = [];
        app.workspace.allLeaves = [a, b, c];
        app.workspace.setActiveLeaf(a);

        const groups = plugin.buildTabGroupInfos([asLeaf(a), asLeaf(b), asLeaf(c)], asLeaf(a));
        const windows = plugin.buildWindowInfos(groups, asLeaf(a));
        expect(windows[0].label).toContain('3 groups');
    });
});
