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
    let container: MockWorkspaceContainer;

    beforeEach(async () => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', {} as Window);
        plugin = createPlugin(app);
        await plugin.onload();
    });

    it('migrates tabs into the active group using createLeafInParent', async () => {
        const group = new MockWorkspaceParent(container);
        const active = leaf('a', 'A.md', group, container);
        const tab1 = leaf('b', 'B.md', group, container);
        const tab2 = leaf('c', 'C.md', group, container);

        app.workspace.allLeaves = [active, tab1, tab2];
        app.workspace.rootLeaves = [active, tab1, tab2];
        app.workspace.setActiveLeaf(active);

        // Track createLeafInParent calls.
        const calls: Array<{ parent: MockWorkspaceParent; index: number }> = [];
        const original = app.workspace.createLeafInParent.bind(app.workspace);
        app.workspace.createLeafInParent = (parent: MockWorkspaceParent, index: number) => {
            calls.push({ parent, index });
            return original(parent, index);
        };

        await plugin.collectTabs();

        expect(calls).toHaveLength(2);
        for (const call of calls) {
            expect(call.parent).toBe(group);
            expect(call.index).toBe(-1);
        }

        expect(tab1.detached).toBe(true);
        expect(tab2.detached).toBe(true);
        expect(active.detached).toBe(false);
    });

    it('does nothing when there are no other tabs to collect', async () => {
        const group = new MockWorkspaceParent(container);
        const active = leaf('a', 'A.md', group, container);

        app.workspace.allLeaves = [active];
        app.workspace.rootLeaves = [active];
        app.workspace.setActiveLeaf(active);

        const calls: Array<{ parent: MockWorkspaceParent; index: number }> = [];
        app.workspace.createLeafInParent = (parent: MockWorkspaceParent, index: number) => {
            calls.push({ parent, index });
            return new MockWorkspaceLeaf(null).setId(`leaf_${app.workspace.allLeaves.length}`).setParent(parent);
        };

        await plugin.collectTabs();

        expect(calls).toHaveLength(0);
    });
});
