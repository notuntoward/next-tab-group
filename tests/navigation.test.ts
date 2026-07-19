import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { App, WorkspaceLeaf, WorkspaceParent } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
} from './mocks/obsidian';

type TestPlugin = NextTabGroupPlugin & {
    getLeafLastActive: (leaf: WorkspaceLeaf) => number;
    compareRecency: (a: WorkspaceLeaf, b: WorkspaceLeaf) => number;
    pickMostRecent: (leaves: WorkspaceLeaf[]) => WorkspaceLeaf;
    leafLastActive: Map<string, number>;
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
            plugin.leafLastActive.set('a', 1000);
            expect(plugin.getLeafLastActive(asLeaf(a))).toBe(1000);
        });

        it('returns 0 for a leaf with no recorded timestamp', () => {
            const a = leaf('a', group, container);
            expect(plugin.getLeafLastActive(asLeaf(a))).toBe(0);
        });
    });

    describe('compareRecency', () => {
        it('orders older leaves before newer leaves', () => {
            const older = leaf('older', group, container);
            const newer = leaf('newer', group, container);
            plugin.leafLastActive.set('older', 100);
            plugin.leafLastActive.set('newer', 200);

            expect(plugin.compareRecency(asLeaf(older), asLeaf(newer))).toBeLessThan(0);
        });

        it('reverse comparator gives newest leaf first', () => {
            const older = leaf('older', group, container);
            const newer = leaf('newer', group, container);
            plugin.leafLastActive.set('older', 100);
            plugin.leafLastActive.set('newer', 200);

            expect(plugin.compareRecency(asLeaf(newer), asLeaf(older))).toBeGreaterThan(0);
        });

        it('ties use leaf ID consistently', () => {
            const a = leaf('a', group, container);
            const b = leaf('b', group, container);
            plugin.leafLastActive.set('a', 100);
            plugin.leafLastActive.set('b', 100);

            expect(plugin.compareRecency(asLeaf(a), asLeaf(b))).toBeLessThan(0);
            expect(plugin.compareRecency(asLeaf(b), asLeaf(a))).toBeGreaterThan(0);
        });

        it('returns 0 for the same leaf', () => {
            const a = leaf('a', group, container);
            plugin.leafLastActive.set('a', 100);

            expect(plugin.compareRecency(asLeaf(a), asLeaf(a))).toBe(0);
        });
    });

    describe('pickMostRecent', () => {
        it('returns the newest leaf', () => {
            const older = leaf('older', group, container);
            const newer = leaf('newer', group, container);
            plugin.leafLastActive.set('older', 100);
            plugin.leafLastActive.set('newer', 200);

            expect(plugin.pickMostRecent([asLeaf(older), asLeaf(newer)])).toBe(asLeaf(newer));
        });

        it('returns the only leaf when given a single element', () => {
            const only = leaf('only', group, container);
            expect(plugin.pickMostRecent([asLeaf(only)])).toBe(asLeaf(only));
        });

        it('falls back to leaf ID when timestamps are equal', () => {
            const a = leaf('a', group, container);
            const b = leaf('b', group, container);
            plugin.leafLastActive.set('a', 100);
            plugin.leafLastActive.set('b', 100);

            expect(plugin.pickMostRecent([asLeaf(a), asLeaf(b)])).toBe(asLeaf(b));
        });
    });
});
