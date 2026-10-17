import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import { CollectTabsModal } from '../src/ui/collect-tabs-modal';
import {
    MockApp,
    MockModal,
    MockNotice,
    MockPlugin,
    MockPluginSettingTab,
    MockSetting,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
    FuzzySuggestModal,
    MockFuzzySuggestModal,
} from './mocks/obsidian';

// Public-facing type for the plugin under test so private methods can be exercised.
type TestPlugin = NextTabGroupPlugin & {
    dedupeInGroup: () => Promise<void>;
    dedupeInAllGroups: () => Promise<void>;
    dedupeInAllWindows: () => Promise<void>;
    runDedupeTabs: () => Promise<void>;
    getActiveLeafInFocusedWindow: () => WorkspaceLeaf | null;
    switchToTabInGroup: () => void;
    planDedupe: (leaves: WorkspaceLeaf[], activeLeaf: WorkspaceLeaf | null) => { toRemove: WorkspaceLeaf[]; notesAffected: number } | null;
    getLeafFileKey: (leaf: WorkspaceLeaf) => string | null;
    pickSurvivor: (leaves: WorkspaceLeaf[], activeLeaf: WorkspaceLeaf | null) => WorkspaceLeaf;
    relativePosition: (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => string;
};

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

function leaf(
    id: string,
    file: string | null,
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

describe('deduplication commands', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let rootContainer: MockWorkspaceContainer;
    let windowContainer: MockWorkspaceContainer;

    beforeEach(async () => {
        app = new MockApp();
        // Distinct Window objects so the focused-window filter can tell the
        // main and pop-out windows apart.
        rootContainer = new MockWorkspaceContainer('root', {} as Window);
        windowContainer = new MockWorkspaceContainer('window', {} as Window);
        plugin = createPlugin(app);
        await plugin.onload();
    });

    describe('dedupeInGroup', () => {
        it('removes duplicate tabs in the active tab group, keeping the active one', async () => {
            const group = new MockWorkspaceParent(rootContainer);
            const keep = leaf('a', 'Note-A.md', group, rootContainer);
            const dup1 = leaf('b', 'Note-A.md', group, rootContainer);
            const dup2 = leaf('c', 'Note-A.md', group, rootContainer);
            const other = leaf('d', 'Note-B.md', group, rootContainer);

            app.workspace.rootLeaves = [keep, dup1, dup2, other];
            app.workspace.allLeaves = [keep, dup1, dup2, other];
            app.workspace.setActiveLeaf(keep);

            await plugin.dedupeInGroup();

            expect(keep.detached).toBe(false);
            expect(dup1.detached).toBe(true);
            expect(dup2.detached).toBe(true);
            expect(other.detached).toBe(false);
        });
    });

    describe('dedupeInAllGroups', () => {
        it('removes duplicates across groups in the same window, keeping active tab', async () => {
            const group1 = new MockWorkspaceParent(rootContainer);
            const group2 = new MockWorkspaceParent(rootContainer);

            const active = leaf('a', 'Note-A.md', group1, rootContainer);
            const dup1 = leaf('b', 'Note-A.md', group2, rootContainer);
            const dup2 = leaf('c', 'Note-A.md', group2, rootContainer);
            const other = leaf('d', 'Note-B.md', group2, rootContainer);

            app.workspace.rootLeaves = [active, dup1, dup2, other];
            app.workspace.allLeaves = [active, dup1, dup2, other];
            app.workspace.setActiveLeaf(active);
            plugin.settings.confirmDedupeAllGroups = false;

            await plugin.dedupeInAllGroups();

            expect(active.detached).toBe(false);
            expect(dup1.detached).toBe(true);
            expect(dup2.detached).toBe(true);
            expect(other.detached).toBe(false);
        });

        it('removes duplicates across groups within the focused pop-out window, not just the main window', async () => {
            const groupMain = new MockWorkspaceParent(rootContainer);
            const groupWin = new MockWorkspaceParent(windowContainer);

            const mainDup = leaf('a', 'Note-A.md', groupMain, rootContainer);
            const winActive = leaf('b', 'Note-A.md', groupWin, windowContainer);
            const winDup = leaf('c', 'Note-A.md', groupWin, windowContainer);
            const other = leaf('d', 'Note-B.md', groupWin, windowContainer);

            // Simulate the focused window being a pop-out: its leaves live in
            // the floating section, so iterateRootLeaves would skip them.
            app.workspace.rootLeaves = [mainDup];
            app.workspace.allLeaves = [mainDup, winActive, winDup, other];
            app.workspace.setActiveLeaf(winActive);
            plugin.settings.confirmDedupeAllGroups = false;

            await plugin.dedupeInAllGroups();

            expect(winActive.detached).toBe(false);
            expect(winDup.detached).toBe(true);
            expect(other.detached).toBe(false);
            // The main-window duplicate must NOT be touched: it is in a
            // different window than the focused one.
            expect(mainDup.detached).toBe(false);
        });

        it('only dedupes within the main window when the active leaf is there, even with duplicates in a pop-out', async () => {
            const groupMain = new MockWorkspaceParent(rootContainer);
            const groupWin = new MockWorkspaceParent(windowContainer);

            const mainActive = leaf('a', 'Note-A.md', groupMain, rootContainer);
            const mainDup = leaf('b', 'Note-A.md', groupMain, rootContainer);
            const popoutDup = leaf('c', 'Note-A.md', groupWin, windowContainer);

            app.workspace.rootLeaves = [mainActive, mainDup];
            app.workspace.allLeaves = [mainActive, mainDup, popoutDup];
            app.workspace.setActiveLeaf(mainActive);
            plugin.settings.confirmDedupeAllGroups = false;

            await plugin.dedupeInAllGroups();

            expect(mainActive.detached).toBe(false);
            expect(mainDup.detached).toBe(true);
            // Pop-out duplicate must NOT be touched: different window.
            expect(popoutDup.detached).toBe(false);
        });

        it('falls back to the main window only when there is no active leaf', async () => {
            const groupMain = new MockWorkspaceParent(rootContainer);
            const groupWin = new MockWorkspaceParent(windowContainer);

            const mainKeep = leaf('a', 'Note-A.md', groupMain, rootContainer);
            const mainDup = leaf('b', 'Note-A.md', groupMain, rootContainer);
            const popoutKeep = leaf('c', 'Note-A.md', groupWin, windowContainer);
            const popoutDup = leaf('d', 'Note-A.md', groupWin, windowContainer);

            app.workspace.rootLeaves = [mainKeep, mainDup];
            app.workspace.allLeaves = [mainKeep, mainDup, popoutKeep, popoutDup];
            // No active leaf AND no leaf in the focused jsdom window, so
            // getActiveLeafInFocusedWindow falls back to activeLeaf === null
            // and dedupeInAllGroups uses the iterateRootLeaves fallback.
            app.workspace.activeLeaf = null;
            plugin.settings.confirmDedupeAllGroups = false;

            await plugin.dedupeInAllGroups();

            // Main window: one duplicate removed (stable tie-break by id).
            expect(mainKeep.detached).toBe(true);
            expect(mainDup.detached).toBe(false);
            // Pop-out duplicates must NOT be touched when there's no active
            // leaf to indicate the user wants them deduped.
            expect(popoutDup.detached).toBe(false);
            expect(popoutKeep.detached).toBe(false);
        });

        it('keeps a leaf in the active tab group over one in a different group when neither is active', async () => {
            const group1 = new MockWorkspaceParent(rootContainer);
            const group2 = new MockWorkspaceParent(rootContainer);

            const active = leaf('a', 'Note-B.md', group1, rootContainer);
            const inActiveGroup = leaf('b', 'Note-A.md', group1, rootContainer);
            const inOtherGroup = leaf('c', 'Note-A.md', group2, rootContainer);

            app.workspace.rootLeaves = [active, inActiveGroup, inOtherGroup];
            app.workspace.allLeaves = [active, inActiveGroup, inOtherGroup];
            app.workspace.setActiveLeaf(active);
            plugin.settings.confirmDedupeAllGroups = false;

            await plugin.dedupeInAllGroups();

            expect(active.detached).toBe(false);
            expect(inActiveGroup.detached).toBe(false);
            expect(inOtherGroup.detached).toBe(true);
        });
    });

    describe('dedupeInAllWindows', () => {
        it('removes duplicates across windows, keeping the active tab', async () => {
            const group1 = new MockWorkspaceParent(rootContainer);
            const group2 = new MockWorkspaceParent(windowContainer);

            const active = leaf('a', 'Note-A.md', group1, rootContainer);
            const dup1 = leaf('b', 'Note-A.md', group2, windowContainer);
            const dup2 = leaf('c', 'Note-A.md', group2, windowContainer);
            const other = leaf('d', 'Note-B.md', group2, windowContainer);

            app.workspace.rootLeaves = [active];
            app.workspace.allLeaves = [active, dup1, dup2, other];
            app.workspace.setActiveLeaf(active);
            plugin.settings.confirmDedupeAllWindows = false;

            await plugin.dedupeInAllWindows();

            expect(active.detached).toBe(false);
            expect(dup1.detached).toBe(true);
            expect(dup2.detached).toBe(true);
            expect(other.detached).toBe(false);
        });

        it('prefers a leaf in the active window over one in another window when neither is active', async () => {
            const group1 = new MockWorkspaceParent(rootContainer);
            const group2 = new MockWorkspaceParent(windowContainer);

            const active = leaf('a', 'Note-B.md', group1, rootContainer);
            const inActiveWindow = leaf('b', 'Note-A.md', group1, rootContainer);
            const inOtherWindow = leaf('c', 'Note-A.md', group2, windowContainer);

            app.workspace.rootLeaves = [active, inActiveWindow];
            app.workspace.allLeaves = [active, inActiveWindow, inOtherWindow];
            app.workspace.setActiveLeaf(active);
            plugin.settings.confirmDedupeAllWindows = false;

            await plugin.dedupeInAllWindows();

            expect(active.detached).toBe(false);
            expect(inActiveWindow.detached).toBe(false);
            expect(inOtherWindow.detached).toBe(true);
        });
    });

    describe('survivor selection', () => {
        it('prefers the active tab even when another leaf is more recent', async () => {
            const group = new MockWorkspaceParent(rootContainer);
            const active = leaf('a', 'Note-A.md', group, rootContainer);
            const recent = leaf('b', 'Note-A.md', group, rootContainer);

            app.workspace.rootLeaves = [active, recent];
            app.workspace.allLeaves = [active, recent];
            app.workspace.setActiveLeaf(active);

            app.workspace.emit('active-leaf-change', recent);
            app.workspace.setActiveLeaf(active);
            plugin.settings.confirmDedupeAllGroups = false;

            await plugin.dedupeInAllGroups();

            expect(active.detached).toBe(false);
            expect(recent.detached).toBe(true);
        });

        it('prefers the most recently visited leaf in the active window when no active priority applies', async () => {
            const group1 = new MockWorkspaceParent(rootContainer);
            const group2 = new MockWorkspaceParent(rootContainer);

            const active = leaf('a', 'Note-B.md', group1, rootContainer);
            const older = leaf('b', 'Note-A.md', group2, rootContainer);
            const newer = leaf('c', 'Note-A.md', group2, rootContainer);

            app.workspace.rootLeaves = [active, older, newer];
            app.workspace.allLeaves = [active, older, newer];
            app.workspace.setActiveLeaf(active);

            app.workspace.emit('active-leaf-change', older);
            await new Promise((r) => setTimeout(r, 5));
            app.workspace.emit('active-leaf-change', newer);
            plugin.settings.confirmDedupeAllGroups = false;

            await plugin.dedupeInAllGroups();

            expect(active.detached).toBe(false);
            expect(older.detached).toBe(true);
            expect(newer.detached).toBe(false);
        });
    });

    describe('non-file leaves', () => {
        it('ignores leaves with no file', async () => {
            const group = new MockWorkspaceParent(rootContainer);
            const graph = leaf('a', null, group, rootContainer);
            graph.setViewState('graph');
            const md = leaf('b', 'Note-A.md', group, rootContainer);
            const dup = leaf('c', 'Note-A.md', group, rootContainer);

            app.workspace.rootLeaves = [graph, md, dup];
            app.workspace.allLeaves = [graph, md, dup];
            app.workspace.setActiveLeaf(md);
            plugin.settings.confirmDedupeAllGroups = false;

            await plugin.dedupeInAllGroups();

            expect(graph.detached).toBe(false);
            expect(md.detached).toBe(false);
            expect(dup.detached).toBe(true);
        });
    });

    describe('runDedupeTabs (unified command)', () => {
        // Capture the picker instead of opening it so tests can drive it.
        let modals: CollectTabsModal[];
        let originalOpen: typeof CollectTabsModal.prototype.open;

        beforeEach(() => {
            modals = [];
            originalOpen = CollectTabsModal.prototype.open;
            CollectTabsModal.prototype.open = function (this: CollectTabsModal) {
                modals.push(this);
            };
        });

        afterEach(() => {
            CollectTabsModal.prototype.open = originalOpen;
        });

        function setup(leaves: MockWorkspaceLeaf[], active: MockWorkspaceLeaf, root: MockWorkspaceLeaf[] = leaves) {
            app.workspace.rootLeaves = root;
            app.workspace.allLeaves = leaves;
            app.workspace.setActiveLeaf(active);
            plugin.settings.confirmDedupeGroup = false;
            plugin.settings.confirmDedupeAllGroups = false;
            plugin.settings.confirmDedupeAllWindows = false;
        }

        it('does nothing and shows no picker when there are no duplicates', async () => {
            const group = new MockWorkspaceParent(rootContainer);
            const a = leaf('a', 'Note-A.md', group, rootContainer);
            const b = leaf('b', 'Note-B.md', group, rootContainer);
            setup([a, b], a);

            await plugin.runDedupeTabs();

            expect(modals).toHaveLength(0);
            expect(a.detached).toBe(false);
            expect(b.detached).toBe(false);
        });

        it('runs directly without a picker when one window has a single group', async () => {
            const group = new MockWorkspaceParent(rootContainer);
            const keep = leaf('a', 'Note-A.md', group, rootContainer);
            const dup = leaf('b', 'Note-A.md', group, rootContainer);
            setup([keep, dup], keep);

            await plugin.runDedupeTabs();

            expect(modals).toHaveLength(0);
            expect(keep.detached).toBe(false);
            expect(dup.detached).toBe(true);
        });

        it('runs directly when only cross-group duplicates exist (group scope has nothing to do)', async () => {
            const g1 = new MockWorkspaceParent(rootContainer);
            const g2 = new MockWorkspaceParent(rootContainer);
            const keep = leaf('a', 'Note-A.md', g1, rootContainer);
            const dup = leaf('b', 'Note-A.md', g2, rootContainer);
            setup([keep, dup], keep);

            await plugin.runDedupeTabs();

            expect(modals).toHaveLength(0);
            expect(dup.detached).toBe(true);
        });

        it('runs directly when the only duplicates are inside another window', async () => {
            const g1 = new MockWorkspaceParent(rootContainer);
            const g2 = new MockWorkspaceParent(windowContainer);
            const active = leaf('a', 'Note-A.md', g1, rootContainer);
            const dup1 = leaf('b', 'Note-B.md', g2, windowContainer);
            const dup2 = leaf('c', 'Note-B.md', g2, windowContainer);
            setup([active, dup1, dup2], active, [active]);

            await plugin.runDedupeTabs();

            expect(modals).toHaveLength(0);
            expect([dup1.detached, dup2.detached].filter(Boolean)).toHaveLength(1);
            expect(active.detached).toBe(false);
        });

        it('offers a picker when group-only and wider actions differ, and defaults to the narrowest', async () => {
            const g1 = new MockWorkspaceParent(rootContainer);
            const g2 = new MockWorkspaceParent(rootContainer);
            const keep = leaf('a', 'Note-A.md', g1, rootContainer);
            const groupDup = leaf('b', 'Note-A.md', g1, rootContainer);
            const x1 = leaf('c', 'Note-X.md', g1, rootContainer);
            const x2 = leaf('d', 'Note-X.md', g2, rootContainer);
            setup([keep, groupDup, x1, x2], keep);

            await plugin.runDedupeTabs();
            expect(modals).toHaveLength(1);

            const rows = modals[0].getSuggestions('');
            expect(rows.map((r) => (r.kind === 'scope' ? r.id : r.kind))).toEqual(['group', 'window']);
            expect(rows.map((r) => r.checked)).toEqual([true, false]);

            modals[0].executeCollection();
            await new Promise((r) => setTimeout(r, 0));

            expect(groupDup.detached).toBe(true);
            expect(x1.detached).toBe(false);
            expect(x2.detached).toBe(false);
        });

        it('outlines the tabs and groups the selection will close, and clears them on close', async () => {
            const g1 = new MockWorkspaceParent(rootContainer);
            const g2 = new MockWorkspaceParent(rootContainer);
            const keep = leaf('a', 'Note-A.md', g1, rootContainer);
            const groupDup = leaf('b', 'Note-A.md', g1, rootContainer);
            const x1 = leaf('c', 'Note-X.md', g1, rootContainer);
            const x2 = leaf('d', 'Note-X.md', g2, rootContainer);
            const headers = [keep, groupDup, x1, x2].map((l) => {
                const el = document.createElement('div');
                document.body.appendChild(el);
                (l as unknown as { tabHeaderEl: HTMLElement }).tabHeaderEl = el;
                return el;
            });
            const g1El = document.createElement('div');
            (g1 as unknown as { containerEl: HTMLElement }).containerEl = g1El;
            document.body.appendChild(g1El);
            setup([keep, groupDup, x1, x2], keep);

            await plugin.runDedupeTabs();
            const modal = modals[0];
            modal.syncTargetHighlight();

            // Default selection: this tab group only -> just groupDup.
            expect(headers[1].classList.contains('ntg-dedupe-close')).toBe(true);
            expect(headers[0].classList.contains('ntg-dedupe-close')).toBe(false);
            expect(g1El.classList.contains('ntg-dedupe-close-group')).toBe(true);

            modal.checkAll();
            expect(headers.filter((h) => h.classList.contains('ntg-dedupe-close'))).toHaveLength(2);

            plugin.settings.highlightDedupeTabs = false;
            modal.syncTargetHighlight();
            expect(headers.some((h) => h.classList.contains('ntg-dedupe-close'))).toBe(false);

            modal.clearSelection();
            modal.onClose();
            expect(g1El.classList.contains('ntg-dedupe-close-group')).toBe(false);
        });
        it('lists every window as a row, lists closing tabs under rows, and previews cross-window duplicates when windows are checked', async () => {
            const g1 = new MockWorkspaceParent(rootContainer);
            const g2 = new MockWorkspaceParent(windowContainer);
            const active = leaf('a', 'Note-A.md', g1, rootContainer);
            const b1 = leaf('b', 'Note-B.md', g1, rootContainer);
            const b2 = leaf('c', 'Note-B.md', g1, rootContainer);
            const crossDup = leaf('d', 'Note-A.md', g2, windowContainer);
            setup([active, b1, b2, crossDup], active, [active, b1, b2]);

            await plugin.runDedupeTabs();
            expect(modals).toHaveLength(1);
            const rows = modals[0].getSuggestions('').filter((r) => r.kind === 'scope');
            const byId = (id: string) => rows.find((r) => r.id === id || r.id.startsWith(id))!;

            expect(rows.map((r) => r.label)).toEqual(
                expect.arrayContaining(['Across all windows']),
            );
            // The number badge and HERE/MAIN pill name a window, so window rows
            // describe their contents and never repeat "Window N" / "This window".
            for (const r of rows.filter((x) => x.id === 'window' || x.id.startsWith('window:'))) {
                expect(r.label).toMatch(/^\d+ tabs? in \d+ tab groups?$/);
            }
            const other = rows.find((r) => r.id.startsWith('window:'))!;
            expect(other.detail).toBe('no duplicates inside');
            // one closing tab + one kept tab per row; all windows closes 2 and keeps 2.
            expect(byId('window').items!.filter((i) => i.kind === 'close')).toHaveLength(1);
            expect(byId('window').items!.filter((i) => i.kind === 'keep')).toHaveLength(1);
            expect(byId('all').items!.filter((i) => i.kind === 'close')).toHaveLength(2);

            // Checking both windows (not "all") still dedupes across them.
            modals[0].clearSelection();
            for (const r of rows) {
                if (r.id === 'window' || r.id.startsWith('window:')) modals[0].toggleRow(r);
            }
            modals[0].executeCollection();
            await new Promise((r) => setTimeout(r, 0));
            expect(crossDup.detached).toBe(true);
            expect(active.detached).toBe(false);
            expect([b1.detached, b2.detached].filter(Boolean)).toHaveLength(1);
        });
        it('shows the previewing picker, not a plain confirmation, when only one action exists but confirmation is on', async () => {
            const g1 = new MockWorkspaceParent(rootContainer);
            const g2 = new MockWorkspaceParent(windowContainer);
            const active = leaf('a', 'Note-A.md', g1, rootContainer);
            const other = leaf('b', 'Note-B.md', g1, rootContainer);
            // The only duplicate spans two windows, so only "Across all windows" closes anything.
            const crossDup = leaf('d', 'Note-A.md', g2, windowContainer);
            const keepB = leaf('e', 'Note-C.md', g2, windowContainer);
            setup([active, other, crossDup, keepB], active, [active, other]);
            plugin.settings.confirmDedupeAllWindows = true;

            await plugin.runDedupeTabs();
            expect(modals).toHaveLength(1);
            const rows = modals[0].getSuggestions('').filter((r) => r.kind === 'scope');
            expect(rows.find((r) => r.id === 'all')!.items!.filter((i) => i.kind === 'close')).toHaveLength(1);
        });
        it('Left/Right walk the window rows in space, and group/all rows enter at the current window', async () => {
            const g1 = new MockWorkspaceParent(rootContainer);
            const g2 = new MockWorkspaceParent(windowContainer);
            const active = leaf('a', 'Note-A.md', g1, rootContainer);
            const b1 = leaf('b', 'Note-B.md', g1, rootContainer);
            const b2 = leaf('c', 'Note-B.md', g1, rootContainer);
            const crossDup = leaf('d', 'Note-A.md', g2, windowContainer);
            setup([active, b1, b2, crossDup], active, [active, b1, b2]);

            await plugin.runDedupeTabs();
            const modal = modals[0];
            const rows = modal.getSuggestions('');
            const winRows = rows.filter((r) => r.kind === 'scope' && r.winInfo);
            expect(winRows.length).toBeGreaterThanOrEqual(2);
            const here = winRows.find((r) => r.kind === 'scope' && r.winInfo!.isCurrentWindow)!;
            const there = winRows.find((r) => r !== here)!;
            expect(modal.windowNeighbor(here, 1)).toBe(there);
            expect(modal.windowNeighbor(there, 1)).toBe(here);
            expect(modal.windowNeighbor(rows.find((r) => r.kind === 'scope' && r.id === 'all')!, 1)).toBe(here);
            // The ring (which enables the Left/Right keys on open) is supplied by default.
            expect((modal as any).windowRing).toBeTypeOf('function');
        });
        it('the filter finds rows by note name, window number and here/main, never by count text', async () => {
            const g1 = new MockWorkspaceParent(rootContainer);
            const g2 = new MockWorkspaceParent(windowContainer);
            const active = leaf('a', 'Note-A.md', g1, rootContainer);
            const b1 = leaf('b', 'Note-B.md', g1, rootContainer);
            const b2 = leaf('c', 'Note-B.md', g1, rootContainer);
            const crossDup = leaf('d', 'Note-A.md', g2, windowContainer);
            const onlyThere = leaf('e', 'Zebra.md', g2, windowContainer);
            setup([active, b1, b2, crossDup, onlyThere], active, [active, b1, b2]);

            await plugin.runDedupeTabs();
            const modal = modals[0];
            const ids = (q: string) => modal.getSuggestions(q).map((r) => (r.kind === 'scope' ? r.id : r.kind));

            // A note that lives only in the other window is found, and only that window row (and the all-windows scope).
            expect(ids('zebra')).toContain('all');
            expect(ids('zebra').filter((id) => id.startsWith('window:'))).toHaveLength(1);
            expect(ids('zebra')).not.toContain('window');
            // Count text such as "2 tabs in 1 tab group" is not searchable.
            expect(ids('tab groups')).not.toContain('window');
            expect(ids('tab groups').filter((id) => id.startsWith('window:'))).toHaveLength(0);
            // here / main find the current window's row.
            expect(ids('here')).toContain('window');
            // Words in any order.
            expect(ids('b note')).toContain('window');
        });
        it('does nothing but explain when no row is checked, even with a row highlighted', async () => {
            const g1 = new MockWorkspaceParent(rootContainer);
            const keep = leaf('a', 'Note-A.md', g1, rootContainer);
            const dup = leaf('b', 'Note-A.md', g1, rootContainer);
            const x1 = leaf('c', 'Note-X.md', g1, rootContainer);
            const x2 = leaf('d', 'Note-X.md', new MockWorkspaceParent(rootContainer), rootContainer);
            setup([keep, dup, x1, x2], keep);

            await plugin.runDedupeTabs();
            const modal = modals[0];
            modal.clearSelection();
            modal.setHighlightedIndex(0);
            MockNotice.notices = [];
            modal.executeCollection();
            await new Promise((r) => setTimeout(r, 0));

            expect(MockNotice.notices.map((n) => n.message)).toEqual(['Nothing checked to deduplicate.']);
            expect([keep, dup, x1, x2].some((l) => l.detached)).toBe(false);
        });        it('deduplicates the union of all checked scopes', async () => {
            const g1 = new MockWorkspaceParent(rootContainer);
            const g2 = new MockWorkspaceParent(rootContainer);
            const keep = leaf('a', 'Note-A.md', g1, rootContainer);
            const groupDup = leaf('b', 'Note-A.md', g1, rootContainer);
            const x1 = leaf('c', 'Note-X.md', g1, rootContainer);
            const x2 = leaf('d', 'Note-X.md', g2, rootContainer);
            setup([keep, groupDup, x1, x2], keep);

            await plugin.runDedupeTabs();
            modals[0].checkAll();
            modals[0].executeCollection();
            await new Promise((r) => setTimeout(r, 0));

            expect(groupDup.detached).toBe(true);
            expect([x1.detached, x2.detached].filter(Boolean)).toHaveLength(1);
        });
    });
    describe('confirmation modal', () => {
        it('cancelling the modal leaves all tabs intact', async () => {
            const group1 = new MockWorkspaceParent(rootContainer);
            const group2 = new MockWorkspaceParent(rootContainer);
            const active = leaf('a', 'Note-A.md', group1, rootContainer);
            const dup = leaf('b', 'Note-A.md', group2, rootContainer);

            app.workspace.rootLeaves = [active, dup];
            app.workspace.allLeaves = [active, dup];
            app.workspace.setActiveLeaf(active);
            plugin.settings.confirmDedupeAllGroups = true;

            let captured: MockModal | undefined;
            const originalOpen = MockModal.prototype.open;
            MockModal.prototype.open = function (this: MockModal) {
                captured = this;
                return originalOpen.call(this);
            };

            const promise = plugin.dedupeInAllGroups();
            await new Promise((r) => setTimeout(r, 0));
            captured?.cancel();
            await promise;

            MockModal.prototype.open = originalOpen;

            expect(active.detached).toBe(false);
            expect(dup.detached).toBe(false);
        });
    });
});

// Direct access to private helpers.
describe('pickSurvivor', () => {
    it('chooses the active leaf when it is in the set', () => {
        const plugin = createPlugin(new MockApp());
        const container = new MockWorkspaceContainer('root');
        const group = new MockWorkspaceParent(container);
        const active = new MockWorkspaceLeaf('Note-A.md').setId('a').setParent(group).setContainer(container);
        const dup = new MockWorkspaceLeaf('Note-A.md').setId('b').setParent(group).setContainer(container);

        expect(plugin.pickSurvivor([asLeaf(active), asLeaf(dup)], asLeaf(active))).toBe(asLeaf(active));
    });
});

describe('relativePosition', () => {
    it('reports vertical relationships before horizontal ones', () => {
        const plugin = createPlugin(new MockApp());
        const ref = { x: 0, y: 0, w: 100, h: 100 };
        const above = { x: 0, y: -200, w: 100, h: 100 };
        const below = { x: 0, y: 200, w: 100, h: 100 };
        const left = { x: -200, y: 0, w: 100, h: 100 };
        const right = { x: 200, y: 0, w: 100, h: 100 };

        expect(plugin.relativePosition(above, ref)).toBe('group above');
        expect(plugin.relativePosition(below, ref)).toBe('group below');
        expect(plugin.relativePosition(left, ref)).toBe('left group');
        expect(plugin.relativePosition(right, ref)).toBe('right group');
    });
});

describe('getLeafFileKey', () => {
    it('returns the file path from a FileView-like leaf', () => {
        const plugin = createPlugin(new MockApp());
        const leaf = new MockWorkspaceLeaf('Note-A.md').setId('a');
        expect(plugin.getLeafFileKey(asLeaf(leaf))).toBe('Note-A.md');
    });

    it('returns null for leaves with no file', () => {
        const plugin = createPlugin(new MockApp());
        const leaf = new MockWorkspaceLeaf(null).setId('a');
        leaf.setViewState('graph');
        expect(plugin.getLeafFileKey(asLeaf(leaf))).toBe(null);
    });
});

describe('switchToTabInGroup', () => {
    it('lists only the leaves of the active tab group', () => {
        const app = new MockApp();
        const container = new MockWorkspaceContainer('root', {} as Window);
        const plugin = createPlugin(app);
        const group = new MockWorkspaceParent(container);
        const other = new MockWorkspaceParent(container);

        const a = leaf('a', 'Note-A.md', group, container);
        const b = leaf('b', 'Note-B.md', group, container);
        const c = leaf('c', 'Note-C.md', group, container);
        const d = leaf('d', 'Note-D.md', other, container);

        app.workspace.rootLeaves = [a, b, c, d];
        app.workspace.allLeaves = [a, b, c, d];
        app.workspace.setActiveLeaf(b);

        let captured: MockFuzzySuggestModal<MockWorkspaceLeaf> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<MockWorkspaceLeaf>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToTabInGroup();
        MockFuzzySuggestModal.prototype.open = originalOpen;

        expect(captured).toBeDefined();
        const items = captured!.getItems();
        expect(items.map((l) => (l as unknown as MockWorkspaceLeaf).id).sort()).toEqual(['a', 'b', 'c']);
    });

    it('opens the chosen tab by setting it active', () => {
        const app = new MockApp();
        const container = new MockWorkspaceContainer('root', {} as Window);
        const group = new MockWorkspaceParent(container);
        const a = leaf('a', 'Note-A.md', group, container);
        const b = leaf('b', 'Note-B.md', group, container);
        const c = leaf('c', 'Note-C.md', group, container);

        app.workspace.rootLeaves = [a, b, c];
        app.workspace.allLeaves = [a, b, c];
        app.workspace.setActiveLeaf(a);

        expect(app.workspace.activeLeaf).toBe(a);

        // Capture the real NavigationSuggestModal instance created by the
        // command and drive its onChooseItem.
        let captured: MockFuzzySuggestModal<MockWorkspaceLeaf> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<MockWorkspaceLeaf>) {
            captured = this;
            return originalOpen.call(this);
        };

        const plugin = createPlugin(app);
        plugin.switchToTabInGroup();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        expect(captured).toBeDefined();
        const items = captured!.getItems();
        // Pure recency order; with no timestamps it falls back to ID ascending,
        // so the active leaf 'a' stays first and 'b' follows.
        expect(items.map((l) => (l as unknown as MockWorkspaceLeaf).id)).toEqual(['a', 'b', 'c']);

        const leafB = items.find((l) => (l as unknown as MockWorkspaceLeaf).id === 'b');
        captured!.onChooseItem(leafB!);
        expect(app.workspace.activeLeaf).toBe(b);
    });

    it('does not open modal when there is no active leaf', () => {
        const app = new MockApp();
        const plugin = createPlugin(app);
        app.workspace.activeLeaf = null;

        let opened = false;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<MockWorkspaceLeaf>) {
            opened = true;
            return originalOpen.call(this);
        };

        plugin.switchToTabInGroup();
        MockFuzzySuggestModal.prototype.open = originalOpen;

        expect(opened).toBe(false);
    });
});
