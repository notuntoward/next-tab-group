import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { App, WorkspaceLeaf, WorkspaceParent } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
    MockContainerEl,
} from './mocks/obsidian';

type TestPlugin = NextTabGroupPlugin & {
    cycleTabGroups: () => void;
    rotateTabGroups: () => Promise<void>;
    dedupeInGroup: () => Promise<void>;
    dedupeInAllGroups: () => Promise<void>;
    dedupeInAllWindows: () => Promise<void>;
    switchToTabInGroup: () => void;
    getActiveLeafInFocusedWindow: () => WorkspaceLeaf | null;
    focusLeafAndWindow: (leaf: WorkspaceLeaf) => void;
    isSidebarLeaf: (leaf: WorkspaceLeaf) => boolean;
    buildNavigationModel: (activeLeaf: WorkspaceLeaf | null) => any;
    askConfirmation: (title: string, body: HTMLElement) => Promise<boolean>;
    leafLastActive: Map<string, number>;
};

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

function leaf(
    id: string,
    file: string | null,
    parent: MockWorkspaceParent,
    container: MockWorkspaceContainer
): MockWorkspaceLeaf {
    const l = new MockWorkspaceLeaf(file).setId(id).setParent(parent);
    l.setContainer(container);
    return l;
}

function sidebarLeaf(
    id: string,
    app: MockApp,
    container: MockWorkspaceContainer
): MockWorkspaceLeaf {
    const sidebarGroup = new MockWorkspaceParent(container);
    (sidebarGroup as unknown as { type: string }).type = 'tabs';
    const sidebarSplit = new MockWorkspaceParent(container);
    (sidebarSplit as unknown as { type: string; direction: string }).type = 'split';
    (sidebarSplit as unknown as { direction: string }).direction = 'vertical';
    (sidebarSplit.containerEl as any).ownerDocument = { defaultView: container.win };
    (sidebarSplit.containerEl as any).classList.add('mod-vertical');
    sidebarGroup.parent = sidebarSplit;
    sidebarSplit.children = [sidebarGroup] as unknown as MockWorkspaceLeaf[];

    const l = new MockWorkspaceLeaf('SidebarNote.md').setId(id).setParent(sidebarGroup);
    l.setContainer(container);
    (l as unknown as { getRoot: () => unknown }).getRoot = () => app.workspace.leftSplit;
    return l;
}

function setRect(group: MockWorkspaceParent, x: number, y: number, w = 100, h = 100): void {
    (group.containerEl as MockContainerEl).getBoundingClientRect = () => ({
        left: x,
        top: y,
        width: w,
        height: h,
        right: x + w,
        bottom: y + h,
        x,
        y,
        toJSON: () => ({}),
    });
}

function buildSplit(
    direction: 'horizontal' | 'vertical',
    container: MockWorkspaceContainer,
    groups: MockWorkspaceParent[]
): MockWorkspaceParent {
    const split = new MockWorkspaceParent(container);
    (split as unknown as { type: string; direction: string }).type = 'split';
    (split as unknown as { direction: string }).direction = direction;
    (split.containerEl as unknown as { classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean } }).classList.add(`mod-${direction}`);
    (split.containerEl as any).ownerDocument = { defaultView: container.win };

    for (const g of groups) {
        (g as unknown as { type: string }).type = 'tabs';
        g.parent = split;
    }
    split.children = groups as unknown as MockWorkspaceLeaf[];
    return split;
}

