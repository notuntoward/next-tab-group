import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf, WorkspaceParent } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
} from './mocks/obsidian';
import { setLastActive } from './helpers/recency';

type TestPlugin = NextTabGroupPlugin & {
    buildTabGroupInfos: (locations: LeafLocation[], activeLeaf: WorkspaceLeaf | null) => TabGroupInfo[];
    buildTabInfos: (groups: TabGroupInfo[]) => TabInfo[];
    getEditorLeafLocations: () => LeafLocation[];
    getTabSearchText: (tab: TabInfo) => string;
    formatTabGroupLabel: (
        representative: WorkspaceLeaf,
        leafCount: number,
        isCurrentGroup: boolean,
        relativeLabel: string | null,
    ) => string;
    capitalizeFirst: (value: string) => string;
};

interface LeafLocation {
    leaf: WorkspaceLeaf;
    window: Window | undefined;
    group: WorkspaceParent | null;
}

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

function loc(leaf: MockWorkspaceLeaf): LeafLocation {
    const container = leaf.getContainer() as unknown as { win?: Window } | null;
    return {
        leaf: leaf as unknown as WorkspaceLeaf,
        window: container?.win,
        group: (leaf.parent as MockWorkspaceParent) ?? null,
    };
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
        it('Current group label appears only on the active group', () => {
            const a = leaf('a', 'A.md', group1, container);
            const b = leaf('b', 'B.md', group2, container);
            setLastActive(plugin, 'a', 100);
            setLastActive(plugin, 'b', 200);

            app.workspace.setActiveLeaf(a);

            const infos = plugin.buildTabGroupInfos(
                [loc(a), loc(b)],
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
                [loc(single), loc(multi1), loc(multi2)],
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
            setLastActive(plugin, 'a', 100);
            setLastActive(plugin, 'b', 200);

            app.workspace.setActiveLeaf(a);

            // Make group2's containerEl fail the instanceOf check so
            // the group rectangle is unknown and no relative label is produced.
            (group2 as unknown as { containerEl: { instanceOf: (ctor: unknown) => boolean } }).containerEl = {
                instanceOf: () => false,
            } as unknown as HTMLElement;

            const infos = plugin.buildTabGroupInfos(
                [loc(a), loc(b)],
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
            setLastActive(plugin, 'a', 100);
            setLastActive(plugin, 'b', 100);

            const infos = plugin.buildTabGroupInfos(
                [loc(a), loc(b)],
                null,
            );
            expect(infos[0].label.localeCompare(infos[1].label)).toBeLessThan(0);
        });
    });

    describe('getTabSearchText', () => {
        it('includes both tab title and group label', () => {
            const a = leaf('a', 'A.md', group1, container);
            const b = leaf('b', 'B.md', group2, container);
            setLastActive(plugin, 'a', 100);
            setLastActive(plugin, 'b', 200);

            const groups = plugin.buildTabGroupInfos(
                [loc(a), loc(b)],
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
