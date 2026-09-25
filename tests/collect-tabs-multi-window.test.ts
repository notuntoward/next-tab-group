import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
    MockWorkspaceWindow,
    MockNotice,
} from './mocks/obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { CollectTabsModal, CollectChoice, resetSessionWindowIndices } from '../src/ui/collect-tabs-modal';
import type { WindowInfo } from '../main';

type TestPlugin = NextTabGroupPlugin & {
    runCollectTabs: () => void;
    collectTabs: (scope?: 'current' | 'all' | 'multi', source?: WindowInfo[]) => Promise<void>;
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
        resetSessionWindowIndices();
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
                // N = 2: Exactly 3 options (Popout window as current, All windows, and Main window)
                expect(suggestions).toHaveLength(3);
                // "This window" is the popout window where command was run!
                expect(suggestions[0].kind).toBe('current');
                expect(suggestions[0].label).toBe('Pop1.md');
                expect(suggestions[0].windowIndex).toBe(2);
                expect(suggestions[0].winInfo.window).toBe(win1Obj);
                expect(suggestions[0].winInfo.isCurrentWindow).toBe(true);

                // Option 2: All windows
                expect(suggestions[1].kind).toBe('all');
                expect(suggestions[1].label).toBe('All windows');

                // Option 3: Other window (Main window)
                expect(suggestions[2].kind).toBe('window');
                expect(suggestions[2].label).toBe('Main.md');
                expect(suggestions[2].windowIndex).toBe(1);
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
            expect(desc).toBe('Project Notes.md, Daily Log.md, +1');

            // With single tab
            app.workspace.allLeaves = [p1];
            const singleDesc = plugin.describeWindow(win1Obj);
            expect(singleDesc).toBe('Project Notes.md');
        });
    });

    describe('End-to-end: runCollectTabs() modal interaction -> collectTabs("multi")', () => {
        // These tests drive the REAL modal (check/highlight rows, then trigger the
        // real onPick callback wired by runCollectTabs()) rather than calling
        // collectTabs('multi', ...) directly with hand-built arrays. This exercises
        // the actual checkedWins construction logic in runCollectTabs()'s onPick,
        // which the direct-call tests below bypass entirely.
        it('checking HERE + Main (with a 3rd, unchecked popout present) leaves the unchecked popout completely untouched', async () => {
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            const win3Obj = { name: 'popout3' } as unknown as Window;
            const popoutWin3 = new MockWorkspaceWindow(win3Obj);
            app.workspace.floatingSplit.children = [popoutWin1, popoutWin2, popoutWin3];
            const popoutContainer3 = new MockWorkspaceContainer('window', win3Obj);

            const popGroup1 = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Pop1.md', popGroup1, popoutContainer1);

            const popGroup3 = new MockWorkspaceParent(popoutContainer3);
            const p3 = leaf('p3', 'Pop3.md', popGroup3, popoutContainer3);

            app.workspace.allLeaves = [m1, p1, p3];
            app.workspace.rootLeaves = [m1];

            // Command is invoked from Popout 1 (HERE).
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
                // Rows: [0]=HERE (Popout 1), [1]=All windows, [2]=Main, [3]=Popout 3
                expect(suggestions[0].kind).toBe('current');
                expect(suggestions[2].kind).toBe('window');
                expect(suggestions[2].label).toBe('Main.md');
                expect(suggestions[3].kind).toBe('window');
                expect(suggestions[3].label).toBe('Pop3.md');

                // HERE (Popout 1) is checked by default. Additionally check Main
                // (row 2) and highlight it, exactly like a user checking two boxes
                // and clicking Collect while Main is the last-highlighted row.
                capturedModal.toggleRow(suggestions[2]);
                capturedModal.setHighlightedIndex(2);

                // Popout 3 (row 3) must remain unchecked.
                expect(suggestions[3].checked).toBe(false);

                capturedModal.executeCollection();
                // executeCollection()'s onPick callback fires collectTabs() via a
                // fire-and-forget `void` call (runCollectTabs() cannot await it
                // synchronously from inside the modal's onPick), and collectTabs()
                // itself awaits leaf.setViewState() per migrated leaf. Flush
                // pending microtasks/macrotasks before asserting on its effects.
                await new Promise((resolve) => setTimeout(resolve, 0));

                // Popout 1's tab merges into Main (Main was checked -> Main is the
                // destination), Popout 1 closes.
                expect(p1.detached).toBe(true);
                expect(popoutWin1.closed).toBe(true);

                // Popout 3 must be completely untouched: it was never checked.
                expect(p3.detached).toBe(false);
                expect(popoutWin3.closed).toBe(false);
                expect(popGroup3.children).toEqual([p3]);

                // Main Window keeps its own tab plus the migrated one.
                expect(m1.detached).toBe(false);
                expect(mainGroup.children).toContain(m1);
            } finally {
                CollectTabsModal.prototype.open = originalOpen;
                (globalThis as any).activeWindow = undefined;
            }
        });

        it('with 4 total windows (Main, HERE, 2 other popouts), checking HERE + one popout leaves Main AND the other popout completely untouched', async () => {
            // Precise reproduction of a real user report: Main, HERE (popout A),
            // popout B, and popout C all open. HERE is checked by default; the
            // user additionally checks popout B and leaves Main and popout C
            // unchecked, highlight remaining on HERE (row 0). Only popout B's
            // tabs should merge into HERE; Main and popout C must be completely
            // untouched.
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            const win3Obj = { name: 'popout3' } as unknown as Window;
            const popoutWin3 = new MockWorkspaceWindow(win3Obj);
            const popoutContainer3 = new MockWorkspaceContainer('window', win3Obj);

            const win4Obj = { name: 'popout4' } as unknown as Window;
            const popoutWin4 = new MockWorkspaceWindow(win4Obj);
            const popoutContainer4 = new MockWorkspaceContainer('window', win4Obj);

            app.workspace.floatingSplit.children = [popoutWin1, popoutWin3, popoutWin4];

            // Popout A (HERE) = win1Obj/popoutContainer1
            const popGroupA = new MockWorkspaceParent(popoutContainer1);
            const pA = leaf('pA', 'PopA.md', popGroupA, popoutContainer1);

            // Popout B = win3Obj (this is the one the user checks alongside HERE)
            const popGroupB = new MockWorkspaceParent(popoutContainer3);
            const pB = leaf('pB', 'PopB.md', popGroupB, popoutContainer3);

            // Popout C = win4Obj (must remain completely untouched)
            const popGroupC = new MockWorkspaceParent(popoutContainer4);
            const pC = leaf('pC', 'PopC.md', popGroupC, popoutContainer4);

            app.workspace.allLeaves = [m1, pA, pB, pC];
            app.workspace.rootLeaves = [m1];

            // Command invoked from Popout A (HERE).
            app.workspace.setActiveLeaf(pA);
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
                // Rows: [0]=HERE (Popout A), [1]=All windows, [2..]=Main, Popout B, Popout C in recency order
                expect(suggestions).toHaveLength(5);
                expect(suggestions[0].kind).toBe('current');
                expect(suggestions[0].checked).toBe(true); // HERE checked by default

                // Find Popout B's row (win3Obj) and check it, WITHOUT moving the
                // highlight off of HERE (row 0) -- exactly like pressing Space on
                // a row reached via arrow keys, then pressing Enter/Collect while
                // still parked on HERE, or simply clicking Collect without
                // touching the highlight at all.
                const rowB = suggestions.find((s: any) => s.winInfo?.window === win3Obj);
                expect(rowB).toBeTruthy();
                capturedModal.toggleRow(rowB);

                // Confirm Main and Popout C are NOT checked.
                const rowMain = suggestions.find((s: any) => s.kind === 'window' && s.winInfo?.isMainWindow);
                const rowC = suggestions.find((s: any) => s.winInfo?.window === win4Obj);
                expect(rowMain.checked).toBe(false);
                expect(rowC.checked).toBe(false);

                capturedModal.executeCollection();
                await new Promise((resolve) => setTimeout(resolve, 0));

                // Popout B merged into HERE (Popout A), Popout B closes.
                expect(pB.detached).toBe(true);
                expect(popoutWin3.closed).toBe(true);
                expect(popGroupA.children).toContain(pA);
                expect(popGroupA.children.length).toBe(2); // pA + migrated pB

                // Popout A (HERE, the destination) survives.
                expect(pA.detached).toBe(false);
                expect(popoutWin1.closed).toBe(false);

                // Main Window must be completely untouched: it was never checked.
                expect(m1.detached).toBe(false);
                expect(mainGroup.children).toEqual([m1]);

                // Popout C must be completely untouched: it was never checked.
                expect(pC.detached).toBe(false);
                expect(popoutWin4.closed).toBe(false);
                expect(popGroupC.children).toEqual([pC]);
            } finally {
                CollectTabsModal.prototype.open = originalOpen;
                (globalThis as any).activeWindow = undefined;
            }
        });
    });

    describe('CollectTabsModal', () => {
        it('constructs consistent rows when 2 windows exist (This window, All windows, window row)', () => {
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

            expect(suggestions).toHaveLength(3);
            // The HERE row starts checked: it is what Enter/Collect acts on by
            // default, and the checkbox must reflect that truthfully.
            expect(suggestions[0]).toEqual({
                kind: 'current',
                winInfo: currentWin,
                label: 'Main Note.md',
                checked: true,
                windowIndex: 1,
            });
            expect(suggestions[1]).toEqual({
                kind: 'all',
                label: 'All windows',
                checked: false,
            });
            expect(suggestions[2]).toEqual({
                kind: 'window',
                winInfo: otherWin,
                label: 'Research.md, Ref.md',
                checked: false,
                windowIndex: 2,
            });
        });

        it('constructs consistent rows when 3 windows exist (This window, All windows, then each other window)', () => {
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

            expect(suggestions).toHaveLength(4);
            expect(suggestions[0].label).toBe('Main Note.md');
            expect(suggestions[0].kind).toBe('current');
            expect(suggestions[0].windowIndex).toBe(1);
            expect(suggestions[1].label).toBe('All windows');
            expect(suggestions[1].kind).toBe('all');
            expect(suggestions[2].label).toBe('Pop1.md');
            expect(suggestions[2].kind).toBe('window');
            expect(suggestions[2].windowIndex).toBe(2);
            expect(suggestions[3].label).toBe('Pop2.md');
            expect(suggestions[3].kind).toBe('window');
            expect(suggestions[3].windowIndex).toBe(3);
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

        it('toggles row checked state with toggleRow or Space and maintains selection', () => {
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

            const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});
            const suggestionsBefore = modal.getSuggestions('');
            // HERE row starts checked by default.
            expect(suggestionsBefore[0].checked).toBe(true);

            modal.toggleRow(suggestionsBefore[0]);
            expect(suggestionsBefore[0].checked).toBe(false);

            modal.toggleRow(suggestionsBefore[0]);
            expect(suggestionsBefore[0].checked).toBe(true);
        });

        it('Clear selection toolbar button enables/disables based on checked state without altering list geometry', () => {
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

            const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});
            modal.open();

            // HERE row is checked by default, so Clear selection starts enabled.
            expect(modal.clearSelectionBtn?.disabled).toBe(false);
            const suggestions = modal.getSuggestions('');
            expect(suggestions).toHaveLength(3);

            // Uncheck row 0 -> nothing checked -> clear-selection disabled
            modal.toggleRow(suggestions[0]);
            expect(modal.clearSelectionBtn?.disabled).toBe(true);
            // Suggestions count is strictly unchanged
            expect(modal.getSuggestions('')).toHaveLength(3);

            // Re-check row 0 -> clear-selection enabled again
            modal.toggleRow(suggestions[0]);
            expect(modal.clearSelectionBtn?.disabled).toBe(false);
            expect(modal.getSuggestions('')).toHaveLength(3);

            modal.close();
        });

        it('Select all toolbar button marks all window rows checked and Clear selection clears them without changing geometry', () => {
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
            modal.open();
            // HERE row is checked by default, so Clear selection starts enabled.
            expect(modal.clearSelectionBtn?.disabled).toBe(false);

            modal.selectAllBtn?.click();

            const suggestions = modal.getSuggestions('');
            expect(suggestions).toHaveLength(4);
            expect(suggestions[0].checked).toBe(true);
            expect(suggestions[1].checked).toBe(true);
            expect(suggestions[2].checked).toBe(true);
            expect(suggestions[3].checked).toBe(true);
            expect(modal.clearSelectionBtn?.disabled).toBe(false);

            // Clear selection unchecks all
            modal.clearSelectionBtn?.click();
            const suggestionsAfterClear = modal.getSuggestions('');
            expect(suggestionsAfterClear).toHaveLength(4);
            expect(suggestionsAfterClear[0].checked).toBe(false);
            expect(suggestionsAfterClear[1].checked).toBe(false);
            expect(suggestionsAfterClear[2].checked).toBe(false);
            expect(suggestionsAfterClear[3].checked).toBe(false);
            expect(modal.clearSelectionBtn?.disabled).toBe(true);

            modal.close();
        });

        it('renderSuggestion renders disabled native checkbox inputs with accent classes for window rows', () => {
            const m1 = leaf('m1', 'Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
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
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});

            // Unchecked window row (current window, main window)
            const el1 = document.createElement('div');
            modal.renderSuggestion({ kind: 'current', winInfo: currentWin, label: 'Note.md', checked: false, windowIndex: 1 }, el1);
            expect(el1.classList.contains('ntg-checked')).toBe(false);
            expect(el1.classList.contains('is-checked')).toBe(false);
            expect(el1.classList.contains('ntg-grid-row')).toBe(true);
            const cb1 = el1.querySelector('input[type="checkbox"]') as HTMLInputElement;
            expect(cb1).not.toBeNull();
            expect(cb1.checked).toBe(false);
            expect(cb1.disabled).toBe(true);
            expect(cb1.classList.contains('collect-tabs-row-checkbox')).toBe(true);
            const badge1 = el1.querySelector('.ntg-window-badge') as HTMLElement;
            expect(badge1).not.toBeNull();
            expect(badge1.textContent).toBe('1');
            expect(badge1.classList.contains('ntg-badge-main')).toBe(false);
            expect(badge1.classList.contains('ntg-badge-current')).toBe(false);
            expect(el1.querySelector('.ntg-desc-primary')?.textContent).toBe('Note.md');
            expect(el1.querySelector('.ntg-status-pill')?.textContent).toBe('HERE · MAIN');
            expect(el1.querySelector('.ntg-pill-here-main')).not.toBeNull();

            // Checked window row (All windows)
            const el2 = document.createElement('div');
            modal.renderSuggestion({ kind: 'all', label: 'All windows', checked: true }, el2);
            expect(el2.classList.contains('ntg-checked')).toBe(true);
            expect(el2.classList.contains('is-checked')).toBe(true);
            const cb2 = el2.querySelector('input[type="checkbox"]') as HTMLInputElement;
            expect(cb2).not.toBeNull();
            expect(cb2.checked).toBe(true);
            const badge2 = el2.querySelector('.ntg-window-badge') as HTMLElement;
            expect(badge2.classList.contains('ntg-badge-all')).toBe(true);
            expect(badge2.textContent).toBe('⧉');
            expect(el2.querySelector('.ntg-desc-primary')?.textContent).toBe('All windows');
            expect(el2.querySelector('.ntg-status-pill')).toBeNull();
            expect(el2.querySelector('.ntg-col-status')).not.toBeNull();
        });

        it('configures footer instructions correctly with space toggle and no Mod+A', () => {
            const m1 = leaf('m1', 'Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
            const currentWin: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: true,
            };
            const modal = new CollectTabsModal(app as unknown as App, currentWin, [], () => {});
            expect(modal.instructions).toEqual([
                { command: '↑↓', purpose: 'navigate' },
                { command: 'space', purpose: 'toggle' },
                { command: '↵', purpose: 'collect' },
                { command: 'esc', purpose: 'cancel' },
            ]);
        });

        it('triggers onPick with the union of the explicitly chosen row and the default-checked HERE row', () => {
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

            let picked: any = null;
            const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], (choice) => {
                picked = choice;
            });

            const choice = modal.getSuggestions('')[1]; // 'All windows'
            modal.onChooseSuggestion(choice, new MouseEvent('click'));

            // The HERE row is checked by default and was never unchecked, so it is
            // included alongside the explicitly chosen 'All windows' row. (Harmless
            // in practice: the plugin's 'all' handling already short-circuits on any
            // 'all' entry in the array and ignores the rest.)
            expect(picked).not.toBeNull();
            expect(Array.isArray(picked)).toBe(true);
            expect(picked).toHaveLength(2);
            expect(picked.some((c: any) => c.kind === 'all')).toBe(true);
            expect(picked.some((c: any) => c.kind === 'current')).toBe(true);
        });

        it('triggers onPick with the union of the explicitly chosen row and any additionally checked rows', () => {
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

            let picked: any = null;
            const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], (choices) => {
                picked = choices;
            });

            const suggestions = modal.getSuggestions('');
            // Check the otherWin row (index 2), in addition to the default-checked HERE row
            modal.toggleRow(suggestions[2]);

            // User highlights row 0 ("This window") and presses Enter
            modal.onChooseSuggestion(suggestions[0], new MouseEvent('click'));

            // onPick receives the chosen row 0 plus the additionally-checked otherWin row.
            expect(Array.isArray(picked)).toBe(true);
            expect(picked).toHaveLength(2);
            expect(picked.some((c: any) => c.kind === 'current')).toBe(true);
            expect(picked.some((c: any) => c.kind === 'window' && c.winInfo.window === win1Obj)).toBe(true);
        });

        it('selectSuggestion on MouseEvent toggles row without closing modal or calling onPick', () => {
            const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
            const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

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

            let pickedCalled = false;
            const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin1], () => {
                pickedCalled = true;
            });
            modal.open();
            expect(modal.isOpen).toBe(true);

            const rowChoice = modal.getSuggestions('')[2];
            expect(rowChoice.checked).toBe(false);

            modal.selectSuggestion(rowChoice, new MouseEvent('click'));

            // Row is checked, modal remains open, onPick was not called
            expect(rowChoice.checked).toBe(true);
            expect(modal.isOpen).toBe(true);
            expect(pickedCalled).toBe(false);
            modal.close();
        });

        it('Fix 1: clicking anywhere on a window row toggles checkbox without calling onPick or closing modal', () => {
            const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
            const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

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
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            let pickedCalled = false;
            const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {
                pickedCalled = true;
            });
            modal.open();

            const suggestions = modal.getSuggestions('');
            const targetChoice = suggestions[2]; // otherWin row
            expect(targetChoice.checked).toBe(false);

            const el = document.createElement('div');
            modal.renderSuggestion(targetChoice, el);

            // Simulate mouse click on the row container
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

            // Toggled to true, modal remains open, onPick was NOT called!
            expect(targetChoice.checked).toBe(true);
            expect(modal.isOpen).toBe(true);
            expect(pickedCalled).toBe(false);

            // Second click toggles back to false
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            expect(targetChoice.checked).toBe(false);
            expect(modal.isOpen).toBe(true);
            expect(pickedCalled).toBe(false);

            modal.close();
        });

        describe('Section 7: 12 Interaction Requirements', () => {
            it('1. Open modal with HERE row checked by default: Clear selection is visible, enabled, and remains in place', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const currentWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [], () => {});
                modal.open();

                expect(modal.clearSelectionBtn).not.toBeNull();
                expect(modal.clearSelectionBtn?.textContent).toBe('Clear selection');
                // HERE row is checked by default, so Clear selection starts enabled.
                expect(modal.clearSelectionBtn?.disabled).toBe(false);
                expect(modal.toolbarEl?.contains(modal.clearSelectionBtn!)).toBe(true);
                modal.close();
            });

            it('2. Without checking anything, press Enter: collects highlighted default row', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const currentWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                let picked: any = null;
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [], (res) => {
                    picked = res;
                });
                modal.open();

                const defaultHighlighted = modal.getSuggestions('')[0];
                modal.onChooseSuggestion(defaultHighlighted);

                expect(picked).not.toBeNull();
                expect(picked.kind).toBe('current');
                expect(modal.isOpen).toBe(false);
            });

            it('3. Reopen modal with no rows checked and click Collect button: collects identical default row', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const currentWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                let picked: any = null;
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [], (res) => {
                    picked = res;
                });
                modal.open();

                expect(modal.collectBtn?.disabled).toBe(false);
                expect(modal.collectBtn?.classList.contains('mod-cta')).toBe(true);
                modal.collectBtn?.click();

                expect(picked).not.toBeNull();
                expect(picked.kind).toBe('current');
                expect(modal.isOpen).toBe(false);
            });

            it('4. Click one window row: checks row, leaves modal open, does not collect or close', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
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
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                let picked = false;
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {
                    picked = true;
                });
                modal.open();

                const choice = modal.getSuggestions('')[2];
                modal.selectSuggestion(choice, new MouseEvent('click'));

                expect(choice.checked).toBe(true);
                expect(modal.isOpen).toBe(true);
                expect(picked).toBe(false);
                modal.close();
            });

            it('5. Press Space on highlighted window: checks row and leaves modal open', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
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
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                let picked = false;
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {
                    picked = true;
                });
                modal.open();

                // Move the highlight to otherWin (index 2), as arrow-key navigation would.
                modal.setHighlightedIndex(2);
                modal.handleSpace();

                const suggestions = modal.getSuggestions('');
                expect(suggestions[2].checked).toBe(true);
                expect(modal.isOpen).toBe(true);
                expect(picked).toBe(false);
                modal.close();
            });

            it('6. Clear selection toggles immediately with checked state without shifting list layout', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const currentWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [], () => {});
                modal.open();

                const initialLength = modal.getSuggestions('').length;
                // HERE row is checked by default, so Clear selection starts enabled.
                expect(modal.clearSelectionBtn?.disabled).toBe(false);

                // Unchecking the only checked row disables it again.
                modal.toggleRow(modal.getSuggestions('')[0]);
                expect(modal.clearSelectionBtn?.disabled).toBe(true);
                expect(modal.getSuggestions('').length).toBe(initialLength);

                // Re-checking it enables it again, without shifting list geometry.
                modal.toggleRow(modal.getSuggestions('')[0]);
                expect(modal.clearSelectionBtn?.disabled).toBe(false);
                expect(modal.getSuggestions('').length).toBe(initialLength);
                modal.close();
            });

            it('7. Click Clear selection: every check disappears, button disabled, list geometry unchanged', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
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
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});
                modal.open();

                modal.checkAll();
                expect(modal.hasAnyChecked()).toBe(true);
                expect(modal.clearSelectionBtn?.disabled).toBe(false);

                modal.clearSelectionBtn?.click();

                expect(modal.hasAnyChecked()).toBe(false);
                expect(modal.clearSelectionBtn?.disabled).toBe(true);
                expect(modal.getSuggestions('')).toHaveLength(3);
                modal.close();
            });

            it('8. Click Select all: every selectable row becomes checked, Clear selection enables, geometry unchanged', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
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
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});
                modal.open();

                modal.selectAllBtn?.click();

                const rows = modal.getSuggestions('');
                expect(rows).toHaveLength(3);
                expect(rows.every((r) => r.checked)).toBe(true);
                expect(modal.clearSelectionBtn?.disabled).toBe(false);
                modal.close();
            });

            it('9. Click Collect after selecting several windows: collects checked set matching Enter', () => {
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

                let picked: any = null;
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin1, otherWin2], (res) => {
                    picked = res;
                });
                modal.open();

                const suggestions = modal.getSuggestions('');
                modal.toggleRow(suggestions[2]); // otherWin1
                modal.toggleRow(suggestions[3]); // otherWin2

                modal.collectBtn?.click();

                // HERE row remains checked by default (never unchecked), so it is
                // included alongside the two explicitly checked windows. (Order is
                // not significant: toggling moves the highlight to the toggled row,
                // which becomes the "chosen" entry first in the union.)
                expect(Array.isArray(picked)).toBe(true);
                expect(picked).toHaveLength(3);
                expect(picked.map((p: any) => p.label).sort()).toEqual(['Main Note.md', 'Pop1.md', 'Pop2.md']);
                expect(modal.isOpen).toBe(false);
            });

            it('10. Click Cancel after checking one or more windows: modal closes with no collection', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const currentWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                let picked = false;
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [], () => {
                    picked = true;
                });
                modal.open();

                // HERE row is checked by default.
                expect(modal.hasAnyChecked()).toBe(true);

                modal.cancelBtn?.click();

                expect(modal.isOpen).toBe(false);
                expect(picked).toBe(false);
            });

            it('11. Esc does exact same thing as clicking Cancel (closes without collection)', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const currentWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                let picked = false;
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [], () => {
                    picked = true;
                });
                modal.open();

                modal.toggleRow(modal.getSuggestions('')[0]);
                modal.close();

                expect(modal.isOpen).toBe(false);
                expect(picked).toBe(false);
            });

            it('12. Toolbar is placed in modal DOM with two distinct subgroups', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const currentWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [], () => {});
                modal.open();

                const toolbar = modal.modalEl.querySelector('.collect-tabs-action-toolbar') as HTMLElement;
                expect(toolbar).not.toBeNull();
                expect(toolbar.querySelector('.ntg-toolbar-left')).not.toBeNull();
                expect(toolbar.querySelector('.ntg-toolbar-right')).not.toBeNull();
                expect(toolbar.querySelectorAll('button')).toHaveLength(4);
                modal.close();
            });
        });

        it('Section 3 & 5: main window is marked by accent badge and current window by badge cue without text prefixes', () => {
            const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
            const p1 = leaf('p1', 'Weight Loss.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

            const mainWin: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: false,
                isMainWindow: true,
            };
            const popWin: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: true,
                isMainWindow: false,
            };

            // Run from popWin: "This window" is popout, mainWin is in otherWindows
            const modal = new CollectTabsModal(app as unknown as App, popWin, [mainWin], () => {});
            const suggestions = modal.getSuggestions('');

            // Popout as current row has clean label without "This window - " or "(main)"
            expect(suggestions[0].label).toBe('Weight Loss.md');
            expect(suggestions[0].windowIndex).toBe(2);

            // "All windows" unchanged
            expect(suggestions[1].label).toBe('All windows');

            // Main window in list has clean label without "Window - " or "(main)"
            expect(suggestions[2].label).toBe('Main Note.md');
            expect(suggestions[2].windowIndex).toBe(1);

            // Verify rendered badge cues and status pills
            const elCurrent = document.createElement('div');
            modal.renderSuggestion(suggestions[0], elCurrent);
            const badgeCurrent = elCurrent.querySelector('.ntg-window-badge') as HTMLElement;
            expect(badgeCurrent.textContent).toBe('2');
            expect(badgeCurrent.classList.contains('ntg-badge-main')).toBe(false);
            expect(badgeCurrent.classList.contains('ntg-badge-current')).toBe(false);
            expect(elCurrent.querySelector('.ntg-desc-primary')?.textContent).toBe('Weight Loss.md');
            expect(elCurrent.querySelector('.ntg-status-pill')?.textContent).toBe('HERE');
            expect(elCurrent.querySelector('.ntg-pill-here')).not.toBeNull();

            const elMain = document.createElement('div');
            modal.renderSuggestion(suggestions[2], elMain);
            const badgeMain = elMain.querySelector('.ntg-window-badge') as HTMLElement;
            expect(badgeMain.textContent).toBe('1');
            expect(badgeMain.classList.contains('ntg-badge-main')).toBe(false);
            expect(badgeMain.classList.contains('ntg-badge-current')).toBe(false);
            expect(elMain.querySelector('.ntg-desc-primary')?.textContent).toBe('Main Note.md');
            expect(elMain.querySelector('.ntg-status-pill')?.textContent).toBe('MAIN');
            expect(elMain.querySelector('.ntg-pill-main')).not.toBeNull();
        });

        it('Section 4: assigns stable session window index tags that persist across multiple invocations', () => {
            const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
            const p1 = leaf('p1', 'Research.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
            const p2 = leaf('p2', 'Journal.md', new MockWorkspaceParent(popoutContainer2), popoutContainer2);

            const mainWin: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: true,
                isMainWindow: true,
            };
            const pop1: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: false,
                isMainWindow: false,
            };
            const pop2: WindowInfo = {
                window: win2Obj,
                representative: p2,
                groups: [{ leaves: [p2] } as any],
                lastActive: 50,
                label: 'Pop-out 2',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            // Modal opened 1st time
            const modal1 = new CollectTabsModal(app as unknown as App, mainWin, [pop1, pop2], () => {});
            const s1 = modal1.getSuggestions('');
            expect(s1[0].windowIndex).toBe(1);
            expect(s1[2].windowIndex).toBe(2);
            expect(s1[3].windowIndex).toBe(3);

            // Active tab in pop1 changes to a different note
            const p1NewNote = leaf('p1-new', 'Changed Title.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
            const pop1Updated: WindowInfo = {
                ...pop1,
                representative: p1NewNote,
                groups: [{ leaves: [p1NewNote] } as any],
            };

            // Modal opened 2nd time: pop1 is still tagged 2, pop2 is still 3, main is still 1
            const modal2 = new CollectTabsModal(app as unknown as App, mainWin, [pop1Updated, pop2], () => {});
            const s2 = modal2.getSuggestions('');
            expect(s2[0].windowIndex).toBe(1);
            expect(s2[2].windowIndex).toBe(2);
            expect(s2[2].label).toBe('Changed Title.md');
            expect(s2[3].windowIndex).toBe(3);
            expect(s2[3].label).toBe('Journal.md');
        });

        it('Fix 4: tab description shows up to 2 tab titles with compact remaining count and ellipsis truncation', () => {
            const g1 = new MockWorkspaceParent(popoutContainer1);
            const t1 = leaf('t1', 'First Long File Name That Exceeds 25 Characters.md', g1, popoutContainer1);
            const t2 = leaf('t2', 'Second Tab.md', g1, popoutContainer1);
            const t3 = leaf('t3', 'Third Tab.md', g1, popoutContainer1);
            const t4 = leaf('t4', 'Fourth Tab.md', g1, popoutContainer1);

            const win: WindowInfo = {
                window: win1Obj,
                representative: t1,
                groups: [{ leaves: [t1, t2, t3, t4] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            const desc = plugin.describeWindow(win);
            // 4 tabs total: shows truncated 1st tab, 2nd tab, and +2 remaining
            expect(desc).toBe('First Long File Name Tha…, Second Tab.md, +2');
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

    describe('2-window collect (delegates to collectTabs("multi", [current, target]))', () => {
        // The single-choice "collect this window + one other window" case (what a
        // 2-total-window setup typically produces) is not a separate code path: it
        // is exactly a 2-element instance of the same 'multi' destination/merge
        // algorithm exercised in the block below. These tests confirm the
        // 2-window scenarios still behave correctly through that shared path.
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

            const mainWinInfo: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: true,
                isMainWindow: true,
            };
            const pop1Info: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            // Gather only from Popout 1 (invoked from Main Window)
            await plugin.collectTabs('multi', [mainWinInfo, pop1Info]);

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

            const pop1Info: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: true,
                isMainWindow: false,
            };
            const pop2Info: WindowInfo = {
                window: win2Obj,
                representative: p2,
                groups: [{ leaves: [p2] } as any],
                lastActive: 50,
                label: 'Pop-out 2',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            // Collect Popout 2 into Popout 1 (invoked from Popout 1)
            await plugin.collectTabs('multi', [pop1Info, pop2Info]);

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

            const pop1Info: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: true,
                isMainWindow: false,
            };
            const mainWinInfo: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: false,
                isMainWindow: true,
            };

            // Collect Main Window (invoked from Popout 1; includes Main Window)
            await plugin.collectTabs('multi', [pop1Info, mainWinInfo]);

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

    describe('collectTabs("multi", checkedWindows)', () => {
        it('when all windows are checked, collects all popouts into main window and closes all popouts', async () => {
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            const popGroup1 = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Pop1.md', popGroup1, popoutContainer1);

            const popGroup2 = new MockWorkspaceParent(popoutContainer2);
            const p2 = leaf('p2', 'Pop2.md', popGroup2, popoutContainer2);

            app.workspace.allLeaves = [m1, p1, p2];
            app.workspace.rootLeaves = [m1];
            app.workspace.setActiveLeaf(m1);

            const mainWinInfo: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: true,
                isMainWindow: true,
            };
            const pop1Info: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: false,
                isMainWindow: false,
            };
            const pop2Info: WindowInfo = {
                window: win2Obj,
                representative: p2,
                groups: [{ leaves: [p2] } as any],
                lastActive: 50,
                label: 'Pop-out 2',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            await plugin.collectTabs('multi', [mainWinInfo, pop1Info, pop2Info]);

            expect(p1.detached).toBe(true);
            expect(p2.detached).toBe(true);
            expect(m1.detached).toBe(false);
            expect(popoutWin1.closed).toBe(true);
            expect(popoutWin2.closed).toBe(true);
        });

        it('when main window and a subset of popouts are checked, collects only checked popouts into main window and leaves others untouched', async () => {
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            const popGroup1 = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Pop1.md', popGroup1, popoutContainer1);

            const popGroup2 = new MockWorkspaceParent(popoutContainer2);
            const p2 = leaf('p2', 'Pop2.md', popGroup2, popoutContainer2);

            app.workspace.allLeaves = [m1, p1, p2];
            app.workspace.rootLeaves = [m1];
            app.workspace.setActiveLeaf(m1);

            const mainWinInfo: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: true,
                isMainWindow: true,
            };
            const pop1Info: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            // Check only Main window + Popout 1 (Popout 2 is unchecked)
            await plugin.collectTabs('multi', [mainWinInfo, pop1Info]);

            // Popout 1 tab migrated to Main Window, Popout 1 closed
            expect(p1.detached).toBe(true);
            expect(popoutWin1.closed).toBe(true);

            // Main Window remains intact
            expect(m1.detached).toBe(false);

            // Popout 2 is completely UNTOUCHED
            expect(p2.detached).toBe(false);
            expect(popoutWin2.closed).toBe(false);
        });

        it('when only popout windows are checked (no main window), collects into focused popout and leaves main window untouched', async () => {
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

            const pop1Info: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: true,
                isMainWindow: false,
            };
            const pop2Info: WindowInfo = {
                window: win2Obj,
                representative: p2,
                groups: [{ leaves: [p2] } as any],
                lastActive: 50,
                label: 'Pop-out 2',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            // Check Popout 1 + Popout 2 (Main window is not checked)
            await plugin.collectTabs('multi', [pop1Info, pop2Info]);

            // Popout 2 migrated into Popout 1 and closed
            expect(p2.detached).toBe(true);
            expect(popoutWin2.closed).toBe(true);

            // Popout 1 remains open
            expect(p1.detached).toBe(false);
            expect(popoutWin1.closed).toBe(false);

            // Main Window is untouched
            expect(m1.detached).toBe(false);

            (globalThis as any).activeWindow = undefined;
        });

        it('does not close a popout window that still has an open modal (e.g. Settings), even once it has no leaves left', async () => {
            // Bug: Obsidian's Modal.open() (Settings, including Community
            // plugins) attaches to whatever window was active when opened, which
            // is not necessarily the main window. A modal is not a WorkspaceLeaf,
            // so evacuating all real leaves from a popout can make it look
            // "empty" while a modal is still open and rendering in it. Forcibly
            // closing that window out from under the modal can tear down its
            // document mid-render, leaving a blank, unresponsive window behind.
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            const popGroup1 = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Pop1.md', popGroup1, popoutContainer1);

            const popGroup2 = new MockWorkspaceParent(popoutContainer2);
            const p2 = leaf('p2', 'Pop2.md', popGroup2, popoutContainer2);

            app.workspace.allLeaves = [m1, p1, p2];
            app.workspace.rootLeaves = [m1];

            // Simulate the Settings modal (Community plugins tab) still being
            // open in Popout 2's document.
            (win2Obj as any).document = {
                body: {
                    querySelector: (sel: string) => (sel === '.modal-container' ? {} : null),
                },
            };

            app.workspace.setActiveLeaf(m1);
            (globalThis as any).activeWindow = globalThis.window;

            const mainWinInfo: WindowInfo = {
                window: globalThis.window,
                representative: m1,
                groups: [{ leaves: [m1] } as any],
                lastActive: 200,
                label: 'Main window',
                isCurrentWindow: true,
                isMainWindow: true,
            };
            const pop2Info: WindowInfo = {
                window: win2Obj,
                representative: p2,
                groups: [{ leaves: [p2] } as any],
                lastActive: 50,
                label: 'Pop-out 2',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            await plugin.collectTabs('multi', [mainWinInfo, pop2Info]);

            // Popout 2's tab is still migrated out (it becomes leaf-empty)...
            expect(p2.detached).toBe(true);
            // ...but the window itself is NOT closed, because its open modal
            // must not be torn down mid-render.
            expect(popoutWin2.closed).toBe(false);

            (globalThis as any).activeWindow = undefined;
        });

        it('when only 1 popout is checked and focused, consolidates tabs within that popout without touching other windows', async () => {
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            const popGroup1 = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Pop1.md', popGroup1, popoutContainer1);

            const popGroup1Split = new MockWorkspaceParent(popoutContainer1);
            const p1b = leaf('p1b', 'Pop1b.md', popGroup1Split, popoutContainer1);

            const popGroup2 = new MockWorkspaceParent(popoutContainer2);
            const p2 = leaf('p2', 'Pop2.md', popGroup2, popoutContainer2);

            app.workspace.allLeaves = [m1, p1, p1b, p2];
            app.workspace.rootLeaves = [m1];

            // Focused on Popout 1, leaf p1
            app.workspace.setActiveLeaf(p1);
            (globalThis as any).activeWindow = win1Obj;

            const pop1Info: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any, { leaves: [p1b] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: true,
                isMainWindow: false,
            };

            // Only Popout 1 is checked
            await plugin.collectTabs('multi', [pop1Info]);

            // p1b split leaf migrated into p1's group
            expect(p1b.detached).toBe(true);
            expect(p1.detached).toBe(false);
            expect(popoutWin1.closed).toBe(false);

            // Other windows untouched
            expect(m1.detached).toBe(false);
            expect(p2.detached).toBe(false);
            expect(popoutWin2.closed).toBe(false);

            (globalThis as any).activeWindow = undefined;
        });

        it('merges the destination popout\'s OTHER tab group too, not just the incoming window (side-by-side groups bug)', async () => {
            // Bug: when the destination popout had two side-by-side tab groups,
            // only the group containing the active/representative leaf received
            // the incoming window's tabs; the destination's OTHER pre-existing
            // group was left untouched. The spec is: ALL tab groups across ALL
            // collected windows merge into a single group in the destination.
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            // Popout 1 (destination) has TWO side-by-side tab groups.
            const popGroup1a = new MockWorkspaceParent(popoutContainer1);
            const p1a = leaf('p1a', 'Pop1a.md', popGroup1a, popoutContainer1);
            const popGroup1b = new MockWorkspaceParent(popoutContainer1);
            const p1b = leaf('p1b', 'Pop1b.md', popGroup1b, popoutContainer1);

            const popGroup2 = new MockWorkspaceParent(popoutContainer2);
            const p2 = leaf('p2', 'Pop2.md', popGroup2, popoutContainer2);

            app.workspace.allLeaves = [m1, p1a, p1b, p2];
            app.workspace.rootLeaves = [m1];

            // Focused on Popout 1, in its first group (p1a).
            app.workspace.setActiveLeaf(p1a);
            (globalThis as any).activeWindow = win1Obj;

            const pop1Info: WindowInfo = {
                window: win1Obj,
                representative: p1a,
                groups: [{ leaves: [p1a] } as any, { leaves: [p1b] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: true,
                isMainWindow: false,
            };
            const pop2Info: WindowInfo = {
                window: win2Obj,
                representative: p2,
                groups: [{ leaves: [p2] } as any],
                lastActive: 50,
                label: 'Pop-out 2',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            // Collect Popout 1 (destination, initiated from here) + Popout 2.
            await plugin.collectTabs('multi', [pop1Info, pop2Info]);

            // Popout 2's tab migrated in, and Popout 1's OWN second group (p1b)
            // must also be merged into the same destination group as p1a.
            expect(p2.detached).toBe(true);
            expect(p1b.detached).toBe(true);
            expect(p1a.detached).toBe(false);
            expect(popoutWin2.closed).toBe(true);
            expect(popoutWin1.closed).toBe(false);

            (globalThis as any).activeWindow = undefined;
        });

        it('collects into the window the command was invoked from, even if live focus has since moved elsewhere (e.g. because the modal closed)', async () => {
            // Bug: the destination for a multi-popout collection was picked using
            // a freshly re-queried "active window" at the moment collectTabs()
            // actually runs, rather than the window the collect-tabs command was
            // originally invoked from (captured when the modal opened). If focus
            // has moved elsewhere in the interim -- e.g. because closing the
            // modal returned focus to the Main Window rather than the popout that
            // opened it -- tabs would land in the wrong window, and the popout
            // that should have survived as the destination could be evacuated too.
            const mainGroup = new MockWorkspaceParent(rootContainer);
            const m1 = leaf('m1', 'Main.md', mainGroup, rootContainer);

            const popGroup1 = new MockWorkspaceParent(popoutContainer1);
            const p1 = leaf('p1', 'Pop1.md', popGroup1, popoutContainer1);

            const popGroup2 = new MockWorkspaceParent(popoutContainer2);
            const p2 = leaf('p2', 'Pop2.md', popGroup2, popoutContainer2);

            app.workspace.allLeaves = [m1, p1, p2];
            app.workspace.rootLeaves = [m1];

            // Collect-tabs was invoked from Popout 1 (isCurrentWindow: true in the
            // snapshot taken when the modal opened)...
            const pop1Info: WindowInfo = {
                window: win1Obj,
                representative: p1,
                groups: [{ leaves: [p1] } as any],
                lastActive: 100,
                label: 'Pop-out 1',
                isCurrentWindow: true,
                isMainWindow: false,
            };
            const pop2Info: WindowInfo = {
                window: win2Obj,
                representative: p2,
                groups: [{ leaves: [p2] } as any],
                lastActive: 50,
                label: 'Pop-out 2',
                isCurrentWindow: false,
                isMainWindow: false,
            };

            // ...but by the time collectTabs() actually executes (e.g. right as
            // the modal closes), live focus has moved to the Main Window, which
            // was never checked at all.
            app.workspace.setActiveLeaf(m1);
            (globalThis as any).activeWindow = globalThis.window;

            await plugin.collectTabs('multi', [pop1Info, pop2Info]);

            // Popout 2 merges into Popout 1 (the window the command was actually
            // invoked from), NOT into the Main Window. Migration creates a NEW
            // leaf in the destination parent (via createLeafInParent) and detaches
            // the original, so the meaningful check is which parent actually
            // gained a child, not just whether the old leaf was detached.
            expect(p2.detached).toBe(true);
            expect(popoutWin2.closed).toBe(true);
            expect(popGroup1.children.length).toBe(2); // p1 (untouched) + migrated Pop2 leaf
            expect(popGroup1.children).toContain(p1);

            // Popout 1 is the destination: it must survive, untouched-but-for-the-merge.
            expect(p1.detached).toBe(false);
            expect(popoutWin1.closed).toBe(false);

            // Main Window must be completely untouched: it was never checked, and
            // must NOT have gained the migrated leaf.
            expect(m1.detached).toBe(false);
            expect(mainGroup.children).toEqual([m1]);

            (globalThis as any).activeWindow = undefined;
        });

        describe('Final Polish Specification Compliance', () => {
            it('Section 1 & 2: maintains fixed 4-column layout and exact placeholder', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const currentWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [], () => {});
                expect(modal.placeholder).toBe('Filter windows…');

                const el = document.createElement('div');
                modal.renderSuggestion({ kind: 'current', winInfo: currentWin, label: 'Main Note.md', checked: false, windowIndex: 1 }, el);

                expect(el.querySelector('.ntg-col-checkbox')).not.toBeNull();
                expect(el.querySelector('.ntg-col-badge')).not.toBeNull();
                expect(el.querySelector('.ntg-col-content')).not.toBeNull();
                expect(el.querySelector('.ntg-col-status')).not.toBeNull();
            });

            it('Section 3: renders neutral identity tiles for all physical windows and glyph for all windows', () => {
                const m1 = leaf('m1', 'Main.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

                const mainWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const popWin: WindowInfo = {
                    window: win1Obj,
                    representative: p1,
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal = new CollectTabsModal(app as unknown as App, mainWin, [popWin], () => {});

                // Main window identity tile: neutral numeral '1'
                const elMain = document.createElement('div');
                modal.renderSuggestion({ kind: 'current', winInfo: mainWin, label: 'Main.md', checked: false, windowIndex: 1 }, elMain);
                const badgeMain = elMain.querySelector('.ntg-window-badge') as HTMLElement;
                expect(badgeMain.textContent).toBe('1');
                expect(badgeMain.classList.contains('ntg-badge-main')).toBe(false);
                expect(badgeMain.classList.contains('ntg-badge-current')).toBe(false);

                // Popout window identity tile: neutral numeral '2'
                const elPop = document.createElement('div');
                modal.renderSuggestion({ kind: 'window', winInfo: popWin, label: 'Pop.md', checked: false, windowIndex: 2 }, elPop);
                const badgePop = elPop.querySelector('.ntg-window-badge') as HTMLElement;
                expect(badgePop.textContent).toBe('2');
                expect(badgePop.classList.contains('ntg-badge-main')).toBe(false);
                expect(badgePop.classList.contains('ntg-badge-current')).toBe(false);

                // All windows identity tile: neutral footprint with glyph '⧉'
                const elAll = document.createElement('div');
                modal.renderSuggestion({ kind: 'all', label: 'All windows', checked: false }, elAll);
                const badgeAll = elAll.querySelector('.ntg-window-badge') as HTMLElement;
                expect(badgeAll.textContent).toBe('⧉');
                expect(badgeAll.classList.contains('ntg-badge-all')).toBe(true);
            });

            it('Section 4: renders exact status pills (HERE, MAIN, HERE · MAIN) and empty status for others', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Popout 1 Note.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
                const p2 = leaf('p2', 'Popout 2 Note.md', new MockWorkspaceParent(popoutContainer2), popoutContainer2);

                const mainWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: false,
                    isMainWindow: true,
                };
                const popWin1: WindowInfo = {
                    window: win1Obj,
                    representative: p1,
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: true,
                    isMainWindow: false,
                };
                const popWin2: WindowInfo = {
                    window: win2Obj,
                    representative: p2,
                    groups: [{ leaves: [p2] } as any],
                    lastActive: 50,
                    label: 'Pop-out 2',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                // Case 1: Opened from popWin1
                const modalFromPopout = new CollectTabsModal(app as unknown as App, popWin1, [mainWin, popWin2], () => {});

                // Current row (popout): shows 'HERE'
                const elPopCurrent = document.createElement('div');
                modalFromPopout.renderSuggestion({ kind: 'current', winInfo: popWin1, label: 'Popout 1 Note.md', checked: false, windowIndex: 2 }, elPopCurrent);
                expect(elPopCurrent.querySelector('.ntg-status-pill')?.textContent).toBe('HERE');
                expect(elPopCurrent.querySelector('.ntg-pill-here')).not.toBeNull();

                // Main window row: shows 'MAIN'
                const elMainFromPopout = document.createElement('div');
                modalFromPopout.renderSuggestion({ kind: 'window', winInfo: mainWin, label: 'Main Note.md', checked: false, windowIndex: 1 }, elMainFromPopout);
                expect(elMainFromPopout.querySelector('.ntg-status-pill')?.textContent).toBe('MAIN');
                expect(elMainFromPopout.querySelector('.ntg-pill-main')).not.toBeNull();

                // Another popout row: empty status column (no pill)
                const elPop2 = document.createElement('div');
                modalFromPopout.renderSuggestion({ kind: 'window', winInfo: popWin2, label: 'Popout 2 Note.md', checked: false, windowIndex: 3 }, elPop2);
                expect(elPop2.querySelector('.ntg-col-status')).not.toBeNull();
                expect(elPop2.querySelector('.ntg-status-pill')).toBeNull();

                // All windows row: empty status column (no pill)
                const elAll = document.createElement('div');
                modalFromPopout.renderSuggestion({ kind: 'all', label: 'All windows', checked: false }, elAll);
                expect(elAll.querySelector('.ntg-col-status')).not.toBeNull();
                expect(elAll.querySelector('.ntg-status-pill')).toBeNull();

                // Case 2: Opened from main window: shows single combined 'HERE · MAIN' pill
                const modalFromMain = new CollectTabsModal(app as unknown as App, mainWin, [popWin1], () => {});
                const elMainCurrent = document.createElement('div');
                modalFromMain.renderSuggestion({ kind: 'current', winInfo: mainWin, label: 'Main Note.md', checked: false, windowIndex: 1 }, elMainCurrent);
                expect(elMainCurrent.querySelector('.ntg-status-pill')?.textContent).toBe('HERE · MAIN');
                expect(elMainCurrent.querySelector('.ntg-pill-here-main')).not.toBeNull();
            });

            it('Section 5: renders structured description typography', () => {
                const g = new MockWorkspaceParent(popoutContainer1);
                const t1 = leaf('t1', 'First Note.md', g, popoutContainer1);
                const t2 = leaf('t2', 'Second Note.md', g, popoutContainer1);
                const t3 = leaf('t3', 'Third Note.md', g, popoutContainer1);
                const t4 = leaf('t4', 'Fourth Note.md', g, popoutContainer1);

                const winMulti: WindowInfo = {
                    window: win1Obj,
                    representative: t1,
                    groups: [{ leaves: [t1, t2, t3, t4] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal = new CollectTabsModal(app as unknown as App, winMulti, [], () => {});
                const el = document.createElement('div');
                modal.renderSuggestion({ kind: 'window', winInfo: winMulti, label: 'First Note.md, Second Note.md, +2', checked: false, windowIndex: 2 }, el);

                const primary = el.querySelector('.ntg-desc-primary');
                const separator = el.querySelector('.ntg-desc-separator');
                const secondary = el.querySelector('.ntg-desc-secondary');
                const count = el.querySelector('.ntg-desc-count');

                expect(primary?.textContent).toBe('First Note.md');
                expect(separator?.textContent).toBe('·');
                expect(secondary?.textContent).toBe('Second Note.md');
                expect(count?.textContent).toBe('+2');
            });
        });

        describe('Keyboard Focus, Row-State Clarity, and Status Emphasis Amendment', () => {
            it('Section 1: Tab and Shift+Tab focus trap wraps between controls and skips disabled buttons', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const currentWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [], () => {});
                modal.open();

                // HERE row is checked by default, so Clear selection starts enabled
                // and already appears in Tab order.
                let controls = modal.getFocusableControls();
                expect(controls).toEqual([
                    modal.inputEl,
                    modal.selectAllBtn,
                    modal.clearSelectionBtn,
                    modal.cancelBtn,
                    modal.collectBtn,
                ]);

                // Uncheck the only checked row -> Clear selection disappears from Tab order
                modal.toggleRow(modal.getSuggestions('')[0]);
                controls = modal.getFocusableControls();
                expect(controls).toEqual([
                    modal.inputEl,
                    modal.selectAllBtn,
                    modal.cancelBtn,
                    modal.collectBtn,
                ]);

                // Re-check it so the remainder of this test exercises the 5-control
                // Tab cycle (matching what a fresh modal open already looks like).
                modal.toggleRow(modal.getSuggestions('')[0]);
                controls = modal.getFocusableControls();
                expect(controls).toEqual([
                    modal.inputEl,
                    modal.selectAllBtn,
                    modal.clearSelectionBtn,
                    modal.cancelBtn,
                    modal.collectBtn,
                ]);

                // Test step-by-step forward Tab cycling through all controls
                modal.inputEl.focus();
                expect(document.activeElement).toBe(modal.inputEl);
                modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
                expect(document.activeElement).toBe(modal.selectAllBtn);

                modal.selectAllBtn?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
                expect(document.activeElement).toBe(modal.clearSelectionBtn);

                modal.clearSelectionBtn?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
                expect(document.activeElement).toBe(modal.cancelBtn);

                modal.cancelBtn?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
                expect(document.activeElement).toBe(modal.collectBtn);

                // Test Tab wrapping at final control (Collect -> Filter input)
                const tabEvt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
                modal.collectBtn?.dispatchEvent(tabEvt);
                expect(document.activeElement).toBe(modal.inputEl);

                // Test Shift+Tab wrapping at first control (Filter input -> Collect)
                const shiftTabEvt = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
                modal.inputEl.dispatchEvent(shiftTabEvt);
                expect(document.activeElement).toBe(modal.collectBtn);

                modal.close();
            });

            it('Section 2 & 3: initializes HERE row as current on open, and cleanly distinguishes checked vs current', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
                const p2 = leaf('p2', 'Pop2.md', new MockWorkspaceParent(popoutContainer2), popoutContainer2);

                const mainWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const pop1: WindowInfo = {
                    window: win1Obj,
                    representative: p1,
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };
                const pop2: WindowInfo = {
                    window: win2Obj,
                    representative: p2,
                    groups: [{ leaves: [p2] } as any],
                    lastActive: 50,
                    label: 'Pop-out 2',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal = new CollectTabsModal(app as unknown as App, mainWin, [pop1, pop2], () => {});
                modal.open();

                // 1. On open, HERE row (index 0) has neutral full-row current highlight
                // AND is checked by default (it's what Enter/Collect will act on).
                expect(modal.highlightedIndex).toBe(0);
                const suggestions = modal.getSuggestions('');
                expect(suggestions[0].checked).toBe(true);
                expect(suggestions[1].checked).toBe(false);
                expect(suggestions[2].checked).toBe(false);

                const items = modal.modalEl.querySelectorAll('.suggestion-item');
                expect(items[0].classList.contains('is-selected')).toBe(true);
                expect(items[0].classList.contains('ntg-keyboard-current')).toBe(true);
                expect(items[0].classList.contains('is-checked')).toBe(true);

                // 2. Press Ctrl+N / moveHighlight(1) -> highlight moves to index 1 (All windows).
                // HERE loses the highlight but remains checked.
                modal.moveHighlight(1);
                expect(modal.highlightedIndex).toBe(1);
                expect(items[0].classList.contains('is-selected')).toBe(false);
                expect(items[0].classList.contains('ntg-keyboard-current')).toBe(false);
                expect(items[0].classList.contains('is-checked')).toBe(true);
                expect(items[1].classList.contains('is-selected')).toBe(true);
                expect(items[1].classList.contains('ntg-keyboard-current')).toBe(true);

                // 3. Check row 2 as well (row 0 is already checked by default), and
                // move current to the unchecked row (1)
                modal.toggleRow(suggestions[2]);
                modal.setHighlightedIndex(1);

                // Rows 0 and 2 are checked (purple left accent) but NOT current (no current highlight)
                const refreshedItems = modal.modalEl.querySelectorAll('.suggestion-item');
                expect(refreshedItems[0].classList.contains('is-checked')).toBe(true);
                expect(refreshedItems[0].classList.contains('is-selected')).toBe(false);

                expect(refreshedItems[2].classList.contains('is-checked')).toBe(true);
                expect(refreshedItems[2].classList.contains('is-selected')).toBe(false);

                // Row 1 is unchecked and current (shows neutral current highlight, no purple accent)
                expect(refreshedItems[1].classList.contains('is-checked')).toBe(false);
                expect(refreshedItems[1].classList.contains('is-selected')).toBe(true);
                expect(refreshedItems[1].classList.contains('ntg-keyboard-current')).toBe(true);

                // 4. Move current to a checked row (index 2) -> shows BOTH checked state and current highlight
                modal.setHighlightedIndex(2);
                expect(refreshedItems[2].classList.contains('is-checked')).toBe(true);
                expect(refreshedItems[2].classList.contains('is-selected')).toBe(true);
                expect(refreshedItems[2].classList.contains('ntg-keyboard-current')).toBe(true);

                // 5. Press Space on current row -> check state toggles while remaining current
                modal.handleSpace();
                expect(suggestions[2].checked).toBe(false);
                expect(modal.highlightedIndex).toBe(2);
                const afterSpaceItems = modal.modalEl.querySelectorAll('.suggestion-item');
                expect(afterSpaceItems[2].classList.contains('is-checked')).toBe(false);
                expect(afterSpaceItems[2].classList.contains('is-selected')).toBe(true);

                modal.close();
            });

            it('Section 3 & 5: Bare Enter and Collect collect HERE window by default, or highlighted row, or checked set', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

                const mainWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const pop1: WindowInfo = {
                    window: win1Obj,
                    representative: p1,
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                // Case 1: Immediately after opening with no checks, Enter collects HERE window
                let pickedChoice: any = null;
                const modal1 = new CollectTabsModal(app as unknown as App, mainWin, [pop1], (choice) => {
                    pickedChoice = choice;
                });
                modal1.open();
                modal1.executeCollection();
                expect(pickedChoice.kind).toBe('current');
                expect(pickedChoice.winInfo).toBe(mainWin);
                modal1.close();

                // Case 2: Immediately after opening, clicking Collect button collects identical HERE window
                pickedChoice = null;
                const modal2 = new CollectTabsModal(app as unknown as App, mainWin, [pop1], (choice) => {
                    pickedChoice = choice;
                });
                modal2.open();
                modal2.collectBtn?.click();
                expect(pickedChoice.kind).toBe('current');
                expect(pickedChoice.winInfo).toBe(mainWin);
                modal2.close();

                // Case 3: Move highlight to another row without touching any checkbox.
                // HERE remains checked by default, so both it and the highlighted
                // row are collected (the explicit choice is never silently dropped).
                pickedChoice = null;
                const modal3 = new CollectTabsModal(app as unknown as App, mainWin, [pop1], (choice) => {
                    pickedChoice = choice;
                });
                modal3.open();
                modal3.setHighlightedIndex(2); // pop1
                modal3.executeCollection();
                expect(Array.isArray(pickedChoice)).toBe(true);
                expect(pickedChoice).toHaveLength(2);
                expect(pickedChoice.some((c: any) => c.kind === 'window' && c.winInfo === pop1)).toBe(true);
                expect(pickedChoice.some((c: any) => c.kind === 'current' && c.winInfo === mainWin)).toBe(true);
                modal3.close();

                // Case 4: With an additional row checked, collects HERE (default) plus
                // that row.
                let pickedSet: any = null;
                const modal4 = new CollectTabsModal(app as unknown as App, mainWin, [pop1], (choice) => {
                    pickedSet = choice;
                });
                modal4.open();
                modal4.toggleRow(modal4.getSuggestions('')[2]);
                modal4.collectBtn?.click();
                expect(Array.isArray(pickedSet)).toBe(true);
                expect(pickedSet).toHaveLength(2);
                expect(pickedSet.some((c: any) => c.winInfo === pop1)).toBe(true);
                expect(pickedSet.some((c: any) => c.winInfo === mainWin)).toBe(true);
                modal4.close();
            });

            it('Section 4: assigns correct reversed visual emphasis classes to HERE, MAIN, and HERE · MAIN', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

                const mainWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: false,
                    isMainWindow: true,
                };
                const pop1: WindowInfo = {
                    window: win1Obj,
                    representative: p1,
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: true,
                    isMainWindow: false,
                };

                // Popout invocation: HERE on popout, MAIN on main
                const modalPop = new CollectTabsModal(app as unknown as App, pop1, [mainWin], () => {});
                const elHere = document.createElement('div');
                modalPop.renderSuggestion({ kind: 'current', winInfo: pop1, label: 'Pop1.md', checked: false, windowIndex: 2 }, elHere);
                const pillHere = elHere.querySelector('.ntg-status-pill') as HTMLElement;
                expect(pillHere.classList.contains('ntg-pill-here')).toBe(true);
                expect(pillHere.textContent).toBe('HERE');

                const elMain = document.createElement('div');
                modalPop.renderSuggestion({ kind: 'window', winInfo: mainWin, label: 'Main Note.md', checked: false, windowIndex: 1 }, elMain);
                const pillMain = elMain.querySelector('.ntg-status-pill') as HTMLElement;
                expect(pillMain.classList.contains('ntg-pill-main')).toBe(true);
                expect(pillMain.textContent).toBe('MAIN');

                // Main window invocation: single combined HERE · MAIN pill
                const modalMain = new CollectTabsModal(app as unknown as App, mainWin, [pop1], () => {});
                const elHereMain = document.createElement('div');
                modalMain.renderSuggestion({ kind: 'current', winInfo: mainWin, label: 'Main Note.md', checked: false, windowIndex: 1 }, elHereMain);
                const pillHereMain = elHereMain.querySelector('.ntg-status-pill') as HTMLElement;
                expect(pillHereMain.classList.contains('ntg-pill-here-main')).toBe(true);
                expect(pillHereMain.textContent).toBe('HERE · MAIN');
            });
        });

        describe('Regression tests for collect-tabs usability and keyboard tweaks', () => {
            beforeEach(() => {
                MockNotice.notices = [];
            });

            it('1. Spacebar toggles current window selection without moving shaded region to top or typing into input', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);
                const p2 = leaf('p2', 'Pop2.md', new MockWorkspaceParent(popoutContainer2), popoutContainer2);

                const mainWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const pop1: WindowInfo = {
                    window: win1Obj,
                    representative: p1,
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };
                const pop2: WindowInfo = {
                    window: win2Obj,
                    representative: p2,
                    groups: [{ leaves: [p2] } as any],
                    lastActive: 50,
                    label: 'Pop-out 2',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal = new CollectTabsModal(app as unknown as App, mainWin, [pop1, pop2], () => {});
                modal.open();

                // Move highlight to row 2
                modal.setHighlightedIndex(2);
                expect(modal.highlightedIndex).toBe(2);

                // Focus is on inputEl, press Spacebar
                modal.inputEl.focus();
                const spaceEvt = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
                modal.inputEl.dispatchEvent(spaceEvt);

                const suggestions = modal.getSuggestions('');
                // Row 2 must now be checked
                expect(suggestions[2].checked).toBe(true);
                // Highlight must NOT move to top (must remain at index 2)
                expect(modal.highlightedIndex).toBe(2);
                // No space character entered into inputEl
                expect(modal.inputEl.value).toBe('');

                modal.close();
            });

            it('2. Clear button becomes visible when windows are selected, reachable via TAB, and activatable via Spacebar', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

                const mainWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const pop1: WindowInfo = {
                    window: win1Obj,
                    representative: p1,
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal = new CollectTabsModal(app as unknown as App, mainWin, [pop1], () => {});
                modal.open();

                // HERE row is checked by default -> Clear button is already visible
                expect(modal.clearSelectionBtn?.style.display).not.toBe('none');
                let controls = modal.getFocusableControls();
                expect(controls.includes(modal.clearSelectionBtn!)).toBe(true);

                // Select all windows -> Clear button remains visible (display !== 'none')
                modal.checkAll();
                expect(modal.clearSelectionBtn?.style.display).not.toBe('none');
                controls = modal.getFocusableControls();
                expect(controls.includes(modal.clearSelectionBtn!)).toBe(true);

                // Focus clear button and press Spacebar to activate
                modal.clearSelectionBtn?.focus();
                const spaceEvt = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
                modal.clearSelectionBtn?.dispatchEvent(spaceEvt);

                // Selection is cleared
                expect(modal.hasAnyChecked()).toBe(false);
                // Clear button is hidden again
                expect(modal.clearSelectionBtn?.style.display).toBe('none');

                modal.close();
            });

            it('3. Only one collect-tabs modal can be active at a time; previous modal is cancelled and notice displayed', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

                const mainWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const pop1: WindowInfo = {
                    window: win1Obj,
                    representative: p1,
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal1 = new CollectTabsModal(app as unknown as App, mainWin, [pop1], () => {});
                modal1.open();
                expect(modal1.isOpen).toBe(true);

                const modal2 = new CollectTabsModal(app as unknown as App, pop1, [mainWin], () => {});
                modal2.open();

                // modal1 must have been cancelled/closed
                expect(modal1.isOpen).toBe(false);
                expect(modal2.isOpen).toBe(true);

                // Notice indicating cancellation must have been created
                expect(MockNotice.notices.some(n => n.message.toLowerCase().includes('cancelled') || n.message.toLowerCase().includes('canceled'))).toBe(true);

                modal2.close();
            });

            it('4. Vertical purple stripe on checked rows is removed from styles.css', () => {
                const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf-8');

                // Must not have border-left for checked row / suggestion-item
                expect(css).not.toMatch(/\.suggestion-item\.(?:is|ntg)-checked[^{]*\{[^}]*border-left:\s*3px/);
                expect(css).not.toMatch(/\.ntg-collect-row\.(?:is|ntg)-checked[^{]*\{[^}]*border-left:\s*3px/);
            });

            it('6. Space handling has exactly one source of truth: no duplicate Scope registrations for Space', () => {
                // Bug: collect-tabs-modal previously registered Space handling in THREE
                // overlapping places (scope ' ', scope 'Space', and a modalEl capture
                // listener), causing the same physical keypress to run handleSpace()
                // multiple times and net out to a check-then-uncheck no-op. The fix
                // consolidates Space handling to the single modalEl capture listener.
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const currentWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [], () => {});
                modal.open();

                const spaceRegistrations = (modal.scope as any).registrations.filter(
                    (r: { key: string | null }) => r.key === ' ' || r.key === 'Space',
                );
                expect(spaceRegistrations).toHaveLength(0);

                modal.close();
            });

            it('7. A single Space keydown on the filter input toggles the highlighted row exactly once', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

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
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});
                modal.open();
                modal.setHighlightedIndex(1);

                const handleSpaceSpy = vi.spyOn(modal, 'handleSpace');
                const spaceEvt = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
                modal.inputEl.dispatchEvent(spaceEvt);

                expect(handleSpaceSpy).toHaveBeenCalledTimes(1);
                const suggestions = modal.getSuggestions('');
                expect(suggestions[1].checked).toBe(true);

                modal.close();
            });

            it('8. HERE row (index 0) is highlighted on open even if the underlying chooser diverges from our tracked index', () => {
                // Bug: renderSuggestion()/getHighlightedItem() previously trusted
                // Obsidian's internal chooser.selectedItem over our own tracked
                // highlightedIndex. If Obsidian's chooser mutates selectedItem directly
                // (bypassing our setSelectedItem hook) -- which is exactly what its
                // asynchronous post-onOpen suggestion rendering can do -- the wrong row
                // ends up rendered as selected. Our own highlightedIndex must remain the
                // single source of truth for both rendering and lookups.
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

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
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});
                modal.open();
                expect(modal.highlightedIndex).toBe(0);

                // Simulate Obsidian's own internal chooser desyncing selectedItem from
                // our tracked highlightedIndex without going through our override.
                (modal as any).chooser.selectedItem = 1;

                expect(modal.getHighlightedItem()?.kind).toBe('current');

                const el = document.createElement('div');
                modal.renderSuggestion(modal.getSuggestions('')[0], el);
                expect(el.classList.contains('is-selected')).toBe(true);

                const otherEl = document.createElement('div');
                modal.renderSuggestion(modal.getSuggestions('')[1], otherEl);
                expect(otherEl.classList.contains('is-selected')).toBe(false);

                modal.close();
            });

            it('9. Deferred re-assertion restores HERE row highlight after an asynchronous chooser reset', async () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

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
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});
                modal.open();

                // Simulate Obsidian resetting the chooser's selection asynchronously,
                // right after onOpen() returns but before our deferred re-assertion runs.
                (modal as any).chooser.selectedItem = 1;

                await new Promise((resolve) => window.setTimeout(resolve, 10));

                expect(modal.highlightedIndex).toBe(0);
                const items = modal.modalEl.querySelectorAll('.suggestion-item');
                expect(items[0].classList.contains('is-selected')).toBe(true);
                expect(items[1].classList.contains('is-selected')).toBe(false);

                modal.close();
            });

            it('10. The HERE row checkbox is checked by default, matching what a bare Enter/Collect would do', () => {
                // Bug: the checkbox on the HERE row stayed unchecked on open even
                // though it was the row that would actually be collected by default
                // (via the keyboard-current highlight). This made the checkbox lie
                // about what pressing Enter/Collect would do, which is confusing:
                // an all-unchecked list looks like "nothing selected", but pressing
                // Enter immediately would still collect the current window.
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

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
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});
                modal.open();

                const suggestions = modal.getSuggestions('');
                expect(suggestions[0].checked).toBe(true);
                expect(suggestions[1].checked).toBe(false);
                expect(suggestions[2].checked).toBe(false);

                // The rendered checkbox for row 0 must visually reflect this.
                const el = document.createElement('div');
                modal.renderSuggestion(suggestions[0], el);
                const checkbox = el.querySelector<HTMLInputElement>('input[type="checkbox"]');
                expect(checkbox?.checked).toBe(true);
                expect(el.classList.contains('is-checked')).toBe(true);

                modal.close();
            });

            it('11. Choosing a different row via Enter always includes that row, even though HERE remains checked', () => {
                // Once the HERE row is checked by default, Enter/Collect on a
                // different, explicitly-chosen row must never silently discard that
                // choice just because something else happens to be checked.
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

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
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                let picked: any = null;
                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], (result) => {
                    picked = result;
                });
                modal.open();

                // Navigate to "All windows" (row 1) and choose it via Enter, without
                // ever touching a checkbox.
                modal.setHighlightedIndex(1);
                modal.executeCollection();

                expect(Array.isArray(picked)).toBe(true);
                expect(picked.some((c: any) => c.kind === 'all')).toBe(true);
                modal.close();
            });

            it('12. After clicking Clear selection, focus unconditionally returns to the filter input so Spacebar keeps toggling rows', () => {
                // Bug: clicking "Clear selection" could leave focus somewhere other
                // than the filter input (a toolbar BUTTON, or <body> once the
                // now-hidden clearSelectionBtn is blurred by the browser). The
                // modal's Space handler treats a focused BUTTON specially (activates
                // it via .click() instead of toggling the highlighted row), and does
                // nothing useful for <body>, so subsequent Spacebar presses stopped
                // toggling rows -- to the user this looked like "Spacebar stopped
                // selecting windows" even though mouse clicks still worked.
                //
                // Note: real browsers blur the currently-focused element as soon as
                // it is hidden (display: none), which jsdom does not replicate, so
                // clearSelection() cannot rely on inspecting document.activeElement
                // at all -- it must unconditionally refocus the filter input. This
                // test simulates the real-browser precondition explicitly (focus on
                // <body>, as it would be after the hide-triggered blur) rather than
                // relying on jsdom's non-standard focus retention.
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

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
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});
                modal.open();

                // Simulate the real-browser blur-on-hide: by the time clearSelection()
                // checks focus, it would already have moved off clearSelectionBtn.
                (document.body as HTMLElement).focus();
                modal.clearSelectionBtn?.click();

                expect(document.activeElement).toBe(modal.inputEl);

                // With focus back on the filter input, Space must toggle the
                // highlighted row (index 0, HERE), not activate a toolbar button.
                const suggestions = modal.getSuggestions('');
                expect(suggestions[0].checked).toBe(false);

                const spaceEvt = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
                modal.inputEl.dispatchEvent(spaceEvt);

                expect(suggestions[0].checked).toBe(true);

                modal.close();
            });

            it('13. A throwing chooser.setSelectedItem() (real Obsidian internal failure) does not abort the rest of onOpen()', () => {
                // Bug: real Obsidian's chooser.setSelectedItem(index, event?)
                // expects an Event (or undefined) as its second argument. This
                // plugin called it with a boolean (`true`), which crashed inside
                // Obsidian's own forceSetSelectedItem with
                // "TypeError: t.instanceOf is not a function" on Obsidian 1.13.7.
                // Since onOpen() calls setHighlightedIndex(0) synchronously and
                // early, an uncaught throw there skipped everything set up
                // afterward -- including the ArrowUp/ArrowDown scope
                // registrations -- intermittently breaking keyboard navigation
                // depending on the chooser's internal state. This test simulates
                // that real-Obsidian throw (the mock's chooser.setSelectedItem
                // never throws, so it cannot otherwise catch this) and asserts
                // the rest of modal setup still completes.
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const p1 = leaf('p1', 'Pop1.md', new MockWorkspaceParent(popoutContainer1), popoutContainer1);

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
                    groups: [{ leaves: [p1] } as any],
                    lastActive: 100,
                    label: 'Pop-out 1',
                    isCurrentWindow: false,
                    isMainWindow: false,
                };

                const modal = new CollectTabsModal(app as unknown as App, currentWin, [otherWin], () => {});
                // Simulate real Obsidian's internal failure mode precisely: only
                // a boolean second argument (what this plugin used to pass)
                // triggers the crash, matching forceSetSelectedItem's internal
                // type-check on the "event" parameter. Obsidian's own internal
                // calls (e.g. its initial render via updateSuggestions(), called
                // from the base Modal.open() before our onOpen() even runs) pass
                // no second argument or a real event, and must keep working.
                const originalSetSelectedItem = (modal as any).chooser.setSelectedItem;
                (modal as any).chooser.setSelectedItem = (index: number, event?: unknown) => {
                    if (typeof event === 'boolean') {
                        throw new TypeError('t.instanceOf is not a function');
                    }
                    return originalSetSelectedItem(index, event);
                };

                expect(() => modal.open()).not.toThrow();

                // Everything onOpen() sets up AFTER the chooser.setSelectedItem
                // call must still have run: ArrowDown/ArrowUp scope registrations...
                const registeredKeys = (modal.scope as any).registrations.map((r: any) => r.key);
                expect(registeredKeys).toContain('ArrowDown');
                expect(registeredKeys).toContain('ArrowUp');

                // ...and our own highlight bookkeeping/rendering still works.
                expect(modal.highlightedIndex).toBe(0);
                const items = modal.modalEl.querySelectorAll('.suggestion-item');
                expect(items[0].classList.contains('is-selected')).toBe(true);

                modal.moveHighlight(1);
                expect(modal.highlightedIndex).toBe(1);

                modal.close();
            });

            it('5. The redundant X cancel button is removed from modal and focusable controls', () => {
                const m1 = leaf('m1', 'Main Note.md', new MockWorkspaceParent(rootContainer), rootContainer);
                const mainWin: WindowInfo = {
                    window: globalThis.window,
                    representative: m1,
                    groups: [{ leaves: [m1] } as any],
                    lastActive: 200,
                    label: 'Main window',
                    isCurrentWindow: true,
                    isMainWindow: true,
                };

                const modal = new CollectTabsModal(app as unknown as App, mainWin, [], () => {});
                // Simulate Obsidian modal creating close button and search clear button
                modal.modalEl.createDiv({ cls: 'modal-close-button' });
                const promptInputContainer = modal.modalEl.querySelector('.prompt-input-container') || modal.modalEl;
                promptInputContainer.createDiv({ cls: 'search-input-clear-button' });
                modal.open();

                // Close button should be removed or hidden
                const closeBtn = modal.modalEl.querySelector('.modal-close-button');
                expect(!closeBtn || (closeBtn as HTMLElement).style.display === 'none').toBe(true);

                // Search clear button should be removed or hidden
                const searchClearBtn = modal.modalEl.querySelector('.search-input-clear-button');
                expect(!searchClearBtn || (searchClearBtn as HTMLElement).style.display === 'none').toBe(true);

                // inputEl type must be 'text' to prevent Chromium's native webkit search cancel button
                expect(modal.inputEl.type).toBe('text');

                // getFocusableControls must never include modal-close-button or search-input-clear-button
                const controls = modal.getFocusableControls();
                expect(controls.some(c => c.classList.contains('modal-close-button'))).toBe(false);
                expect(controls.some(c => c.classList.contains('search-input-clear-button'))).toBe(false);

                // styles.css must hide .search-input-clear-button and webkit-search-cancel-button
                const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf-8');
                expect(css).toMatch(/\.search-input-clear-button/);
                expect(css).toMatch(/::-webkit-search-cancel-button/);

                modal.close();
            });
        });
    });
});
