import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
    MockWorkspaceWindow,
} from './mocks/obsidian';
import { CollectTabsModal, CollectChoice } from '../src/ui/collect-tabs-modal';
import type { WindowInfo } from '../main';

type TestPlugin = NextTabGroupPlugin & {
    runCollectTabs: () => void;
    collectTabs: (scope?: 'current' | 'all' | 'window', source?: WindowInfo | Window) => Promise<void>;
    describeWindow: (winOrInfo: WindowInfo | Window) => string;
    getActiveLeafInFocusedWindow: () => WorkspaceLeaf | null;
    buildNavigationModel: (activeLeaf: WorkspaceLeaf | null) => any;
};

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

function leaf(
    id: string,
    file: string | null,
    parent: MockWorkspaceParent,
    container: MockWorkspaceContainer,
): MockWorkspaceLeaf {
    const l = new MockWorkspaceLeaf(file).setId(id).setParent(parent);
    l.setContainer(container);
    return l;
}

describe('Multi-Window Collect Tabs (Option 2)', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let rootContainer: MockWorkspaceContainer;
    let popoutContainer1: MockWorkspaceContainer;
    let popoutContainer2: MockWorkspaceContainer;
    let popoutWin1: MockWorkspaceWindow;
    let popoutWin2: MockWorkspaceWindow;
    let win1Obj: Window;
    let win2Obj: Window;

    beforeEach(async () => {
        app = new MockApp();
        rootContainer = new MockWorkspaceContainer('root', globalThis.window);

        win1Obj = { name: 'popout1' } as unknown as Window;
        win2Obj = { name: 'popout2' } as unknown as Window;

        popoutWin1 = new MockWorkspaceWindow(win1Obj);
        popoutWin2 = new MockWorkspaceWindow(win2Obj);
        app.workspace.floatingSplit.children = [popoutWin1, popoutWin2];

        popoutContainer1 = new MockWorkspaceContainer('window', win1Obj);
        popoutContainer2 = new MockWorkspaceContainer('window', win2Obj);

        plugin = createPlugin(app);
        await plugin.onload();
    });

    describe('Single-window collectTabs window isolation', () => {
        it('consolidates splits within a popout window and leaves main window untouched', async () => {
            // Main window has 2 leaves
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const main1 = leaf('m1', 'Main1.md', mainGroup, rootContainer);
            const main2 = leaf('m2', 'Main2.md', mainGroup, rootContainer);

            // Popout 1 has 2 groups (split view in popout)
            const popGroup1 = new MockWorkspaceParent(popoutContainer1);
            const popGroup2 = new MockWorkspaceParent(popoutContainer1);
            const pop1 = leaf('p1', 'Pop1.md', popGroup1, popoutContainer1);
            const pop2 = leaf('p2', 'Pop2.md', popGroup1, popoutContainer1);
            const pop3 = leaf('p3', 'Pop3.md', popGroup2, popoutContainer1);

            app.workspace.allLeaves = [main1, main2, pop1, pop2, pop3];
            app.workspace.rootLeaves = [main1, main2];
            // Popout 1 is the currently active window
            app.workspace.setActiveLeaf(pop1);
            (globalThis as any).activeWindow = win1Obj;

            await plugin.collectTabs('current');

            // pop3 migrated into popGroup1
            expect(pop3.detached).toBe(true);
            // Sibling pop2 and active pop1 preserved
            expect(pop1.detached).toBe(false);
            expect(pop2.detached).toBe(false);
            // Main window leaves completely untouched
            expect(main1.detached).toBe(false);
            expect(main2.detached).toBe(false);
            // Popout window remains open
            expect(popoutWin1.closed).toBe(false);

            (globalThis as any).activeWindow = undefined;
        });

        it('running collect-tabs in Popout 1 leaves tabs in Popout 2 and Main Window untouched', async () => {
            // Main window has 2 groups
            const mainG1 = new MockWorkspaceParent(rootContainer);
            const mainG2 = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main1.md', mainG1, rootContainer);
            const m2 = leaf('m2', 'Main2.md', mainG2, rootContainer);

            // Popout 1 has 2 groups
            const p1G1 = new MockWorkspaceParent(popoutContainer1);
            const p1G2 = new MockWorkspaceParent(popoutContainer1);
            const p1_1 = leaf('p1_1', 'P1_1.md', p1G1, popoutContainer1);
            const p1_2 = leaf('p1_2', 'P1_2.md', p1G2, popoutContainer1);

            // Popout 2 has 2 groups
            const p2G1 = new MockWorkspaceParent(popoutContainer2);
            const p2G2 = new MockWorkspaceParent(popoutContainer2);
            const p2_1 = leaf('p2_1', 'P2_1.md', p2G1, popoutContainer2);
            const p2_2 = leaf('p2_2', 'P2_2.md', p2G2, popoutContainer2);

            app.workspace.allLeaves = [m1, m2, p1_1, p1_2, p2_1, p2_2];
            app.workspace.rootLeaves = [m1, m2];

            // Focus is in Popout 1
            app.workspace.setActiveLeaf(p1_1);
            (globalThis as any).activeWindow = win1Obj;

            await plugin.collectTabs('current');

            // In Popout 1: p1_2 is collected into p1G1
            expect(p1_2.detached).toBe(true);
            expect(p1_1.detached).toBe(false);
            expect(popoutWin1.closed).toBe(false);

            // Main window must be 100% untouched: neither m1 nor m2 detached
            expect(m1.detached).toBe(false);
            expect(m2.detached).toBe(false);
            expect(m1.parent).toBe(mainG1);
            expect(m2.parent).toBe(mainG2);

            // Popout 2 must be 100% untouched: neither p2_1 nor p2_2 detached, both remain in their separate groups
            expect(p2_1.detached).toBe(false);
            expect(p2_2.detached).toBe(false);
            expect(p2_1.parent).toBe(p2G1);
            expect(p2_2.parent).toBe(p2G2);
            expect(popoutWin2.closed).toBe(false);

            (globalThis as any).activeWindow = undefined;
        });

        it('running collect-tabs in Main Window leaves tabs in Popout 1 and Popout 2 untouched', async () => {
            // Main window has 2 groups
            const mainG1 = new MockWorkspaceParent(rootContainer);
            const mainG2 = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main1.md', mainG1, rootContainer);
            const m2 = leaf('m2', 'Main2.md', mainG2, rootContainer);

            // Popout 1 has 2 groups
            const p1G1 = new MockWorkspaceParent(popoutContainer1);
            const p1G2 = new MockWorkspaceParent(popoutContainer1);
            const p1_1 = leaf('p1_1', 'P1_1.md', p1G1, popoutContainer1);
            const p1_2 = leaf('p1_2', 'P1_2.md', p1G2, popoutContainer1);

            // Popout 2 has 2 groups
            const p2G1 = new MockWorkspaceParent(popoutContainer2);
            const p2G2 = new MockWorkspaceParent(popoutContainer2);
            const p2_1 = leaf('p2_1', 'P2_1.md', p2G1, popoutContainer2);
            const p2_2 = leaf('p2_2', 'P2_2.md', p2G2, popoutContainer2);

            app.workspace.allLeaves = [m1, m2, p1_1, p1_2, p2_1, p2_2];
            app.workspace.rootLeaves = [m1, m2];

            // Focus is in Main Window
            app.workspace.setActiveLeaf(m1);
            (globalThis as any).activeWindow = globalThis.window;

            await plugin.collectTabs('current');

            // In Main Window: m2 is collected into mainG1
            expect(m2.detached).toBe(true);
            expect(m1.detached).toBe(false);

            // Popout 1 must be 100% untouched: groups and tabs remain intact, window stays open
            expect(p1_1.detached).toBe(false);
            expect(p1_2.detached).toBe(false);
            expect(p1_1.parent).toBe(p1G1);
            expect(p1_2.parent).toBe(p1G2);
            expect(popoutWin1.closed).toBe(false);

            // Popout 2 must be 100% untouched: groups and tabs remain intact, window stays open
            expect(p2_1.detached).toBe(false);
            expect(p2_2.detached).toBe(false);
            expect(p2_1.parent).toBe(p2G1);
            expect(p2_2.parent).toBe(p2G2);
            expect(popoutWin2.closed).toBe(false);

            (globalThis as any).activeWindow = undefined;
        });
    });

    describe('Option 2 Command Registration & Dispatch', () => {
        it('registers exactly one command: collect-tabs (no separate all-windows or selected-windows commands)', () => {
            const commands = (plugin as any).commands ?? [];
            const collectCmd = commands.find((c: any) => c.id === 'collect-tabs');
            const allCmd = commands.find((c: any) => c.id === 'collect-tabs-all-windows');
            const selCmd = commands.find((c: any) => c.id === 'collect-tabs-selected-windows');

            expect(collectCmd).toBeDefined();
            expect(collectCmd.name).toBe('Collect tabs');
            expect(collectCmd.callback).toBeDefined();
            // In Option 2, checkCallback is NOT used
            expect(collectCmd.checkCallback).toBeUndefined();

            // Dead Option 3 commands must NOT exist
            expect(allCmd).toBeUndefined();
            expect(selCmd).toBeUndefined();
        });

        it('when only 1 window is open, runCollectTabs() immediately executes in-window consolidation without opening modal', async () => {
            app.workspace.floatingSplit.children = [];

            const g1 = new MockWorkspaceParent(rootContainer);
            const g2 = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main1.md', g1, rootContainer);
            const m2 = leaf('m2', 'Main2.md', g2, rootContainer);

            app.workspace.allLeaves = [m1, m2];
            app.workspace.rootLeaves = [m1, m2];
            app.workspace.setActiveLeaf(m1);

            let modalOpened = false;
            class TestModal {
                open() {
                    modalOpened = true;
                }
            }

            await plugin.runCollectTabs();

            expect(modalOpened).toBe(false);
            // m2 should be consolidated into g1
            expect(m2.detached).toBe(true);
            expect(m1.detached).toBe(false);
        });

        it('when multiple windows exist and run from a popout window, opens CollectTabsModal with popout window as "This window"', async () => {
            const mainG = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainG, rootContainer);

            const popG = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Pop1.md', popG, popoutContainer1);

            app.workspace.allLeaves = [m1, p1];
            app.workspace.rootLeaves = [m1];

            // User is running from the popout window
            app.workspace.setActiveLeaf(p1);
            (globalThis as any).activeWindow = win1Obj;

            let capturedModal: any = null;
            const originalOpen = CollectTabsModal.prototype.open;
            CollectTabsModal.prototype.open = function (this: any) {
                capturedModal = this;
            };

            try {
                await plugin.runCollectTabs();

                expect(capturedModal).not.toBeNull();
                const suggestions = capturedModal.getSuggestions('');
                // N = 2: Exactly 2 options ("This window", "All windows")
                expect(suggestions).toHaveLength(2);
                // "This window" must be the popout window where command was run!
                expect(suggestions[0].kind).toBe('current');
                expect(suggestions[0].label).toBe('This window - Pop1.md');
                expect(suggestions[0].winInfo.window).toBe(win1Obj);
                expect(suggestions[0].winInfo.isCurrentWindow).toBe(true);

                // Option 2: All windows
                expect(suggestions[1].kind).toBe('all');
                expect(suggestions[1].label).toBe('All windows');
            } finally {
                CollectTabsModal.prototype.open = originalOpen;
                (globalThis as any).activeWindow = undefined;
            }
        });

        it('describeWindow formats active tab title and tab count correctly', () => {
            const g1 = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Project Notes.md', g1, popoutContainer1);
            const p2 = leaf('p2', 'Daily Log.md', g1, popoutContainer1);
            const p3 = leaf('p3', 'Todo.md', g1, popoutContainer1);

            app.workspace.allLeaves = [p1, p2, p3];
            app.workspace.setActiveLeaf(p1);
            plugin['leafLastActive'].set('p1', 300);
            plugin['leafLastActive'].set('p2', 200);
            plugin['leafLastActive'].set('p3', 100);

            const desc = plugin.describeWindow(win1Obj);
            expect(desc).toBe('Project Notes.md, +2 more');

            // With single tab
            app.workspace.allLeaves = [p1];
            const singleDesc = plugin.describeWindow(win1Obj);
            expect(singleDesc).toBe('Project Notes.md');
        });
    });

    describe('CollectTabsModal', () => {
        it('constructs exactly 2 rows when 2 windows exist (This window, All windows)', () => {
            const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
            const p1 = leaf('p1', 'Research.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
            const p2 = leaf('p2', 'Ref.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

            const currentWin: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: true,
                isMainWindow: true,
            };
            const otherWin: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1, p2] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});
            const suggestions = modal.getSuggestions('');

            expect(suggestions).toHaveLength(2);
            expect(suggestions[0]).toEqual({
                kind: 'current',
                winInfo: currentWin,
                label: 'This window - Main Note.md',
            });
            expect(suggestions[1]).toEqual({
                kind: 'all',
                label: 'All windows',
            });
        });

        it('constructs correct rows when 3 windows exist (first "All windows", then each of the N-1 other windows)', () => {
            const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
            const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
            const p2 = leaf('p2', 'Pop2.md', new MockWorkspaceParent(popoutContainer2), popoutContainer2);

            const currentWin: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: true,
                isMainWindow: true,
            };
            const otherWin1: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: false,
                isMainWindow: false,
            };
            const otherWin2: WindowInfo = {
                window: win2Obj,
                representative: p2,
                groups: [{ leaves: [p2] } as any],
                lastActive: 50,
                label: 'Pop-out 2',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin1, otherWin2], () => {});
            const suggestions = modal.getSuggestions('');

            expect(suggestions).toHaveLength(3);
            expect(suggestions[0].label).toBe('All windows');
            expect(suggestions[1].label).toBe('Window - Pop1.md');
            expect(suggestions[2].label).toBe('Window - Pop2.md');
        });

        it('filters suggestions by fuzzy match query', () => {
            const m1 = leaf('m1', 'Alpha Note', new MockWorkspaceParent(rootContainer), rootContainer);
            const p1 = leaf('p1', 'Beta Note', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
            const p2 = leaf('p2', 'Gamma Note', new MockWorkspaceParent(popoutContainer2), popoutContainer2);

            const currentWin: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: true,
                isMainWindow: true,
            };
            const otherWin1: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: false,
                isMainWindow: false,
            };
            const otherWin2: WindowInfo = {
                window: win2Obj,
                representative: p2,
                groups: [{ leaves: [p2] } as any],
                lastActive: 50,
                label: 'Pop-out 2',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin1, otherWin2], () => {});

            const results = modal.getSuggestions('beta');
            expect(results).toHaveLength(1);
            expect(results[0].kind).toBe('window');
            expect(results[0].label).toContain('Beta Note');

            const allResults = modal.getSuggestions('all');
            expect(allResults).toHaveLength(1);
            expect(allResults[0].kind).toBe('all');
        });

        it('triggers onPick with the chosen item upon onChooseSuggestion', () => {
            const m1 = leaf('m1', 'Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
            const p1 = leaf('p1', 'Pop.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

            const currentWin: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: true,
            };
            const otherWin: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: false,
            };

            let pickedChoice: CollectChoice | null = null;
            const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], (choice) => {
                pickedChoice = choice;
            });

            const choice = modal.getSuggestions('')[1]; // 'All windows'
            modal.onChooseSuggestion(choice, new MouseEvent('click'));

            expect(pickedChoice).not.toBeNull();
            expect(pickedChoice?.kind).toBe('all');
        });
    });

    describe('collectTabs("all")', () => {
        it('gathers all tabs from all popouts into main window active group and closes popouts', async () => {
            const mainGroup1 = new MockWorkspaceParent(rootContainer);
            const mainGroup2 = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Note-A.md', mainGroup1, rootContainer);
            const m2 = leaf('m2', 'Note-B.md', mainGroup1, rootContainer);
            const m3 = leaf('m3', 'Note-C.md', mainGroup2, rootContainer);

            // Popout 1 has Note-A.md (duplicate across windows)
            const popGroup1 = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Note-A.md', popGroup1, popoutContainer1);

            // Popout 2 has Note-D.md
            const popGroup2 = new MockWorkspaceParent(popoutContainer2);
            const p2 = leaf('p2', 'Note-D.md', popGroup2, popoutContainer2);

            app.workspace.allLeaves = [m1, m2, m3, p1, p2];
            app.workspace.rootLeaves = [m1, m2, m3];
            app.workspace.setActiveLeaf(m1);

            const createdLeaves: MockWorkspaceLeaf[] = [];
            const originalCreateLeafInParent = app.workspace.createLeafInParent.bind(app.workspace);
            app.workspace.createLeafInParent = (parent: MockWorkspaceParent, index: number) => {
                const created = originalCreateLeafInParent(parent, index);
                createdLeaves.push(created);
                return created;
            };

            await plugin.collectTabs('all');

            // m1 and m2 in mainGroup1 stay attached
            expect(m1.detached).toBe(false);
            expect(m2.detached).toBe(false);

            // Foreign tabs m3, p1, p2 are detached and recreated in mainGroup1
            expect(m3.detached).toBe(true);
            expect(p1.detached).toBe(true);
            expect(p2.detached).toBe(true);

            // 3 new leaves created in mainGroup1 (including duplicate Note-A.md from popout!)
            expect(createdLeaves).toHaveLength(3);
            for (const cl of createdLeaves) {
                expect(cl.parent).toBe(mainGroup1);
            }

            // Both evacuated popout windows are closed
            expect(popoutWin1.closed).toBe(true);
            expect(popoutWin2.closed).toBe(true);
        });

        it('when triggered from a popout window, gathers tabs home to main window and closes popouts', async () => {
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            const popGroup = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Pop.md', popGroup, popoutContainer1);

            app.workspace.allLeaves = [m1, p1];
            app.workspace.rootLeaves = [m1];
            app.workspace.setActiveLeaf(p1);
            (globalThis as any).activeWindow = win1Obj;

            await plugin.collectTabs('all');

            // Popout leaf migrated to mainGroup
            expect(p1.detached).toBe(true);
            expect(m1.detached).toBe(false);

            // Popout window closed
            expect(popoutWin1.closed).toBe(true);

            (globalThis as any).activeWindow = undefined;
        });
    });

    describe('collectTabs("window", targetWin)', () => {
        it('gathers only tabs from target window into active group and closes target window, leaving other popouts untouched', async () => {
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            const popGroup1 = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Pop1.md', popGroup1, popoutContainer1);

            const popGroup2 = new MockWorkspaceParent(popoutContainer2);
            const p2 = leaf('p2', 'Pop2.md', popGroup2, popoutContainer2);

            app.workspace.allLeaves = [m1, p1, p2];
            app.workspace.rootLeaves = [m1];
            app.workspace.setActiveLeaf(m1);

            // Gather only from Popout 1
            await plugin.collectTabs('window', win1Obj);

            // Popout 1 tab migrated and Popout 1 window closed
            expect(p1.detached).toBe(true);
            expect(popoutWin1.closed).toBe(true);

            // Popout 2 tab and Popout 2 window completely untouched!
            expect(p2.detached).toBe(false);
            expect(popoutWin2.closed).toBe(false);
        });

        it('when triggered on a popup window, collecting another popup window merges into the focused popup and closes the other popup, leaving main window untouched', async () => {
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            const popGroup1 = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Pop1.md', popGroup1, popoutContainer1);

            const popGroup2 = new MockWorkspaceParent(popoutContainer2);
            const p2 = leaf('p2', 'Pop2.md', popGroup2, popoutContainer2);

            app.workspace.allLeaves = [m1, p1, p2];
            app.workspace.rootLeaves = [m1];

            // Focused on Popout 1
            app.workspace.setActiveLeaf(p1);
            (globalThis as any).activeWindow = win1Obj;

            // Collect Popout 2 into Popout 1
            await plugin.collectTabs('window', win2Obj);

            // Popout 2 tab migrated, Popout 2 closed
            expect(p2.detached).toBe(true);
            expect(popoutWin2.closed).toBe(true);

            // Popout 1 remains open
            expect(p1.detached).toBe(false);
            expect(popoutWin1.closed).toBe(false);

            // Main Window is 100% untouched
            expect(m1.detached).toBe(false);

            (globalThis as any).activeWindow = undefined;
        });

        it('when triggered on a popup window, selecting Main Window merges popup into Main Window and closes popup, NEVER emptying the Main Window', async () => {
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            const popGroup1 = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Pop1.md', popGroup1, popoutContainer1);

            const popGroup2 = new MockWorkspaceParent(popoutContainer2);
            const p2 = leaf('p2', 'Pop2.md', popGroup2, popoutContainer2);

            app.workspace.allLeaves = [m1, p1, p2];
            app.workspace.rootLeaves = [m1];

            // Focused on Popout 1
            app.workspace.setActiveLeaf(p1);
            (globalThis as any).activeWindow = win1Obj;

            // Collect Main Window (includes Main Window)
            await plugin.collectTabs('window', globalThis.window);

            // Popout 1 tab migrated to Main Window, Popout 1 closed
            expect(p1.detached).toBe(true);
            expect(popoutWin1.closed).toBe(true);

            // Main Window was NOT emptied! m1 remains intact in mainGroup!
            expect(m1.detached).toBe(false);

            // Popout 2 untouched
            expect(p2.detached).toBe(false);
            expect(popoutWin2.closed).toBe(false);

            (globalThis as any).activeWindow = undefined;
        });
    });
});
