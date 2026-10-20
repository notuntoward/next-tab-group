import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    getLeafLastActive: (leaf: WorkspaceLeaf) => number;
    pickMostRecent: (leaves: WorkspaceLeaf[]) => WorkspaceLeaf;
    sortByRecency: <T>(items: T[], getRecency: (item: T) => number, tiebreak?: (a: T, b: T) => number) => T[];
    firstNonActiveIndex: <T>(items: T[], isActive: (item: T) => boolean, recency: (item: T) => number) => number;
};

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

function leaf(
    id: string,
    parent: MockWorkspaceParent,
    container: MockWorkspaceContainer | null = null
): MockWorkspaceLeaf {
    const l = new MockWorkspaceLeaf('Note.md').setId(id).setParent(parent);
    if (container) l.setContainer(container);
    return l;
}

function asLeaf(leaf: MockWorkspaceLeaf): WorkspaceLeaf {
    return leaf as unknown as WorkspaceLeaf;
}

describe('recency helpers', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;
    let group: MockWorkspaceParent;

    beforeEach(() => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', {} as Window);
        group = new MockWorkspaceParent(container);
        plugin = createPlugin(app);
    });

    describe('getLeafLastActive', () => {
        it('returns the recorded timestamp for a leaf', () => {
            const a = leaf('a', group, container);
            setLastActive(plugin, 'a', 1000);
            expect(plugin.getLeafLastActive(asLeaf(a))).toBe(1000);
        });

        it('returns 0 for a leaf with no recorded timestamp', () => {
            const a = leaf('a', group, container);
            expect(plugin.getLeafLastActive(asLeaf(a))).toBe(0);
        });
    });

    describe('pickMostRecent', () => {
        it('returns the newest leaf', () => {
            const older = leaf('older', group, container);
            const newer = leaf('newer', group, container);
            setLastActive(plugin, 'older', 100);
            setLastActive(plugin, 'newer', 200);

            expect(plugin.pickMostRecent([asLeaf(older), asLeaf(newer)])).toBe(asLeaf(newer));
        });

        it('returns the only leaf when given a single element', () => {
            const only = leaf('only', group, container);
            expect(plugin.pickMostRecent([asLeaf(only)])).toBe(asLeaf(only));
        });

        it('falls back to leaf ID when timestamps are equal', () => {
            const a = leaf('a', group, container);
            const b = leaf('b', group, container);
            setLastActive(plugin, 'a', 100);
            setLastActive(plugin, 'b', 100);

            expect(plugin.pickMostRecent([asLeaf(a), asLeaf(b)])).toBe(asLeaf(b));
        });
    });
});
