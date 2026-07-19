import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf, WorkspaceParent } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
} from './mocks/obsidian';

type TestPlugin = NextTabGroupPlugin & {
    buildTabGroupInfos: (leaves: WorkspaceLeaf[], activeLeaf: WorkspaceLeaf | null) => TabGroupInfo[];
    buildTabInfos: (groups: TabGroupInfo[]) => TabInfo[];
    getTabSearchText: (tab: TabInfo) => string;
    formatTabGroupLabel: (
        representative: WorkspaceLeaf,
        leafCount: number,
        isCurrentGroup: boolean,
        relativeLabel: string | null,
    ) => string;
    capitalizeFirst: (value: string) => string;
    leafLastActive: Map<string, number>;
};

interface TabGroupInfo {
    group: WorkspaceParent;
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

function asLeaf(leaf: MockWorkspaceLeaf): WorkspaceLeaf {
    return leaf as unknown as WorkspaceLeaf;
}

describe('group construction', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;
    let group1: MockWorkspaceParent;
    let group2: MockWorkspaceParent;

    beforeEach(() => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', {} as Window);
        group1 = new MockWorkspaceParent(container);
        group2 = new MockWorkspaceParent(container);
        plugin = createPlugin(app);
    });

    describe('buildTabGroupInfos', () => {
        it('leaves with the same parent produce one TabGroupInfo', () => {
            const a = leaf('a', 'A.md', group1, container);
            const b = leaf('b', 'B.md', group1, container);
            const c = leaf('c', 'C.md', group1, container);

            const infos = plugin.buildTabGroupInfos(
                [asLeaf(a), asLeaf(b), asLeaf(c)],
                null,
            );
            expect(infos).toHaveLength(1);
            expect(infos[0].leaves.map((l) => (l as unknown as MockWorkspaceLeaf).id)).toEqual(['a', 'b', 'c']);
        });

        it('separate parents produce separate group records', () => {
            const a = leaf('a', 'A.md', group1, container);
            const b = leaf('b', 'B.md', group2, container);

            const infos = plugin.buildTabGroupInfos(
                [asLeaf(a), asLeaf(b)],
                null,
            );
            expect(infos).toHaveLength(2);
        });

        it('representative is the most-recent leaf', () => {
            const older = leaf('older', 'Old.md', group1, container);
            const newer = leaf('newer', 'New.md', group1, container);
            plugin.leafLastActive.set('older', 100);
            plugin.leafLastActive.set('newer', 200);

            const infos = plugin.buildTabGroupInfos(
                [asLeaf(older), asLeaf(newer)],
                null,
            );
            expect(infos[0].representative).toBe(asLeaf(newer));
        });

        it('groups are newest-first', () => {
            const a1 = leaf('a1', 'A.md', group1, container);
            const a2 = leaf('a2', 'A2.md', group1, container);
            const b1 = leaf('b1', 'B.md', group2, container);
            const b2 = leaf('b2', 'B2.md', group2, container);
            plugin.leafLastActive.set('a1', 100);
            plugin.leafLastActive.set('a2', 200);
            plugin.leafLastActive.set('b1', 300);
            plugin.leafLastActive.set('b2', 400);

            const infos = plugin.buildTabGroupInfos(
                [asLeaf(a1), asLeaf(a2), asLeaf(b1), asLeaf(b2)],
                null,
            );
            expect(infos[0].group).toBe(group2);
            expect(infos[1].group).toBe(group1);
        });

        it('Current group label appears only on the active group', () => {
            const a = leaf('a', 'A.md', group1, container);
            const b = leaf('b', 'B.md', group2, container);
            plugin.leafLastActive.set('a', 100);
            plugin.leafLastActive.set('b', 200);

            app.workspace.setActiveLeaf(a);

            const infos = plugin.buildTabGroupInfos(
                [asLeaf(a), asLeaf(b)],
                asLeaf(a),
            );
            const labels = infos.map((i) => i.label);
            expect(labels.some((l) => l.startsWith('Current group'))).toBe(true);
            expect(labels.filter((l) => l.startsWith('Current group'))).toHaveLength(1);
        });

        it('singular and plural labels read 1 tab and N tabs', () => {
            const single = leaf('single', 'Single.md', group1, container);
            const multi1 = leaf('m1', 'M1.md', group2, container);
            const multi2 = leaf('m2', 'M2.md', group2, container);

            const infos = plugin.buildTabGroupInfos(
                [asLeaf(single), asLeaf(multi1), asLeaf(multi2)],
                null,
            );
            const singleLabel = infos.find((i) => i.group === group1)!.label;
            const multiLabel = infos.find((i) => i.group === group2)!.label;
            expect(singleLabel).toContain('1 tab');
            expect(multiLabel).toContain('2 tabs');
        });

        it('if relative position is unavailable, label remains useful without location text', () => {
            const a = leaf('a', 'A.md', group1, container);
            const b = leaf('b', 'B.md', group2, container);
            plugin.leafLastActive.set('a', 100);
            plugin.leafLastActive.set('b', 200);

            app.workspace.setActiveLeaf(a);

            // Make group2's containerEl fail the instanceOf check so
            // getTabGroupRect returns null and no relative label is produced.
            (group2 as unknown as { containerEl: { instanceOf: (ctor: unknown) => boolean } }).containerEl = {
                instanceOf: () => false,
            } as unknown as HTMLElement;

            const infos = plugin.buildTabGroupInfos(
                [asLeaf(a), asLeaf(b)],
                asLeaf(a),
            );
            const bInfo = infos.find((i) => i.group === group2)!;
            expect(bInfo.relativeLabel).toBeNull();
            expect(bInfo.label).not.toContain('—');
            expect(bInfo.label).toContain('B.md');
        });

        it('equal timestamps sort stably by label', () => {
            const a = leaf('a', 'A.md', group1, container);
            const b = leaf('b', 'B.md', group2, container);
            plugin.leafLastActive.set('a', 100);
            plugin.leafLastActive.set('b', 100);

            const infos = plugin.buildTabGroupInfos(
                [asLeaf(a), asLeaf(b)],
                null,
            );
            expect(infos[0].label.localeCompare(infos[1].label)).toBeLessThan(0);
        });
    });

