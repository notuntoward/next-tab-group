import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf, WorkspaceParent } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
    MockFuzzySuggestModal,
} from './mocks/obsidian';

type TestPlugin = NextTabGroupPlugin & {
    buildNavigationModel: (activeLeaf: WorkspaceLeaf | null) => WorkspaceNavigationModel;
    getEditorLeafLocations: () => LeafLocation[];
    getWindowForLeaf: (leaf: WorkspaceLeaf | null) => Window | undefined;
    getGroupsInWindow: (model: WorkspaceNavigationModel, targetWindow: Window | undefined) => TabGroupInfo[];
    getTabsInWindow: (model: WorkspaceNavigationModel, targetWindow: Window | undefined) => TabInfo[];
    getGroupForLeaf: (model: WorkspaceNavigationModel, leaf: WorkspaceLeaf | null) => TabGroupInfo | null;
    switchToAnyTab: () => void;
    switchToTabGroup: () => void;
    switchToTabInGroup: () => void;
    switchToWindow: () => void;
    dedupeInGroup: () => Promise<void>;
    dedupeInAllGroups: () => Promise<void>;
    dedupeInAllWindows: () => Promise<void>;
    leafLastActive: Map<string, number>;
};

interface LeafLocation {
    leaf: WorkspaceLeaf;
    window: Window | undefined;
    group: WorkspaceParent | null;
}

interface TabGroupInfo {
    group: WorkspaceParent;
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

interface WorkspaceNavigationModel {
    locations: LeafLocation[];
    windows: WindowInfo[];
    groups: TabGroupInfo[];
    tabs: TabInfo[];
}

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

function leaf(
    id: string,
    file: string,
    parent: MockWorkspaceParent,
    container: MockWorkspaceContainer,
): MockWorkspaceLeaf {
    return new MockWorkspaceLeaf(file).setId(id).setParent(parent).setContainer(container);
}

function idOf(leaf: WorkspaceLeaf): string {
    return (leaf as unknown as MockWorkspaceLeaf).id;
}

// Build the canonical arrangement from the task spec:
//
//   Main window      Group A: main-a1, main-a2
//                   Group B: main-b1
//   Pop-out window   Group C: popup-c1, popup-c2
function arrange(app: MockApp) {
    const mainWin: Window = {} as Window;
    const popupWin: Window = {} as Window;

    const mainContainer = new MockWorkspaceContainer('root', mainWin);
    const popupContainer = new MockWorkspaceContainer('window', popupWin);

    const groupA = new MockWorkspaceParent(mainContainer);
    const groupB = new MockWorkspaceParent(mainContainer);
    const groupC = new MockWorkspaceParent(popupContainer);

    const mainA1 = leaf('main-a1', 'Main-A1.md', groupA, mainContainer);
    const mainA2 = leaf('main-a2', 'Main-A2.md', groupA, mainContainer);
    const mainB1 = leaf('main-b1', 'Main-B1.md', groupB, mainContainer);
    const popupC1 = leaf('popup-c1', 'Popup-C1.md', groupC, popupContainer);
    const popupC2 = leaf('popup-c2', 'Popup-C2.md', groupC, popupContainer);

    const sidebar = leaf('sidebar', 'File Explorer', groupA, mainContainer);
    (sidebar as unknown as { getRoot: () => unknown }).getRoot = () => app.workspace.leftSplit;

    app.workspace.allLeaves = [mainA1, mainA2, mainB1, popupC1, popupC2, sidebar];

    return {
        mainWin,
        popupWin,
        groupA,
        groupB,
        groupC,
        mainA1,
        mainA2,
        mainB1,
        popupC1,
        popupC2,
        sidebar,
    };
}

function asLeaf(leaf: MockWorkspaceLeaf): WorkspaceLeaf {
    return leaf as unknown as WorkspaceLeaf;
}

describe('canonical model', () => {
    let app: MockApp;
    let plugin: TestPlugin;

    beforeEach(async () => {
        app = new MockApp();
        plugin = createPlugin(app);
        await plugin.onload();
    });

    describe('model construction', () => {
        it('includes exactly five editor leaves (sidebar excluded)', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            expect(model.locations).toHaveLength(5);
            expect(model.tabs).toHaveLength(5);
        });

        it('creates exactly three groups', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            expect(model.groups).toHaveLength(3);
        });

        it('each group contains only leaves from one window', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            for (const group of model.groups) {
                const wins = new Set(group.leaves.map((l) => l.getContainer()?.win));
                expect(wins.size).toBe(1);
            }
        });

        it('main groups contain only main-* leaves', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            const groupA = model.groups.find((g) => g.group === ar.groupA)!;
            const groupB = model.groups.find((g) => g.group === ar.groupB)!;
            expect(groupA.leaves.map(idOf).sort()).toEqual(['main-a1', 'main-a2']);
            expect(groupB.leaves.map(idOf)).toEqual(['main-b1']);
        });

