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
        (split.containerEl as any).ownerDocument = { defaultView: container.win };

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

    it('only rotates splits belonging to the active leaf window, leaving other windows untouched', async () => {
        const mainWin = {} as Window;
        const popoutWin = {} as Window;
        const mainContainer = new MockWorkspaceContainer('root', mainWin);
        const popoutContainer = new MockWorkspaceContainer('window', popoutWin);

        const mainSplit = new MockWorkspaceParent(mainContainer);
        (mainSplit as unknown as { type: string; direction: string }).type = 'split';
        (mainSplit as unknown as { direction: string }).direction = 'vertical';
        (mainSplit.containerEl as unknown as { classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean } }).classList.add('mod-vertical');
        (mainSplit.containerEl as any).ownerDocument = { defaultView: mainWin };

        const popoutSplit = new MockWorkspaceParent(popoutContainer);
        (popoutSplit as unknown as { type: string; direction: string }).type = 'split';
        (popoutSplit as unknown as { direction: string }).direction = 'vertical';
        (popoutSplit.containerEl as unknown as { classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean } }).classList.add('mod-vertical');
        (popoutSplit.containerEl as any).ownerDocument = { defaultView: popoutWin };

        const mainGroup = makeGroup([mockLeaf('m1', 'A.md', mainContainer)], mainContainer);
        const popoutGroup = makeGroup([mockLeaf('p1', 'B.md', popoutContainer)], popoutContainer);
        (mainGroup as unknown as { type: string }).type = 'tabs';
        (popoutGroup as unknown as { type: string }).type = 'tabs';
        mainGroup.parent = mainSplit;
        popoutGroup.parent = popoutSplit;
        mainSplit.children = [mainGroup] as unknown as MockWorkspaceLeaf[];
        popoutSplit.children = [popoutGroup] as unknown as MockWorkspaceLeaf[];

        app.workspace.allLeaves = [mainGroup.children[0] as unknown as MockWorkspaceLeaf, popoutGroup.children[0] as unknown as MockWorkspaceLeaf];
        app.workspace.setActiveLeaf(popoutGroup.children[0] as unknown as MockWorkspaceLeaf);

        await plugin.rotateTabGroups();

        // Main window split must remain vertical.
        const mainClassList = (mainSplit.containerEl as unknown as { classList: { contains: (c: string) => boolean } }).classList;
        expect(mainClassList.contains('mod-vertical')).toBe(true);
        expect(mainClassList.contains('mod-horizontal')).toBe(false);
        expect((mainSplit as unknown as { direction: string }).direction).toBe('vertical');

        // Pop-out split must be rotated to horizontal.
        const popoutClassList = (popoutSplit.containerEl as unknown as { classList: { contains: (c: string) => boolean } }).classList;
        expect(popoutClassList.contains('mod-horizontal')).toBe(true);
        expect(popoutClassList.contains('mod-vertical')).toBe(false);
        expect((popoutSplit as unknown as { direction: string }).direction).toBe('horizontal');

        const detached = (app.workspace.allLeaves as unknown as MockWorkspaceLeaf[]).filter((l) => l.detached);
        expect(detached).toHaveLength(0);
    });
});