describe('Command Guardrails: Multi-Window Isolation & Edge Cases', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let winA: Window;
    let winB: Window;
    let containerA: MockWorkspaceContainer;
    let containerB: MockWorkspaceContainer;

    let originalActiveWindow: Window | undefined;

    beforeEach(async () => {
        originalActiveWindow = (globalThis as any).activeWindow;
        app = new MockApp();
        winA = { focus: vi.fn() } as unknown as Window;
        winB = { focus: vi.fn() } as unknown as Window;
        (globalThis as any).activeWindow = winA;
        containerA = new MockWorkspaceContainer('root', winA);
        containerB = new MockWorkspaceContainer('window', winB);
        plugin = createPlugin(app);
        await plugin.onload();
    });

    afterEach(() => {
        (globalThis as any).activeWindow = originalActiveWindow;
    });

    describe('Window Isolation Guardrails', () => {
        it('cycleTabGroups in Window A never activates a leaf or group in Window B', async () => {
            const groupA1 = new MockWorkspaceParent(containerA);
            const groupA2 = new MockWorkspaceParent(containerA);
            const groupB1 = new MockWorkspaceParent(containerB);

            setRect(groupA1, 0, 0);
            setRect(groupA2, 200, 0);
            setRect(groupB1, 0, 0);

            const leafA1 = leaf('a1', 'A1.md', groupA1, containerA);
            const leafA2 = leaf('a2', 'A2.md', groupA2, containerA);
            const leafB1 = leaf('b1', 'B1.md', groupB1, containerB);

            app.workspace.allLeaves = [leafA1, leafA2, leafB1];
            app.workspace.rootLeaves = [leafA1, leafA2];
            app.workspace.setActiveLeaf(leafA1);

            plugin.cycleTabGroups();
            expect(app.workspace.activeLeaf).toBe(leafA2);

            plugin.cycleTabGroups();
            // Wraps around within Window A, never entering Window B
            expect(app.workspace.activeLeaf).toBe(leafA1);
        });

        it('rotateTabGroups in Window A strictly preserves split direction and child order in Window B', async () => {
            const groupA1 = new MockWorkspaceParent(containerA);
            const groupA2 = new MockWorkspaceParent(containerA);
            const splitA = buildSplit('vertical', containerA, [groupA1, groupA2]);

            const groupB1 = new MockWorkspaceParent(containerB);
            const groupB2 = new MockWorkspaceParent(containerB);
            const splitB = buildSplit('vertical', containerB, [groupB1, groupB2]);

            const leafA1 = leaf('a1', 'A1.md', groupA1, containerA);
            const leafA2 = leaf('a2', 'A2.md', groupA2, containerA);
            const leafB1 = leaf('b1', 'B1.md', groupB1, containerB);
            const leafB2 = leaf('b2', 'B2.md', groupB2, containerB);

            app.workspace.allLeaves = [leafA1, leafA2, leafB1, leafB2];
            app.workspace.setActiveLeaf(leafA1);

            await plugin.rotateTabGroups();

            // Window A split rotated to horizontal
            expect((splitA as unknown as { direction: string }).direction).toBe('horizontal');

            // Window B split must remain strictly vertical
            expect((splitB as unknown as { direction: string }).direction).toBe('vertical');
            const classListB = (splitB.containerEl as unknown as { classList: { contains: (c: string) => boolean } }).classList;
            expect(classListB.contains('mod-vertical')).toBe(true);
            expect(classListB.contains('mod-horizontal')).toBe(false);
            expect(splitB.children[0]).toBe(groupB1);
            expect(splitB.children[1]).toBe(groupB2);
        });

        it('dedupeInGroup in Window A never touches tabs in other groups in Window A or any group in Window B', async () => {
            const groupA1 = new MockWorkspaceParent(containerA);
            const groupA2 = new MockWorkspaceParent(containerA);
            const groupB1 = new MockWorkspaceParent(containerB);

            const activeA1 = leaf('a1', 'Note.md', groupA1, containerA);
            const dupA1 = leaf('a1_dup', 'Note.md', groupA1, containerA);
            const otherGroupDupA2 = leaf('a2_dup', 'Note.md', groupA2, containerA);
            const otherWinDupB = leaf('b_dup', 'Note.md', groupB1, containerB);

            app.workspace.allLeaves = [activeA1, dupA1, otherGroupDupA2, otherWinDupB];
            app.workspace.rootLeaves = [activeA1, dupA1, otherGroupDupA2];
            app.workspace.setActiveLeaf(activeA1);

            plugin.settings.confirmDedupeGroup = false;
            await plugin.dedupeInGroup();

            expect(activeA1.detached).toBe(false);
            expect(dupA1.detached).toBe(true);
            // Must NOT touch the duplicate in another group or window
            expect(otherGroupDupA2.detached).toBe(false);
            expect(otherWinDupB.detached).toBe(false);
        });

        it('dedupeInAllGroups in Window A closes duplicates across groups in Window A but leaves Window B untouched', async () => {
            const groupA1 = new MockWorkspaceParent(containerA);
            const groupA2 = new MockWorkspaceParent(containerA);
            const groupB1 = new MockWorkspaceParent(containerB);

            const activeA1 = leaf('a1', 'Note.md', groupA1, containerA);
            const dupA2 = leaf('a2_dup', 'Note.md', groupA2, containerA);
            const dupB1 = leaf('b1_dup', 'Note.md', groupB1, containerB);

            app.workspace.allLeaves = [activeA1, dupA2, dupB1];
            app.workspace.rootLeaves = [activeA1, dupA2];
            app.workspace.setActiveLeaf(activeA1);

            plugin.settings.confirmDedupeAllGroups = false;
            await plugin.dedupeInAllGroups();

            expect(activeA1.detached).toBe(false);
            expect(dupA2.detached).toBe(true);
            // Window B duplicate must be strictly untouched
            expect(dupB1.detached).toBe(false);
        });

        it('dedupeInAllWindows closes duplicates across windows while respecting active window priority', async () => {
            const groupA = new MockWorkspaceParent(containerA);
            const groupB = new MockWorkspaceParent(containerB);

            const activeA = leaf('a', 'Note.md', groupA, containerA);
            const dupB = leaf('b_dup', 'Note.md', groupB, containerB);

            app.workspace.allLeaves = [activeA, dupB];
            app.workspace.rootLeaves = [activeA];
            app.workspace.setActiveLeaf(activeA);

            plugin.settings.confirmDedupeAllWindows = false;
            await plugin.dedupeInAllWindows();

            expect(activeA.detached).toBe(false);
            // In all windows scope, dupB is closed because activeA has priority
            expect(dupB.detached).toBe(true);
        });

        it('switchToTabInGroup only includes leaves from the active group', () => {
            const groupA1 = new MockWorkspaceParent(containerA);
            const groupA2 = new MockWorkspaceParent(containerA);
            const groupB = new MockWorkspaceParent(containerB);

            const tab1 = leaf('t1', 'T1.md', groupA1, containerA);
            const tab2 = leaf('t2', 'T2.md', groupA1, containerA);
            const tabA2 = leaf('tA2', 'T3.md', groupA2, containerA);
            const tabB = leaf('tB', 'TB.md', groupB, containerB);

            app.workspace.allLeaves = [tab1, tab2, tabA2, tabB];
            app.workspace.setActiveLeaf(tab1);


            const model = plugin.buildNavigationModel(tab1 as unknown as WorkspaceLeaf);
            const activeGroup = (plugin as any).getGroupForLeaf(model, tab1 as unknown as WorkspaceLeaf);
            expect(activeGroup.leaves).toHaveLength(2);
            expect(activeGroup.leaves).toContain(tab1);
            expect(activeGroup.leaves).toContain(tab2);
            expect(activeGroup.leaves).not.toContain(tabA2);
            expect(activeGroup.leaves).not.toContain(tabB);
        });
    });

    describe('Sidebar Focus Trap Guardrails', () => {
        it('isSidebarLeaf correctly detects leaves rooted at leftSplit or rightSplit', () => {
            const sLeaf = sidebarLeaf('sb1', app, containerA);
            const regularGroup = new MockWorkspaceParent(containerA);
            const regLeaf = leaf('r1', 'R.md', regularGroup, containerA);

            expect(plugin.isSidebarLeaf(sLeaf as unknown as WorkspaceLeaf)).toBe(true);
            expect(plugin.isSidebarLeaf(regLeaf as unknown as WorkspaceLeaf)).toBe(false);
        });

        it('rotateTabGroups does not rotate sidebar sidedock when a sidebar leaf is active', async () => {
            const sLeaf = sidebarLeaf('sb1', app, containerA);
            const editorGroup1 = new MockWorkspaceParent(containerA);
            const editorGroup2 = new MockWorkspaceParent(containerA);
            const editorSplit = buildSplit('vertical', containerA, [editorGroup1, editorGroup2]);

            const ed1 = leaf('ed1', 'Ed1.md', editorGroup1, containerA);
            const ed2 = leaf('ed2', 'Ed2.md', editorGroup2, containerA);

            app.workspace.allLeaves = [sLeaf, ed1, ed2];
            app.workspace.rootLeaves = [ed1, ed2];
            app.workspace.setActiveLeaf(sLeaf);

            // When sidebar is active, rotateTabGroups should either fall back to the root editor split
            // or safely exit without rotating the sidebar sidedock!
            const sidebarSplit = (sLeaf.parent as MockWorkspaceParent).parent as MockWorkspaceParent;
            const sidebarDirBefore = (sidebarSplit as unknown as { direction: string }).direction;

            await plugin.rotateTabGroups();

            // The sidebar's split must NEVER be rotated
            const sidebarDirAfter = (sidebarSplit as unknown as { direction: string }).direction;
            expect(sidebarDirAfter).toBe(sidebarDirBefore);
        });

        it('cycleTabGroups when sidebar is active safely targets root editor groups', async () => {
            const sLeaf = sidebarLeaf('sb1', app, containerA);
            const group1 = new MockWorkspaceParent(containerA);
            const group2 = new MockWorkspaceParent(containerA);
            setRect(group1, 0, 0);
            setRect(group2, 200, 0);

            const ed1 = leaf('ed1', 'Ed1.md', group1, containerA);
            const ed2 = leaf('ed2', 'Ed2.md', group2, containerA);

            app.workspace.allLeaves = [sLeaf, ed1, ed2];
            app.workspace.rootLeaves = [ed1, ed2];
            app.workspace.setActiveLeaf(sLeaf);

            plugin.cycleTabGroups();

            // Should cycle to an editor tab in group1 or group2, not stay on sidebar or crash
            expect([ed1, ed2]).toContain(app.workspace.activeLeaf);
        });
    });

    describe('Edge Cases, Modals, and Tiebreaks', () => {
        it('cycleTabGroups falls back to group.representative when stored active tab was closed', async () => {
            const group1 = new MockWorkspaceParent(containerA);
            const group2 = new MockWorkspaceParent(containerA);
            setRect(group1, 0, 0);
            setRect(group2, 200, 0);

            const a1 = leaf('a1', 'A1.md', group1, containerA);
            const b1 = leaf('b1', 'B1.md', group2, containerA);
            const b2_closed = leaf('b2', 'B2.md', group2, containerA);

            app.workspace.allLeaves = [a1, b1];
            app.workspace.rootLeaves = [a1, b1];
            app.workspace.setActiveLeaf(a1);

            // Stored leaf in group2 was closed (detached and parent set to null)
            b2_closed.parent = null;
            (plugin as any).tabGroupActiveLeaves.set(group2, b2_closed);

            plugin.cycleTabGroups();

            // Should cleanly fall back to b1 (the representative) instead of attempting to focus b2_closed
            expect(app.workspace.activeLeaf).toBe(b1);
        });

        it('cycleTabGroups breaks spatial ties deterministically using group label', async () => {
            const group1 = new MockWorkspaceParent(containerA);
            const group2 = new MockWorkspaceParent(containerA);
            // Identical coordinates
            setRect(group1, 0, 0);
            setRect(group2, 0, 0);

            const zLeaf = leaf('z', 'Zebra.md', group1, containerA);
            const aLeaf = leaf('a', 'Apple.md', group2, containerA);

            app.workspace.allLeaves = [zLeaf, aLeaf];
            app.workspace.rootLeaves = [zLeaf, aLeaf];
            app.workspace.setActiveLeaf(zLeaf);

            plugin.cycleTabGroups();
            expect(app.workspace.activeLeaf).toBe(aLeaf);
        });

        it('deduplication safely ignores non-file leaves without throwing an error', async () => {
            const group = new MockWorkspaceParent(containerA);
            const normal = leaf('n1', 'Note.md', group, containerA);
            const canvasOrGraph = leaf('g1', null, group, containerA); // null filePath
            canvasOrGraph.view = { file: null };

            app.workspace.allLeaves = [normal, canvasOrGraph];
            app.workspace.rootLeaves = [normal, canvasOrGraph];
            app.workspace.setActiveLeaf(normal);

            plugin.settings.confirmDedupeGroup = false;
            await expect(plugin.dedupeInGroup()).resolves.not.toThrow();
            expect(canvasOrGraph.detached).toBe(false);
            expect(normal.detached).toBe(false);
        });

        it('deduplication does not detach leaves when confirmation modal is cancelled', async () => {
            const group = new MockWorkspaceParent(containerA);
            const a1 = leaf('a1', 'Note.md', group, containerA);
            const a2 = leaf('a2', 'Note.md', group, containerA);

            app.workspace.allLeaves = [a1, a2];
            app.workspace.rootLeaves = [a1, a2];
            app.workspace.setActiveLeaf(a1);

            plugin.settings.confirmDedupeGroup = true;
            // Mock askConfirmation resolving false (user clicked Cancel or pressed Escape)
            plugin.askConfirmation = vi.fn().mockResolvedValue(false);

            await plugin.dedupeInGroup();

            expect(plugin.askConfirmation).toHaveBeenCalled();
            // Zero leaves detached!
            expect(a1.detached).toBe(false);
            expect(a2.detached).toBe(false);
        });

        it('focusLeafAndWindow calls targetWin.focus() when leaf belongs to a different window', () => {
            const groupB = new MockWorkspaceParent(containerB);
            const bLeaf = leaf('b', 'B.md', groupB, containerB);

            plugin.focusLeafAndWindow(bLeaf as unknown as WorkspaceLeaf);

            expect(app.workspace.activeLeaf).toBe(bLeaf);
            expect(winB.focus).toHaveBeenCalled();
        });
    });
});
