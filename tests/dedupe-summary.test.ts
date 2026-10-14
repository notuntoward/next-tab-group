import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import { MockApp, MockWorkspaceContainer, MockWorkspaceLeaf, MockWorkspaceParent } from './mocks/obsidian';

type TestPlugin = NextTabGroupPlugin & {
    dedupeEmptied: (toRemove: WorkspaceLeaf[]) => { groups: number; windows: number };
    dedupeSummary: (
        scopes: unknown[],
        chosen: Array<{ id: string }>,
        activeLeaf: WorkspaceLeaf | null,
        checkedIds?: string[],
    ) => string;
};

describe('dedupe summary: tab groups and windows that close', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let mainWin: Window;
    let mainC: MockWorkspaceContainer;
    let popC: MockWorkspaceContainer;

    const leaf = (id: string, parent: MockWorkspaceParent, c: MockWorkspaceContainer) =>
        new MockWorkspaceLeaf(`${id}.md`).setId(id).setParent(parent).setContainer(c);
    const asL = (...l: MockWorkspaceLeaf[]) => l as unknown as WorkspaceLeaf[];

    beforeEach(() => {
        app = new MockApp();
        mainWin = {} as Window;
        (app.workspace as unknown as { rootSplit: { win: Window } }).rootSplit = { win: mainWin } as never;
        mainC = new MockWorkspaceContainer('root', mainWin);
        popC = new MockWorkspaceContainer('window', {} as Window);
        plugin = new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
    });

    it('counts a group emptied by the removal, but not one that keeps a tab', () => {
        const g1 = new MockWorkspaceParent(mainC);
        const g2 = new MockWorkspaceParent(mainC);
        const a = leaf('a', g1, mainC);
        const b = leaf('b', g1, mainC);
        const c = leaf('c', g2, mainC);
        app.workspace.allLeaves = [a, b, c];
        expect(plugin.dedupeEmptied(asL(b))).toEqual({ groups: 0, windows: 0 });
        expect(plugin.dedupeEmptied(asL(c))).toEqual({ groups: 1, windows: 0 });
    });

    it('counts a pop-out whose every group empties, but never the main window', () => {
        const g1 = new MockWorkspaceParent(mainC);
        const p1 = new MockWorkspaceParent(popC);
        const p2 = new MockWorkspaceParent(popC);
        const a = leaf('a', g1, mainC);
        const x = leaf('x', p1, popC);
        const y = leaf('y', p2, popC);
        app.workspace.allLeaves = [a, x, y];
        // One of two pop-out groups empties: the window stays open.
        expect(plugin.dedupeEmptied(asL(x))).toEqual({ groups: 1, windows: 0 });
        // Both empty: the pop-out closes too.
        expect(plugin.dedupeEmptied(asL(x, y))).toEqual({ groups: 2, windows: 1 });
        // Emptying the main window's only group never counts as closing it.
        expect(plugin.dedupeEmptied(asL(a))).toEqual({ groups: 1, windows: 0 });
    });

    it('mentions groups and windows only when their count is nonzero', () => {
        const g1 = new MockWorkspaceParent(mainC);
        const p1 = new MockWorkspaceParent(popC);
        const a = leaf('a', g1, mainC);
        const dup = new MockWorkspaceLeaf('a.md').setId('d').setParent(p1).setContainer(popC);
        const keepish = leaf('k', g1, mainC);
        app.workspace.allLeaves = [a, dup, keepish];
        app.workspace.setActiveLeaf(a);
        const scope = { id: 'all', kind: 'all', label: 'Across all windows', leaves: [a, dup, keepish], removeCount: 1 };
        const text = plugin.dedupeSummary([scope], [{ id: 'all' }], a as unknown as WorkspaceLeaf);
        expect(text).toBe('Enter closes 1 tab, 1 tab group, 1 window');

        const dup2 = new MockWorkspaceLeaf('a.md').setId('e').setParent(g1).setContainer(mainC);
        app.workspace.allLeaves = [a, dup2, keepish];
        const scope2 = { id: 'all', kind: 'all', label: 'Across all windows', leaves: [a, dup2, keepish], removeCount: 1 };
        expect(plugin.dedupeSummary([scope2], [{ id: 'all' }], a as unknown as WorkspaceLeaf)).toBe(
            'Enter closes 1 tab',
        );
    });});