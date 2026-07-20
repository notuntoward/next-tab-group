import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
} from './mocks/obsidian';

type TestPlugin = NextPlugin & {
    rotateTabGroups: () => Promise<void>;
    buildNavigationModel: (activeLeaf: WorkspaceLeaf | null) => {
        groups: Array<{ leaves: WorkspaceLeaf[]; group: unknown }>;
        splits: Map<string, { direction: string; liveSplit?: unknown }>;
    };
};
type NextPlugin = NextTabGroupPlugin;

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

function mockLeaf(id: string, file: string, container: MockWorkspaceContainer): MockWorkspaceLeaf {
    return new MockWorkspaceLeaf(file).setId(id).setContainer(container);
}

function makeGroup(leaves: MockWorkspaceLeaf[], container: MockWorkspaceContainer): MockWorkspaceParent {
    const group = new MockWorkspaceParent(container);
    for (const leaf of leaves) leaf.setParent(group);
    return group;
}

describe('rotateTabGroups (in-place, no detach)', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;

    beforeEach(() => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', {} as Window);
        plugin = createPlugin(app);
    });

    function buildVerticalSplit() {
        const split = new MockWorkspaceParent(container);
        (split as unknown as { type: string; direction: string }).type = 'split';
        (split as unknown as { direction: string }).direction = 'vertical';
        (split.containerEl as unknown as { classList: { add: (c: string) => void } }).classList.add('mod-vertical');

        const g1 = makeGroup([mockLeaf('a1', 'A1.md', container), mockLeaf('a2', 'A2.md', container)], container);
        const g2 = makeGroup([mockLeaf('b1', 'B1.md', container)], container);
        const g3 = makeGroup([mockLeaf('c1', 'C1.md', container)], container);
        for (const g of [g1, g2, g3]) {
            (g as unknown as { type: string }).type = 'tabs';
            g.parent = split;
        }
        split.children = [g1, g2, g3] as unknown as MockWorkspaceLeaf[];
        return { split, all: [g1, g2, g3].flatMap((g) => g.children) as MockWorkspaceLeaf[] };
    }

    it('flips split direction in place without detaching or losing any tabs', async () => {
        const { split, all } = buildVerticalSplit();
        app.workspace.allLeaves = all;
        app.workspace.setActiveLeaf(all[0]);

        await plugin.rotateTabGroups();

        // The live split direction and its CSS class are toggled.
        expect((split as unknown as { direction: string }).direction).toBe('horizontal');
        const classList = (split.containerEl as unknown as { classList: { contains: (c: string) => boolean } }).classList;
        expect(classList.contains('mod-horizontal')).toBe(true);
        expect(classList.contains('mod-vertical')).toBe(false);

        // No tab was detached — the workspace tree is fully preserved.
        const detached = (app.workspace.allLeaves as unknown as MockWorkspaceLeaf[]).filter((l) => l.detached);
        expect(detached).toHaveLength(0);

        const afterModel = plugin.buildNavigationModel(all[0] as unknown as WorkspaceLeaf);
        const afterTotal = afterModel.groups.reduce((n, g) => n + g.leaves.length, 0);
        expect(afterTotal).toBe(all.length);
    });

    it('does nothing when there is no enclosing split', async () => {
        const g1 = makeGroup([mockLeaf('a1', 'A1.md', container), mockLeaf('a2', 'A2.md', container)], container);
        (g1 as unknown as { type: string }).type = 'tabs';
        app.workspace.allLeaves = g1.children as unknown as MockWorkspaceLeaf[];
        app.workspace.setActiveLeaf(g1.children[0] as unknown as MockWorkspaceLeaf);

        await plugin.rotateTabGroups();

        const detached = (app.workspace.allLeaves as unknown as MockWorkspaceLeaf[]).filter((l) => l.detached);
        expect(detached).toHaveLength(0);
    });
});
