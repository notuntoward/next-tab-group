import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockModal,
    MockPlugin,
    MockPluginSettingTab,
    MockSetting,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
} from './mocks/obsidian';

// Public-facing type for the plugin under test so private methods can be exercised.
type TestPlugin = NextTabGroupPlugin & {
    dedupeInGroup: () => Promise<void>;
    dedupeInAllGroups: () => Promise<void>;
    dedupeInAllWindows: () => Promise<void>;
    getActiveLeafInFocusedWindow: () => WorkspaceLeaf | null;
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
