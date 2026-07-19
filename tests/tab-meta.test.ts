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
    getTabSearchText: (tab: TabInfo) => string;
    getTabGroupMeta: (tab: TabInfo) => string;
};

interface TabGroupInfo {
    group: MockWorkspaceParent;
    leaves: WorkspaceLeaf[];
    representative: WorkspaceLeaf;
    lastActive: number;
    label: string;
    relativeLabel: string | null;
    isCurrentGroup: boolean;
    window: Window | undefined;
}

interface TabInfo {
    leaf: WorkspaceLeaf;
    group: TabGroupInfo;
    lastActive: number;
}

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

function makeGroup(
    container: MockWorkspaceContainer,
    opts: {
        leaves: MockWorkspaceLeaf[];
        isCurrentGroup: boolean;
        relativeLabel: string | null;
        representative?: MockWorkspaceLeaf;
    },
): TabGroupInfo {
    const group = new MockWorkspaceParent(container);
    for (const leaf of opts.leaves) leaf.setParent(group);
    return {
        group,
        leaves: opts.leaves,
        representative: opts.representative ?? opts.leaves[0],
        lastActive: 0,
        label: `${opts.isCurrentGroup ? 'Current group — ' : ''}Representative · ${opts.leaves.length} tabs`,
        relativeLabel: opts.relativeLabel,
        isCurrentGroup: opts.isCurrentGroup,
        window: container.win,
    };
}

describe('getTabGroupMeta', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;

    beforeEach(() => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', {} as Window);
        plugin = createPlugin(app);
    });

    it('formats the current group with a plural count', () => {
        const leaves = [
            new MockWorkspaceLeaf('A.md').setId('a'),
            new MockWorkspaceLeaf('B.md').setId('b'),
            new MockWorkspaceLeaf('C.md').setId('c'),
            new MockWorkspaceLeaf('D.md').setId('d'),
        ];
        const group = makeGroup(container, { leaves, isCurrentGroup: true, relativeLabel: null });
        const tab: TabInfo = { leaf: leaves[0] as unknown as WorkspaceLeaf, group, lastActive: 0 };

        expect(plugin.getTabGroupMeta(tab)).toBe("Current group · 4 tabs");
    });

    it('formats a relative group with a singular count', () => {
        const leaf = new MockWorkspaceLeaf('Only.md').setId('only');
        const group = makeGroup(container, { leaves: [leaf], isCurrentGroup: false, relativeLabel: 'Right group' });
        const tab: TabInfo = { leaf: leaf as unknown as WorkspaceLeaf, group, lastActive: 0 };

        expect(plugin.getTabGroupMeta(tab)).toBe("Right group · 1 tab");
    });

    it('formats a relative group below with a plural count', () => {
        const leaves = [
            new MockWorkspaceLeaf('A.md').setId('a'),
            new MockWorkspaceLeaf('B.md').setId('b'),
            new MockWorkspaceLeaf('C.md').setId('c'),
        ];
        const group = makeGroup(container, { leaves, isCurrentGroup: false, relativeLabel: 'Group below' });
        const tab: TabInfo = { leaf: leaves[0] as unknown as WorkspaceLeaf, group, lastActive: 0 };

        expect(plugin.getTabGroupMeta(tab)).toBe("Group below · 3 tabs");
    });

    it('falls back to Other group when no relative label exists', () => {
        const leaves = [
            new MockWorkspaceLeaf('A.md').setId('a'),
            new MockWorkspaceLeaf('B.md').setId('b'),
        ];
        const group = makeGroup(container, { leaves, isCurrentGroup: false, relativeLabel: null });
        const tab: TabInfo = { leaf: leaves[0] as unknown as WorkspaceLeaf, group, lastActive: 0 };

        expect(plugin.getTabGroupMeta(tab)).toBe("Other group · 2 tabs");
    });

    it('does not include the representative tab title in the metadata', () => {
        const leaves = [
            new MockWorkspaceLeaf('Representative.md').setId('rep'),
            new MockWorkspaceLeaf('Other.md').setId('other'),
        ];
        const group = makeGroup(container, {
            leaves,
            isCurrentGroup: false,
            relativeLabel: 'Left group',
            representative: leaves[0],
        });
        const tab: TabInfo = { leaf: leaves[1] as unknown as WorkspaceLeaf, group, lastActive: 0 };

        const meta = plugin.getTabGroupMeta(tab);
        expect(meta).not.toContain('Representative.md');
        expect(meta).toBe("Left group · 2 tabs");
    });
});

describe('getTabSearchText still includes the group label', () => {
    let app: MockApp;
    let plugin: TestPlugin;

    beforeEach(() => {
        app = new MockApp();
        plugin = createPlugin(app);
        plugin.leafLastActive.set('a', 100);
        plugin.leafLastActive.set('b', 200);
    });

    it('contains both the tab title and the full group label', () => {
        const container = new MockWorkspaceContainer('root', {} as Window);
        const leaves = [
            new MockWorkspaceLeaf('A.md').setId('a'),
            new MockWorkspaceLeaf('B.md').setId('b'),
        ];
        const group = makeGroup(container, { leaves, isCurrentGroup: true, relativeLabel: null });
        const tab: TabInfo = { leaf: leaves[0] as unknown as WorkspaceLeaf, group, lastActive: 0 };

        const text = plugin.getTabSearchText(tab);
        expect(text).toContain('A.md');
        expect(text).toContain(group.label);
        expect(text).toContain('Representative');
    });
});