        it('pop-out group contains only popup-* leaves', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            const groupC = model.groups.find((g) => g.group === ar.groupC)!;
            expect(groupC.leaves.map(idOf).sort()).toEqual(['popup-c1', 'popup-c2']);
        });

        it('every editor leaf appears in exactly one TabGroupInfo', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            const counts = new Map<string, number>();
            for (const group of model.groups) {
                for (const l of group.leaves) {
                    const id = idOf(l);
                    counts.set(id, (counts.get(id) ?? 0) + 1);
                }
            }
            expect([...counts.values()].every((c) => c === 1)).toBe(true);
        });

        it('every TabInfo.group.window matches the leaf container window', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            for (const tab of model.tabs) {
                expect(tab.group.window).toBe(tab.leaf.getContainer()?.win);
            }
        });

        it('main and pop-out each yield one WindowInfo', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            expect(model.windows).toHaveLength(2);
            const mainWin = model.windows.find((w) => w.window === ar.mainWin)!;
            const popupWin = model.windows.find((w) => w.window === ar.popupWin)!;
            expect(mainWin.groups).toHaveLength(2);
            expect(popupWin.groups).toHaveLength(1);
        });

        it('a sidebar leaf is absent from locations, groups, tabs, and windows', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            const inLocations = model.locations.some((l) => idOf(l.leaf) === 'sidebar');
            const inTabs = model.tabs.some((t) => idOf(t.leaf) === 'sidebar');
            expect(inLocations).toBe(false);
            expect(inTabs).toBe(false);
            for (const group of model.groups) {
                expect(group.leaves.map(idOf)).not.toContain('sidebar');
            }
        });
    });

    describe('scope helpers', () => {
        it('getTabsInWindow(main) contains all main tabs and zero pop-out tabs', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            const tabs = plugin.getTabsInWindow(model, ar.mainWin);
            expect(tabs.map((t) => idOf(t.leaf)).sort()).toEqual(['main-a1', 'main-a2', 'main-b1']);
        });

        it('getTabsInWindow(popup) contains all pop-out tabs and zero main tabs', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            const tabs = plugin.getTabsInWindow(model, ar.popupWin);
            expect(tabs.map((t) => idOf(t.leaf)).sort()).toEqual(['popup-c1', 'popup-c2']);
        });

        it('getGroupsInWindow returns the corresponding group counts', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            expect(plugin.getGroupsInWindow(model, ar.mainWin)).toHaveLength(2);
            expect(plugin.getGroupsInWindow(model, ar.popupWin)).toHaveLength(1);
        });

        it('getGroupForLeaf(mainA1) returns Group A, not a group in the pop-out', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            const group = plugin.getGroupForLeaf(model, asLeaf(ar.mainA1));
            expect(group?.group).toBe(ar.groupA);
        });

        it('current-group determination requires both matching parent and window', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            const groupA = model.groups.find((g) => g.group === ar.groupA)!;
            const groupC = model.groups.find((g) => g.group === ar.groupC)!;
            expect(groupA.isCurrentGroup).toBe(true);
            expect(groupC.isCurrentGroup).toBe(false);
        });

        it('relative labels are generated only among groups in the active leaf window', () => {
            const ar = arrange(app);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            const groupA = model.groups.find((g) => g.group === ar.groupA)!;
            const groupC = model.groups.find((g) => g.group === ar.groupC)!;
            // Group C is in another window: no relative label.
            expect(groupC.relativeLabel).toBeNull();
            // Group A is current, so no relative label either, but it must not
            // report a cross-window relationship to Group C.
            expect(groupA.relativeLabel).toBeNull();
        });
    });

    describe('command regression', () => {
        function captureItems<T>(ctor: typeof MockFuzzySuggestModal): { captured?: MockFuzzySuggestModal<T>; restore: () => void } {
            const originalOpen = ctor.prototype.open;
            const state: { captured?: MockFuzzySuggestModal<T> } = {};
            ctor.prototype.open = function (this: MockFuzzySuggestModal<T>) {
                state.captured = this;
                return originalOpen.call(this);
            };
            return {
                get captured() {
                    return state.captured;
                },
                restore: () => {
                    ctor.prototype.open = originalOpen;
                },
            };
        }

        it('switch to any tab contains all editor tabs from all windows', () => {
            const ar = arrange(app);
            app.workspace.setActiveLeaf(ar.mainA1);
            const cap = captureItems<TabInfo>(MockFuzzySuggestModal);
            plugin.switchToAnyTab();
            const ids = cap.captured!.getItems().map((t) => idOf(t.leaf)).sort();
            expect(ids).toEqual(['main-a1', 'main-a2', 'main-b1', 'popup-c1', 'popup-c2']);
            cap.restore();
        });

        it('switch to tab group contains only active-window groups', () => {
            const ar = arrange(app);
            app.workspace.setActiveLeaf(ar.mainA1);
            const cap = captureItems<TabGroupInfo>(MockFuzzySuggestModal);
            plugin.switchToTabGroup();
            const groups = cap.captured!.getItems();
            expect(groups).toHaveLength(2);
            expect(groups.every((g) => g.window === ar.mainWin)).toBe(true);
            cap.restore();
        });

        it('switch to tab in group contains only active-group leaves', () => {
            const ar = arrange(app);
            app.workspace.setActiveLeaf(ar.mainA1);
            const cap = captureItems<MockWorkspaceLeaf>(MockFuzzySuggestModal);
            plugin.switchToTabInGroup();
            const ids = cap.captured!.getItems().map((l) => idOf(l as unknown as WorkspaceLeaf)).sort();
            expect(ids).toEqual(['main-a1', 'main-a2']);
            cap.restore();
        });

        it('switch to window contains one item per actual window', () => {
            const ar = arrange(app);
            app.workspace.setActiveLeaf(ar.mainA1);
            const cap = captureItems<WindowInfo>(MockFuzzySuggestModal);
            plugin.switchToWindow();
            expect(cap.captured!.getItems()).toHaveLength(2);
            cap.restore();
        });

        it('dedupe in group receives only the current group leaves', async () => {
            const app2 = new MockApp();
            const plugin2 = createPlugin(app2);
            await plugin2.onload();

            const mainWin: Window = {} as Window;
            const popupWin: Window = {} as Window;
            const mainContainer = new MockWorkspaceContainer('root', mainWin);
            const popupContainer = new MockWorkspaceContainer('window', popupWin);
            const g1 = new MockWorkspaceParent(mainContainer);
            const g2 = new MockWorkspaceParent(mainContainer);
            const gP = new MockWorkspaceParent(popupContainer);

            const keep = leaf('m1', 'Note.md', g1, mainContainer);
            const dup = leaf('m2', 'Note.md', g1, mainContainer);
            const otherGroup = leaf('m3', 'Note.md', g2, mainContainer);
            const popupDup = leaf('p1', 'Note.md', gP, popupContainer);

            app2.workspace.allLeaves = [keep, dup, otherGroup, popupDup];
            app2.workspace.setActiveLeaf(keep);
            plugin2.settings.confirmDedupeGroup = false;

            await plugin2.dedupeInGroup();

            // Duplicate inside the active group is removed; leaves in other
            // groups and other windows are untouched.
            expect((keep as unknown as MockWorkspaceLeaf).detached).toBe(false);
            expect((dup as unknown as MockWorkspaceLeaf).detached).toBe(true);
            expect((otherGroup as unknown as MockWorkspaceLeaf).detached).toBe(false);
            expect((popupDup as unknown as MockWorkspaceLeaf).detached).toBe(false);
        });

        it('dedupe in all groups receives only editor leaves in the active window', async () => {
            const app2 = new MockApp();
            const plugin2 = createPlugin(app2);
            await plugin2.onload();

            const mainWin: Window = {} as Window;
            const popupWin: Window = {} as Window;
            const mainContainer = new MockWorkspaceContainer('root', mainWin);
            const popupContainer = new MockWorkspaceContainer('window', popupWin);
            const g1 = new MockWorkspaceParent(mainContainer);
            const g2 = new MockWorkspaceParent(mainContainer);
            const gP = new MockWorkspaceParent(popupContainer);

            const keep = leaf('m1', 'Note.md', g1, mainContainer);
            const dup = leaf('m2', 'Note.md', g2, mainContainer);
            const popupDup = leaf('p1', 'Note.md', gP, popupContainer);

            app2.workspace.allLeaves = [keep, dup, popupDup];
            app2.workspace.setActiveLeaf(keep);
            plugin2.settings.confirmDedupeAllGroups = false;

            await plugin2.dedupeInAllGroups();

            expect((keep as unknown as MockWorkspaceLeaf).detached).toBe(false);
            expect((dup as unknown as MockWorkspaceLeaf).detached).toBe(true);
            expect((popupDup as unknown as MockWorkspaceLeaf).detached).toBe(false);
        });

        it('dedupe in all windows receives all editor leaves', async () => {
            const app2 = new MockApp();
            const plugin2 = createPlugin(app2);
            await plugin2.onload();

            const mainWin: Window = {} as Window;
            const popupWin: Window = {} as Window;
            const mainContainer = new MockWorkspaceContainer('root', mainWin);
            const popupContainer = new MockWorkspaceContainer('window', popupWin);
            const g1 = new MockWorkspaceParent(mainContainer);
            const g2 = new MockWorkspaceParent(popupContainer);

            const keep = leaf('m1', 'Note.md', g1, mainContainer);
            const dup = leaf('m2', 'Note.md', g2, popupContainer);

            app2.workspace.allLeaves = [keep, dup];
            app2.workspace.setActiveLeaf(keep);
            plugin2.settings.confirmDedupeAllWindows = false;

            await plugin2.dedupeInAllWindows();

            expect((keep as unknown as MockWorkspaceLeaf).detached).toBe(false);
            expect((dup as unknown as MockWorkspaceLeaf).detached).toBe(true);
        });

        it('sortExcludingActive pushes the active item to the end', () => {
            const ar = arrange(app);
            app.workspace.setActiveLeaf(ar.mainA1);
            const cap = captureItems<TabInfo>(MockFuzzySuggestModal);
            plugin.switchToAnyTab();
            const items = cap.captured!.getItems();
            expect(idOf(items[items.length - 1].leaf)).toBe('main-a1');
            cap.restore();
        });
    });
});
