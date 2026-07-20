import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
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
    buildNavigationModel: (activeLeaf: WorkspaceLeaf | null) => {
        groups: Array<{
            leaves: WorkspaceLeaf[];
            group: MockWorkspaceParent;
            representative: WorkspaceLeaf;
            lastActive: number;
            label: string;
            relativeLabel: string | null;
            isCurrentGroup: boolean;
            window: Window | undefined;
        }>;
    };
};

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

function leaf(
    id: string,
    file: string,
    parent: MockWorkspaceParent,
    container: MockWorkspaceContainer | null = null
): MockWorkspaceLeaf {
    const l = new MockWorkspaceLeaf(file).setId(id).setParent(parent);
    if (container) l.setContainer(container);
    return l;
}

function makeGroup(
    container: MockWorkspaceContainer
): MockWorkspaceParent {
    return new MockWorkspaceParent(container);
}

function setRect(group: MockWorkspaceParent, x: number, y: number): void {
    (group.containerEl as MockContainerEl).getBoundingClientRect = () => ({
        left: x,
        top: y,
        width: 100,
        height: 100,
        right: x + 100,
        bottom: y + 100,
        x,
        y,
        toJSON: () => ({}),
    });
}

describe('cycleTabGroups', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;

    beforeEach(() => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', {} as Window);
        plugin = createPlugin(app);
    });

    it('does nothing when there is only one tab group', async () => {
        const group = makeGroup(container);
        const a1 = leaf('a1', 'A.md', group, container);

        app.workspace.allLeaves = [a1];
        app.workspace.rootLeaves = [a1];
        app.workspace.setActiveLeaf(a1);

        await plugin.cycleTabGroups();

        expect(app.workspace.activeLeaf).toBe(a1);
    });

    it('cycles to the next group spatially (left to right)', async () => {
        const group1 = makeGroup(container);
        const group2 = makeGroup(container);
        const a1 = leaf('a1', 'A.md', group1, container);
        const b1 = leaf('b1', 'B.md', group2, container);
        setRect(group1, 0, 0);
        setRect(group2, 200, 0);

        app.workspace.allLeaves = [a1, b1];
        app.workspace.rootLeaves = [a1, b1];
        app.workspace.setActiveLeaf(a1);

        await plugin.cycleTabGroups();

        expect(app.workspace.activeLeaf).toBe(b1);
    });

    it('wraps around from the last group back to the first', async () => {
        const group1 = makeGroup(container);
        const group2 = makeGroup(container);
        const a1 = leaf('a1', 'A.md', group1, container);
        const b1 = leaf('b1', 'B.md', group2, container);
        setRect(group1, 0, 0);
        setRect(group2, 200, 0);

        app.workspace.allLeaves = [a1, b1];
        app.workspace.rootLeaves = [a1, b1];
        app.workspace.setActiveLeaf(b1);

        await plugin.cycleTabGroups();

        expect(app.workspace.activeLeaf).toBe(a1);
    });

    it('cycles top to bottom when groups are stacked vertically', async () => {
        const groupTop = makeGroup(container);
        const groupBot = makeGroup(container);
        const t1 = leaf('t1', 'Top.md', groupTop, container);
        const b1 = leaf('b1', 'Bot.md', groupBot, container);
        setRect(groupTop, 0, 0);
        setRect(groupBot, 0, 200);

        app.workspace.allLeaves = [t1, b1];
        app.workspace.rootLeaves = [t1, b1];
        app.workspace.setActiveLeaf(t1);

        await plugin.cycleTabGroups();

        expect(app.workspace.activeLeaf).toBe(b1);
    });

    it('remembers and restores the active tab when returning to a group', async () => {
        const group1 = makeGroup(container);
        const group2 = makeGroup(container);
        const a1 = leaf('a1', 'A1.md', group1, container);
        const a2 = leaf('a2', 'A2.md', group1, container);
        const b1 = leaf('b1', 'B1.md', group2, container);
        const b2 = leaf('b2', 'B2.md', group2, container);
        setRect(group1, 0, 0);
        setRect(group2, 200, 0);

        app.workspace.allLeaves = [a1, a2, b1, b2];
        app.workspace.rootLeaves = app.workspace.allLeaves;
        app.workspace.setActiveLeaf(a1);

        plugin.leafLastActive.set('a1', 100);
        plugin.leafLastActive.set('a2', 200);
        plugin.leafLastActive.set('b1', 300);
        plugin.leafLastActive.set('b2', 400);

        await plugin.cycleTabGroups();
        expect(app.workspace.activeLeaf).toBe(b2);

        await plugin.cycleTabGroups();
        expect(app.workspace.activeLeaf).toBe(a1);
    });

    it('focuses the first group when the active leaf has no parent', async () => {
        const group1 = makeGroup(container);
        const group2 = makeGroup(container);
        const a1 = leaf('a1', 'A.md', group1, container);
        const b1 = leaf('b1', 'B.md', group2, container);
        const orphan = new MockWorkspaceLeaf('Orphan.md').setId('orphan');
        orphan.setContainer(container);
        setRect(group1, 0, 0);
        setRect(group2, 200, 0);

        app.workspace.allLeaves = [orphan, a1, b1];
        app.workspace.rootLeaves = [orphan, a1, b1];
        app.workspace.setActiveLeaf(orphan);

        await plugin.cycleTabGroups();

        expect(app.workspace.activeLeaf).toBe(a1);
    });

    it('does not cycle into groups in another window', async () => {
        const mainContainer = new MockWorkspaceContainer('root', {} as Window);
        const popoutContainer = new MockWorkspaceContainer('window', {} as Window);

        const mainGroup = makeGroup(mainContainer);
        const popoutGroup = makeGroup(popoutContainer);
        const m1 = leaf('m1', 'Main.md', mainGroup, mainContainer);
        const p1 = leaf('p1', 'Pop.md', popoutGroup, popoutContainer);
        setRect(mainGroup, 0, 0);
        setRect(popoutGroup, 0, 0);

        app.workspace.allLeaves = [m1, p1];
        app.workspace.rootLeaves = [m1];
        app.workspace.setActiveLeaf(m1);

        await plugin.cycleTabGroups();

        expect(app.workspace.activeLeaf).toBe(m1);
    });
});
