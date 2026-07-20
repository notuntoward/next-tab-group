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
    // The main window must use the global `window` so the plugin's
    // `win === window` main-window check (used for "Main window" labels)
    // matches, mirroring a real Obsidian main window.
    const mainWin: Window = globalThis.window;
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
        for (const cls of opts.cls.split(' ')) {
            if (cls) child.classList.add(cls);
        }
        this.appendChild(child);
        return augment(child);
    };
    return a;
}

function rowEl(): AugmentedEl {
    return augment(document.createElement('div'));
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

        it('switch to any tab groups tabs by tab group within each window', () => {
            const ar = arrange(app);
            // Recencies chosen so Group A (main-a2) is fresher than Group B
            // (main-b1), and the pop-out group (popup-c2) is freshest overall.
            plugin.leafLastActive.set('main-a1', 100);
            plugin.leafLastActive.set('main-a2', 300);
            plugin.leafLastActive.set('main-b1', 200);
            plugin.leafLastActive.set('popup-c1', 400);
            plugin.leafLastActive.set('popup-c2', 500);
            app.workspace.setActiveLeaf(ar.mainA1);

            const cap = captureItems<TabInfo>(MockFuzzySuggestModal);
            plugin.switchToAnyTab();
            const items = cap.captured!.getItems();

            // Active window block: Group A (main-a2, main-a1) then Group B
            // (main-b1), all before any pop-out tab.
            const mainBlock = items.filter((t) => t.group.window === ar.mainWin);
            expect(mainBlock.map((t) => idOf(t.leaf))).toEqual([
                'main-a2',
                'main-a1',
                'main-b1',
            ]);

            // Pop-out window block follows, its group after the active window.
            const popupBlock = items.filter((t) => t.group.window === ar.popupWin);
            expect(popupBlock.map((t) => idOf(t.leaf))).toEqual([
                'popup-c2',
                'popup-c1',
            ]);

            // A pop-out tab never precedes a main-window tab.
            expect(items.findIndex((t) => t.group.window === ar.popupWin))
                .toBeGreaterThan(items.findIndex((t) => t.group.window === ar.mainWin));
            cap.restore();
        });

        it('switch to tab group contains groups from every window, active window first', () => {
            const ar = arrange(app);
            app.workspace.setActiveLeaf(ar.mainA1);
            const cap = captureItems<TabGroupInfo>(MockFuzzySuggestModal);
            plugin.switchToTabGroup();
            const groups = cap.captured!.getItems();
            expect(groups).toHaveLength(3);
            // Active window (main) leads, then the pop-out window.
            expect(groups.filter((g) => g.window === ar.mainWin)).toHaveLength(2);
            expect(groups.filter((g) => g.window === ar.popupWin)).toHaveLength(1);
            expect(groups[0].window).toBe(ar.mainWin);
            expect(groups[groups.length - 1].window).toBe(ar.popupWin);
            cap.restore();
        });

        it('switch to tab group orders each window groups by recency of most recent tab', () => {
            const ar = arrange(app);
            // main-a2 is the most recent main tab; popup-c2 the most recent pop-out tab.
            plugin.leafLastActive.set('main-a1', 100);
            plugin.leafLastActive.set('main-a2', 300);
            plugin.leafLastActive.set('main-b1', 200);
            plugin.leafLastActive.set('popup-c1', 400);
            plugin.leafLastActive.set('popup-c2', 500);
            app.workspace.setActiveLeaf(ar.mainA1);

            const cap = captureItems<TabGroupInfo>(MockFuzzySuggestModal);
            plugin.switchToTabGroup();
            const groups = cap.captured!.getItems();
            const mainGroups = groups.filter((g) => g.window === ar.mainWin);
            const popupGroups = groups.filter((g) => g.window === ar.popupWin);
            expect(idOf(mainGroups[0].representative)).toBe('main-a2');
            expect(idOf(popupGroups[0].representative)).toBe('popup-c2');
            cap.restore();
        });

        it('switch to tab group shows the window label on every group when more than one window', () => {
            const ar = arrange(app);
            app.workspace.setActiveLeaf(ar.mainA1);
            const model = plugin.buildNavigationModel(asLeaf(ar.mainA1));
            const labels = plugin.buildWindowLabels(model);

            const mainGroup = model.groups.find((g) => g.group === ar.groupA)!;
            const popupGroup = model.groups.find((g) => g.group === ar.groupC)!;

            const mainRow = rowEl();
            plugin.renderTabGroupSuggestion(mainGroup, mainRow, labels, true, true);
            const popupRow = rowEl();
            plugin.renderTabGroupSuggestion(popupGroup, popupRow, labels, true, true);

            // Main window group shows "Main window"; pop-out group shows its
            // numbered pop-out label rather than the bare "Pop-out".
            expect(mainRow.querySelector('.ntg-nav-secondary')!.textContent!).toContain('Main window');
            expect(popupRow.querySelector('.ntg-nav-secondary')!.textContent!).toContain('Pop-out 1');
        });

        it('switch to tab group omits the window label with a single window', () => {
            const mainWin: Window = {} as Window;
            const container = new MockWorkspaceContainer('root', mainWin);
            const g1 = new MockWorkspaceParent(container);
            const g2 = new MockWorkspaceParent(container);
            const a = leaf('a', 'A.md', g1, container);
            const b = leaf('b', 'B.md', g2, container);

            app.workspace.allLeaves = [a, b];
            app.workspace.setActiveLeaf(a);
            const model = plugin.buildNavigationModel(asLeaf(a));
            const labels = plugin.buildWindowLabels(model);
            const group = model.groups[0];

            const row = rowEl();
            plugin.renderTabGroupSuggestion(group, row, labels, true, false);
            const secondary = row.querySelector('.ntg-nav-secondary')!.textContent!;
            expect(secondary).not.toContain('Main window');
            expect(secondary).not.toContain('Pop-out');
        });

        it('switch to tab group shows no group or window label with a single group in a single window', () => {
            const mainWin: Window = globalThis.window;
            const container = new MockWorkspaceContainer('root', mainWin);
            const g1 = new MockWorkspaceParent(container);
            const a = leaf('a', 'A.md', g1, container);
            const b = leaf('b', 'B.md', g1, container);

            app.workspace.allLeaves = [a, b];
            app.workspace.setActiveLeaf(a);
            const model = plugin.buildNavigationModel(asLeaf(a));
            const labels = plugin.buildWindowLabels(model);
            const group = model.groups[0];

            const row = rowEl();
            // Single window and single group: neither label is needed.
            plugin.renderTabGroupSuggestion(group, row, labels, false, false);
            const secondary = row.querySelector('.ntg-nav-secondary')!.textContent!;
            expect(secondary).toBe('');
        });

        it('switch to window shows numbered pop-out labels', () => {
            const popupWin: Window = {} as Window;
            const popupWin2: Window = {} as Window;
            const container = new MockWorkspaceContainer('root', globalThis.window);
            const p1 = new MockWorkspaceContainer('window', popupWin);
            const p2 = new MockWorkspaceContainer('window', popupWin2);
            const g1 = new MockWorkspaceParent(container);
            const gP1 = new MockWorkspaceParent(p1);
            const gP2 = new MockWorkspaceParent(p2);
            const a = leaf('a', 'A.md', g1, container);
            const pA = leaf('pa', 'PA.md', gP1, p1);
            const pB = leaf('pb', 'PB.md', gP2, p2);

            app.workspace.allLeaves = [a, pA, pB];
            app.workspace.setActiveLeaf(a);
            const model = plugin.buildNavigationModel(asLeaf(a));
            const popout2 = model.windows.find((w) => w.window === popupWin2)!;
            const row = rowEl();
            plugin.renderWindowSuggestion(popout2, row);
            expect(row.querySelector('.ntg-nav-primary')!.textContent!).toContain('Pop-out 2');
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

        it('switch to any tab keeps the active tab in its recency slot', () => {
            const ar = arrange(app);
            // Give the active tab and its siblings distinct recencies so the
            // ordering is deterministic: main-a2 is the most recent non-active.
            plugin.leafLastActive.set('main-a1', 100);
            plugin.leafLastActive.set('main-a2', 300);
            plugin.leafLastActive.set('main-b1', 200);
            plugin.leafLastActive.set('popup-c1', 400);
            plugin.leafLastActive.set('popup-c2', 500);
            app.workspace.setActiveLeaf(ar.mainA1);

            const cap = captureItems<TabInfo>(MockFuzzySuggestModal);
            plugin.switchToAnyTab();
            const items = cap.captured!.getItems();

            // Grouped by tab group within the current-window-first layout: the
            // active window leads, its groups are ordered by their most recent
            // tab (Group A: main-a2 then main-a1, then Group B: main-b1), and
            // within a group tabs follow recency. The active tab stays in its
            // recency slot — it is not pushed to the bottom.
            const mainBlock = items.filter((t) => t.group.window === ar.mainWin);
            expect(idOf(mainBlock[0].leaf)).toBe('main-a2');
            expect(idOf(mainBlock[1].leaf)).toBe('main-a1');
            expect(idOf(mainBlock[2].leaf)).toBe('main-b1');
            cap.restore();
        });

        it('switch to any tab selects the globally most recent non-active tab, even across groups and windows', () => {
            const ar = arrange(app);
            // The active tab is main-a1. The most recent non-active tab overall
            // is popup-c2 (recency 500), which lives in another window AND
            // another group than the active tab. The grouped display order puts
            // a same-group tab (main-a2, recency 300) first, so a naive "first
            // non-active row" selection would wrongly pick main-a2. We assert
            // the selection targets popup-c2 instead.
            plugin.leafLastActive.set('main-a1', 100);
            plugin.leafLastActive.set('main-a2', 300);
            plugin.leafLastActive.set('main-b1', 200);
            plugin.leafLastActive.set('popup-c1', 400);
            plugin.leafLastActive.set('popup-c2', 500);
            app.workspace.setActiveLeaf(ar.mainA1);

            const cap = captureItems<TabInfo>(MockFuzzySuggestModal);
            plugin.switchToAnyTab();
            const items = cap.captured!.getItems();
            const initialIndex = (cap.captured as unknown as { initialIndex: number }).initialIndex;

            // The first row in display order is NOT the selected one.
            expect(idOf(items[0].leaf)).toBe('main-a2');
            // The selected item is the globally most recent non-active tab.
            expect(idOf(items[initialIndex].leaf)).toBe('popup-c2');
            cap.restore();
        });

        it('switch to tab group selects the most recent non-active group, even when it is in another window', () => {
            const ar = arrange(app);
            // Active group is Group A (main). The most recent non-active group
            // overall is the pop-out Group C (representative popup-c2, recency
            // 500), even though an active-window group (Group B, recency 200)
            // appears earlier in the grouped display order.
            plugin.leafLastActive.set('main-a1', 100);
            plugin.leafLastActive.set('main-a2', 300);
            plugin.leafLastActive.set('main-b1', 200);
            plugin.leafLastActive.set('popup-c1', 400);
            plugin.leafLastActive.set('popup-c2', 500);
            app.workspace.setActiveLeaf(ar.mainA1);

            const cap = captureItems<TabGroupInfo>(MockFuzzySuggestModal);
            plugin.switchToTabGroup();
            const groups = cap.captured!.getItems();
            const initialIndex = (cap.captured as unknown as { initialIndex: number }).initialIndex;

            // The first group in display order is in the active window, not the
            // selected one.
            expect(groups[0].window).toBe(ar.mainWin);
            // The selected group is the globally most recent non-active one.
            expect(idOf(groups[initialIndex].representative)).toBe('popup-c2');
            expect(groups[initialIndex].window).toBe(ar.popupWin);
            cap.restore();
        });

        it('switch to any tab lists tabs in pure recency order when grouping is off', () => {
            const ar = arrange(app);
            plugin.leafLastActive.set('main-a1', 100);
            plugin.leafLastActive.set('main-a2', 300);
            plugin.leafLastActive.set('main-b1', 200);
            plugin.leafLastActive.set('popup-c1', 400);
            plugin.leafLastActive.set('popup-c2', 500);
            app.workspace.setActiveLeaf(ar.mainA1);

            // Disable grouping: the result is a single recency-ordered list
            // regardless of window or tab group.
            plugin.settings.groupSwitchByContext = false;

            const cap = captureItems<TabInfo>(MockFuzzySuggestModal);
            plugin.switchToAnyTab();
            const ids = cap.captured!.getItems().map((t) => idOf(t.leaf));
            expect(ids).toEqual(['popup-c2', 'popup-c1', 'main-a2', 'main-b1', 'main-a1']);
            cap.restore();
        });

        it('switch to tab group lists groups in pure recency order when grouping is off', () => {
            const ar = arrange(app);
            plugin.leafLastActive.set('main-a1', 100);
            plugin.leafLastActive.set('main-a2', 300);
            plugin.leafLastActive.set('main-b1', 200);
            plugin.leafLastActive.set('popup-c1', 400);
            plugin.leafLastActive.set('popup-c2', 500);
            app.workspace.setActiveLeaf(ar.mainA1);

            plugin.settings.groupSwitchByContext = false;

            const cap = captureItems<TabGroupInfo>(MockFuzzySuggestModal);
            plugin.switchToTabGroup();
            const representatives = cap.captured!.getItems().map((g) => idOf(g.representative));
            expect(representatives).toEqual(['popup-c2', 'main-a2', 'main-b1']);
            cap.restore();
        });
    });

    describe('window-local spatial hints', () => {
        function setRect(parent: MockWorkspaceParent, rect: { x: number; y: number; w: number; h: number }) {
            (parent as unknown as { containerEl: unknown }).containerEl = {
                instanceOf: () => true,
                getBoundingClientRect: () => ({
                    left: rect.x,
                    top: rect.y,
                    width: rect.w,
                    height: rect.h,
                    right: rect.x + rect.w,
                    bottom: rect.y + rect.h,
                    x: rect.x,
                    y: rect.y,
                    toJSON: () => ({}),
                }),
            };
        }

        it('a group in the active window can receive a directional label', () => {
            const mainWin: Window = {} as Window;
            const mainContainer = new MockWorkspaceContainer('root', mainWin);
            const activeGroup = new MockWorkspaceParent(mainContainer);
            const rightGroup = new MockWorkspaceParent(mainContainer);

            const active = leaf('active', 'Active.md', activeGroup, mainContainer);
            const right = leaf('right', 'Right.md', rightGroup, mainContainer);

            setRect(activeGroup, { x: 0, y: 0, w: 100, h: 100 });
            setRect(rightGroup, { x: 300, y: 0, w: 100, h: 100 });

            const app2 = new MockApp();
            const plugin2 = createPlugin(app2);
            app2.workspace.allLeaves = [active, right];
            app2.workspace.setActiveLeaf(active);

            const model = plugin2.buildNavigationModel(asLeaf(active));
            const rightInfo = model.groups.find((g) => g.group === rightGroup)!;
            expect(rightInfo.isCurrentGroup).toBe(false);
            expect(rightInfo.relativeLabel).toBe('Right group');
        });

        it('a group in another window always has a null relative label', () => {
            const mainWin: Window = {} as Window;
            const popupWin: Window = {} as Window;
            const mainContainer = new MockWorkspaceContainer('root', mainWin);
            const popupContainer = new MockWorkspaceContainer('window', popupWin);
            const activeGroup = new MockWorkspaceParent(mainContainer);
            const popupGroup = new MockWorkspaceParent(popupContainer);

            const active = leaf('active', 'Active.md', activeGroup, mainContainer);
            const popup = leaf('popup', 'Popup.md', popupGroup, popupContainer);

            setRect(activeGroup, { x: 0, y: 0, w: 100, h: 100 });
            setRect(popupGroup, { x: 300, y: 300, w: 100, h: 100 });

            const app2 = new MockApp();
            const plugin2 = createPlugin(app2);
            app2.workspace.allLeaves = [active, popup];
            app2.workspace.setActiveLeaf(active);

            const model = plugin2.buildNavigationModel(asLeaf(active));
            const popupInfo = model.groups.find((g) => g.group === popupGroup)!;
            expect(popupInfo.relativeLabel).toBeNull();
            expect(model.windows.some((w) => w.window === popupWin)).toBe(true);
        });

        it('the active group has isCurrentGroup true and no relative label', () => {
            const mainWin: Window = {} as Window;
            const mainContainer = new MockWorkspaceContainer('root', mainWin);
            const activeGroup = new MockWorkspaceParent(mainContainer);

            const active = leaf('active', 'Active.md', activeGroup, mainContainer);
            setRect(activeGroup, { x: 0, y: 0, w: 100, h: 100 });

            const app2 = new MockApp();
            const plugin2 = createPlugin(app2);
            app2.workspace.allLeaves = [active];
            app2.workspace.setActiveLeaf(active);

            const model = plugin2.buildNavigationModel(asLeaf(active));
            const info = model.groups.find((g) => g.group === activeGroup)!;
            expect(info.isCurrentGroup).toBe(true);
            expect(info.relativeLabel).toBeNull();
        });

        it('a tab inherits its group relative label', () => {
            const mainWin: Window = {} as Window;
            const mainContainer = new MockWorkspaceContainer('root', mainWin);
            const activeGroup = new MockWorkspaceParent(mainContainer);
            const rightGroup = new MockWorkspaceParent(mainContainer);

            const active = leaf('active', 'Active.md', activeGroup, mainContainer);
            const right1 = leaf('right1', 'Right1.md', rightGroup, mainContainer);
            const right2 = leaf('right2', 'Right2.md', rightGroup, mainContainer);

            setRect(activeGroup, { x: 0, y: 0, w: 100, h: 100 });
            setRect(rightGroup, { x: 300, y: 0, w: 100, h: 100 });

            const app2 = new MockApp();
            const plugin2 = createPlugin(app2);
            app2.workspace.allLeaves = [active, right1, right2];
            app2.workspace.setActiveLeaf(active);

            const model = plugin2.buildNavigationModel(asLeaf(active));
            const rightInfo = model.groups.find((g) => g.group === rightGroup)!;
            for (const tab of model.tabs.filter((t) => t.group === rightInfo)) {
                expect(tab.group.relativeLabel).toBe('Right group');
            }
        });

        it('group cycling only takes candidates from the active window', () => {
            const mainWin: Window = {} as Window;
            const popupWin: Window = {} as Window;
            const mainContainer = new MockWorkspaceContainer('root', mainWin);
            const popupContainer = new MockWorkspaceContainer('window', popupWin);
            const g1 = new MockWorkspaceParent(mainContainer);
            const g2 = new MockWorkspaceParent(mainContainer);
            const gP = new MockWorkspaceParent(popupContainer);

            const a = leaf('a', 'A.md', g1, mainContainer);
            const b = leaf('b', 'B.md', g2, mainContainer);
            const p = leaf('p', 'P.md', gP, popupContainer);

            const app2 = new MockApp();
            const plugin2 = createPlugin(app2);
            app2.workspace.allLeaves = [a, b, p];
            app2.workspace.setActiveLeaf(a);

            const type = plugin2 as unknown as {
                getGroupsInWindow: (m: WorkspaceNavigationModel, w: Window | undefined) => TabGroupInfo[];
                getWindowForLeaf: (l: WorkspaceLeaf | null) => Window | undefined;
                getSpatiallySortedGroups: (g: TabGroupInfo[]) => TabGroupInfo[];
                buildNavigationModel: (l: WorkspaceLeaf | null) => WorkspaceNavigationModel;
            };

            const model = type.buildNavigationModel(asLeaf(a));
            const ordered = type.getSpatiallySortedGroups(
                type.getGroupsInWindow(model, type.getWindowForLeaf(asLeaf(a))),
            );
            expect(ordered.map((g) => g.window)).toEqual([mainWin, mainWin]);
            expect(ordered.some((g) => g.window === popupWin)).toBe(false);
        });

        it('cycles deterministically by label when geometry is unavailable', () => {
            const mainWin: Window = {} as Window;
            const mainContainer = new MockWorkspaceContainer('root', mainWin);
            const g1 = new MockWorkspaceParent(mainContainer);
            const g2 = new MockWorkspaceParent(mainContainer);

            const a = leaf('a', 'A.md', g1, mainContainer);
            const b = leaf('b', 'B.md', g2, mainContainer);

            (g1 as unknown as { containerEl: { instanceOf: () => boolean } }).containerEl = { instanceOf: () => false };
            (g2 as unknown as { containerEl: { instanceOf: () => boolean } }).containerEl = { instanceOf: () => false };

            const app2 = new MockApp();
            const plugin2 = createPlugin(app2);
            app2.workspace.allLeaves = [a, b];
            app2.workspace.setActiveLeaf(a);

            const type = plugin2 as unknown as {
                getSpatiallySortedGroups: (g: TabGroupInfo[]) => TabGroupInfo[];
                buildNavigationModel: (l: WorkspaceLeaf | null) => WorkspaceNavigationModel;
            };
            const model = type.buildNavigationModel(asLeaf(a));
            const ordered = type.getSpatiallySortedGroups(model.groups);
            expect(ordered.map((g) => (g.group === g1 ? 'g1' : 'g2'))).toEqual(['g2', 'g1']);
        });
    });
});