    describe('buildTabInfos', () => {
        it('tabs sort newest-first across groups', () => {
            const a1 = leaf('a1', 'A.md', group1, container);
            const a2 = leaf('a2', 'A2.md', group1, container);
            const b1 = leaf('b1', 'B.md', group2, container);
            plugin.leafLastActive.set('a1', 100);
            plugin.leafLastActive.set('a2', 200);
            plugin.leafLastActive.set('b1', 300);

            const groups = plugin.buildTabGroupInfos(
                [asLeaf(a1), asLeaf(a2), asLeaf(b1)],
                null,
            );
            const tabs = plugin.buildTabInfos(groups);
            expect(tabs[0].leaf).toBe(asLeaf(b1));
            expect(tabs[1].leaf).toBe(asLeaf(a2));
            expect(tabs[2].leaf).toBe(asLeaf(a1));
        });

        it('each TabInfo references its correct TabGroupInfo', () => {
            const a = leaf('a', 'A.md', group1, container);
            const b = leaf('b', 'B.md', group2, container);

            const groups = plugin.buildTabGroupInfos(
                [asLeaf(a), asLeaf(b)],
                null,
            );
            const tabs = plugin.buildTabInfos(groups);

            const tabA = tabs.find((t) => (t.leaf as unknown as MockWorkspaceLeaf).id === 'a')!;
            const tabB = tabs.find((t) => (t.leaf as unknown as MockWorkspaceLeaf).id === 'b')!;
            expect(tabA.group.group).toBe(group1);
            expect(tabB.group.group).toBe(group2);
        });
    });

    describe('getTabSearchText', () => {
        it('includes both tab title and group label', () => {
            const a = leaf('a', 'A.md', group1, container);
            const b = leaf('b', 'B.md', group2, container);
            plugin.leafLastActive.set('a', 100);
            plugin.leafLastActive.set('b', 200);

            const groups = plugin.buildTabGroupInfos(
                [asLeaf(a), asLeaf(b)],
                null,
            );
            const tabs = plugin.buildTabInfos(groups);
            const text = plugin.getTabSearchText(tabs[0]);
            expect(text).toContain('B.md');
            expect(text).toContain(groups[0].label);
        });
    });

    describe('formatTabGroupLabel', () => {
        it('uses Current group prefix for active group', () => {
            const label = plugin.formatTabGroupLabel(asLeaf(leaf('a', 'A.md', group1, container)), 3, true, null);
            expect(label).toBe('Current group — A.md · 3 tabs');
        });

        it('uses relative label for non-active group', () => {
            const label = plugin.formatTabGroupLabel(asLeaf(leaf('a', 'A.md', group1, container)), 3, false, 'Right group');
            expect(label).toBe('Right group — A.md · 3 tabs');
        });

        it('omits location prefix when relativeLabel is null', () => {
            const label = plugin.formatTabGroupLabel(asLeaf(leaf('a', 'A.md', group1, container)), 3, false, null);
            expect(label).toBe('A.md · 3 tabs');
        });

        it('handles singular tab count', () => {
            const label = plugin.formatTabGroupLabel(asLeaf(leaf('a', 'A.md', group1, container)), 1, false, null);
            expect(label).toBe('A.md · 1 tab');
        });
    });

    describe('capitalizeFirst', () => {
        it('capitalizes the first character', () => {
            expect(plugin.capitalizeFirst('right group')).toBe('Right group');
        });

        it('returns empty string unchanged', () => {
            expect(plugin.capitalizeFirst('')).toBe('');
        });
    });
});
