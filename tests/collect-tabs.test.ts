import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
} from './mocks/obsidian';

type TestPlugin = NextTabGroupPlugin & {
    collectTabs: () => Promise<void>;
    getActiveLeafInFocusedWindow: () => WorkspaceLeaf | null;
    buildNavigationModel: (activeLeaf: WorkspaceLeaf | null) => {
        tabs: Array<{ leaf: WorkspaceLeaf; group: { window: unknown } }>;
    };
    getWindowForLeaf: (leaf: WorkspaceLeaf | null) => unknown;
    getTabsInWindow: (model: { tabs: Array<{ leaf: WorkspaceLeaf; group: { window: unknown } }> }, targetWindow: unknown) => Array<{ leaf: WorkspaceLeaf }>;
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

describe('collectTabs', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let rootContainer: MockWorkspaceContainer;

    beforeEach(async () => {
        app = new MockApp();
        rootContainer = new MockWorkspaceContainer('root', {} as Window);
        plugin = createPlugin(app);
        await plugin.onload();
    });

    it('migrates tabs from other groups in the same window without destroying siblings in the active group', async () => {
        const group1 = new MockWorkspaceParent(rootContainer);
        const group2 = new MockWorkspaceParent(rootContainer);

        // Group 1 has active tab and a sibling tab
        const active = leaf('active', 'Active.md', group1, rootContainer);
        const sibling = leaf('sibling', 'Sibling.md', group1, rootContainer);

        // Group 2 has foreign tabs
        const foreign1 = leaf('f1', 'Foreign1.md', group2, rootContainer);
        const foreign2 = leaf('f2', 'Foreign2.md', group2, rootContainer);

        app.workspace.allLeaves = [active, sibling, foreign1, foreign2];
        app.workspace.rootLeaves = [active, sibling, foreign1, foreign2];
        app.workspace.setActiveLeaf(active);

        // Track createLeafInParent calls
        const createdLeaves: MockWorkspaceLeaf[] = [];
        const originalCreateLeafInParent = app.workspace.createLeafInParent.bind(app.workspace);
        app.workspace.createLeafInParent = (parent: MockWorkspaceParent, index: number) => {
            const created = originalCreateLeafInParent(parent, index);
            createdLeaves.push(created);
            return created;
        };

        await plugin.collectTabs();

        // Sibling tab in the SAME group must NEVER be detached!
        expect(sibling.detached, 'sibling in active group must not be detached').toBe(false);
        expect(active.detached, 'active leaf must not be detached').toBe(false);

        // Foreign tabs from group2 should be detached
        expect(foreign1.detached, 'foreign1 must be detached after migration').toBe(true);
        expect(foreign2.detached, 'foreign2 must be detached after migration').toBe(true);

        // Only foreign tabs should have been recreated in group1
        expect(createdLeaves).toHaveLength(2);
        for (const cl of createdLeaves) {
            expect(cl.parent).toBe(group1);
        }

        // Active leaf remains focused
        expect(app.workspace.activeLeaf).toBe(active);
    });

    it('does nothing when all tabs in the window are already in the active group', async () => {
        const group = new MockWorkspaceParent(rootContainer);
        const active = leaf('a', 'A.md', group, rootContainer);
        const tab1 = leaf('b', 'B.md', group, rootContainer);
        const tab2 = leaf('c', 'C.md', group, rootContainer);

        app.workspace.allLeaves = [active, tab1, tab2];
        app.workspace.rootLeaves = [active, tab1, tab2];
        app.workspace.setActiveLeaf(active);

        const calls: Array<{ parent: MockWorkspaceParent; index: number }> = [];
        app.workspace.createLeafInParent = (parent: MockWorkspaceParent, index: number) => {
            calls.push({ parent, index });
            return new MockWorkspaceLeaf(null).setId(`leaf_${app.workspace.allLeaves.length}`).setParent(parent);
        };

        await plugin.collectTabs();

        // No new leaves created and no existing leaves detached
        expect(calls).toHaveLength(0);
        expect(active.detached).toBe(false);
        expect(tab1.detached).toBe(false);
        expect(tab2.detached).toBe(false);
    });

    it('strictly preserves popout window tabs and never migrates them into the main window', async () => {
        const popoutContainer = new MockWorkspaceContainer('window', {} as Window);
        const group1 = new MockWorkspaceParent(rootContainer);
        const group2 = new MockWorkspaceParent(rootContainer);
        const groupPopout = new MockWorkspaceParent(popoutContainer);

        const active = leaf('main-act', 'MainAct.md', group1, rootContainer);
        const mainForeign = leaf('main-f', 'MainForeign.md', group2, rootContainer);
        const popout1 = leaf('pop-1', 'Popout1.md', groupPopout, popoutContainer);
        const popout2 = leaf('pop-2', 'Popout2.md', groupPopout, popoutContainer);

        app.workspace.allLeaves = [active, mainForeign, popout1, popout2];
        app.workspace.rootLeaves = [active, mainForeign, popout1, popout2];
        app.workspace.setActiveLeaf(active);

        await plugin.collectTabs();

        // Main foreign tab is migrated
        expect(mainForeign.detached).toBe(true);

        // Popout tabs must be completely untouched!
        expect(popout1.detached, 'popout leaf 1 must not be detached').toBe(false);
        expect(popout2.detached, 'popout leaf 2 must not be detached').toBe(false);
        expect(popout1.parent).toBe(groupPopout);
        expect(popout2.parent).toBe(groupPopout);
    });

    it('preserves ephemeral state and creates migrated leaves in background (active: false)', async () => {
        const group1 = new MockWorkspaceParent(rootContainer);
        const group2 = new MockWorkspaceParent(rootContainer);

        const active = leaf('act', 'Act.md', group1, rootContainer);
        const foreign = leaf('f', 'Foreign.md', group2, rootContainer);

        // Give foreign leaf specific ephemeral state (cursor, scroll) and active viewState
        foreign.setEphemeralState({ scroll: 42, cursor: { line: 10, ch: 5 } });
        // Suppose foreign leaf had active: true in its split
        foreign.lastSetViewStateArg = { type: 'markdown', state: { file: 'Foreign.md' }, active: true };

        app.workspace.allLeaves = [active, foreign];
        app.workspace.rootLeaves = [active, foreign];
        app.workspace.setActiveLeaf(active);

        let createdLeaf: MockWorkspaceLeaf | null = null;
        const originalCreateLeafInParent = app.workspace.createLeafInParent.bind(app.workspace);
        app.workspace.createLeafInParent = (parent: MockWorkspaceParent, index: number) => {
            createdLeaf = originalCreateLeafInParent(parent, index);
            return createdLeaf;
        };

        await plugin.collectTabs();

        expect(createdLeaf).not.toBeNull();
        // Ephemeral state must be preserved
        expect((createdLeaf as unknown as MockWorkspaceLeaf).getEphemeralState()).toEqual({
            scroll: 42,
            cursor: { line: 10, ch: 5 },
        });

        // The view state passed must have active: false to prevent sequential activation storms
        const lastArg = (createdLeaf as unknown as MockWorkspaceLeaf).lastSetViewStateArg as Record<string, unknown>;
        expect(lastArg?.active).toBe(false);
    });

    it('does nothing when active leaf is in a sidebar', async () => {
        const sidebarLeaf = leaf('sidebar', null, new MockWorkspaceParent(), rootContainer);
        sidebarLeaf.getRoot = () => app.workspace.leftSplit;

        const mainGroup = new MockWorkspaceParent(rootContainer);
        const tab1 = leaf('t1', 'Doc1.md', mainGroup, rootContainer);
        const tab2 = leaf('t2', 'Doc2.md', mainGroup, rootContainer);

        app.workspace.allLeaves = [sidebarLeaf, tab1, tab2];
        app.workspace.rootLeaves = [tab1, tab2];
        app.workspace.setActiveLeaf(sidebarLeaf);

        const calls: Array<{ parent: MockWorkspaceParent; index: number }> = [];
        app.workspace.createLeafInParent = (parent: MockWorkspaceParent, index: number) => {
            calls.push({ parent, index });
            return new MockWorkspaceLeaf(null);
        };

        await plugin.collectTabs();

        expect(calls).toHaveLength(0);
        expect(tab1.detached).toBe(false);
        expect(tab2.detached).toBe(false);
    });
});
