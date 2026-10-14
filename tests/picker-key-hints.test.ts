import { describe, it, expect, beforeEach } from 'vitest';
import type { App } from 'obsidian';
import NextTabGroupPlugin, { neighborInTabStrip, cyclicNeighbor, clockwiseOrder, windowScreenCenter } from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
    MockFuzzySuggestModal,
} from './mocks/obsidian';

describe('cyclicNeighbor', () => {
    it('moves forward on +1 and backward on -1, wrapping at both ends', () => {
        const items = ['a', 'b', 'c'];
        expect(cyclicNeighbor(items, 'a', 1)).toBe('b');
        expect(cyclicNeighbor(items, 'c', 1)).toBe('a');
        expect(cyclicNeighbor(items, 'a', -1)).toBe('c');
        expect(cyclicNeighbor(items, 'b', -1)).toBe('a');
    });

    it('returns null when there is nowhere else to go', () => {
        expect(cyclicNeighbor(['a'], 'a', 1)).toBeNull();
        expect(cyclicNeighbor(['a', 'b'], 'zzz', 1)).toBeNull();
    });
});

describe('clockwiseOrder', () => {
    const win = (screenX: number, screenY: number, outerWidth: number, outerHeight: number) =>
        ({ screenX, screenY, outerWidth, outerHeight }) as unknown as Window;

    it('orders a top-left, bottom-left and right window clockwise: top-left, right, bottom-left', () => {
        const w1 = win(0, 0, 1000, 720);
        const w3 = win(0, 727, 1000, 600);
        const w2 = win(1000, 0, 1000, 1333);
        const ordered = clockwiseOrder([w1, w3, w2], windowScreenCenter)!;
        expect(ordered).toEqual([w1, w2, w3]);
        // Right arrow (+1) from the top-left window goes to the right window.
        expect(cyclicNeighbor(ordered, w1, 1)).toBe(w2);
        expect(cyclicNeighbor(ordered, w2, 1)).toBe(w3);
        expect(cyclicNeighbor(ordered, w1, -1)).toBe(w3);
    });

    it('orders a 2x2 grid TL, TR, BR, BL', () => {
        const pts: Record<string, { x: number; y: number }> = { tl: { x: 0, y: 0 }, tr: { x: 10, y: 0 }, bl: { x: 0, y: 10 }, br: { x: 10, y: 10 } };
        expect(clockwiseOrder(['bl', 'tr', 'tl', 'br'], (k) => pts[k])).toEqual(['tl', 'tr', 'br', 'bl']);
    });

    it('orders collinear layouts left-to-right', () => {
        const pts: Record<string, { x: number; y: number }> = { l: { x: 0, y: 0 }, m: { x: 5, y: 0 }, r: { x: 10, y: 0 } };
        const o = clockwiseOrder(['r', 'l', 'm'], (k) => pts[k])!;
        expect(cyclicNeighbor(o, 'l', 1)).toBe('m');
        expect(cyclicNeighbor(o, 'm', 1)).toBe('r');
        expect(cyclicNeighbor(o, 'r', 1)).toBe('l');
    });

    it('returns null when a position is unknown', () => {
        expect(clockwiseOrder([{}, win(0, 0, 1, 1)] as Window[], windowScreenCenter)).toBeNull();
    });
});

describe('neighborInTabStrip wraps', () => {
    it('wraps around the tab strip and skips tabs that are not picker items', () => {
        const parent = { children: [] as unknown[] };
        const mk = (id: string) => ({ id, parent });
        const [a, b, c] = [mk('a'), mk('b'), mk('c')];
        parent.children.push(a, b, c);
        const get = (l: { id: string }) => l as never;
        expect(neighborInTabStrip([a, b, c], get, c, 1)).toBe(a);
        expect(neighborInTabStrip([a, b, c], get, a, -1)).toBe(c);
        // b is not a picker item: from a, "right" skips to c
        expect(neighborInTabStrip([a, c], get, a, 1)).toBe(c);
        // single tab: nowhere to go
        expect(neighborInTabStrip([a], get, a, 1)).toBeNull();
    });
});

describe('picker footer key hints', () => {
    let app: MockApp;
    let plugin: NextTabGroupPlugin & Record<string, () => void>;
    let root: MockWorkspaceContainer;

    beforeEach(() => {
        app = new MockApp();
        root = new MockWorkspaceContainer('root', globalThis.window);
        plugin = new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as never;
    });

    function open(run: () => void): MockFuzzySuggestModal<unknown> & { instructions: Array<{ command: string; purpose: string }> } {
        let captured: unknown;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<unknown>) {
            captured = this;
            return originalOpen.call(this);
        };
        try {
            run();
        } finally {
            MockFuzzySuggestModal.prototype.open = originalOpen;
        }
        return captured as never;
    }

    function twoGroups() {
        const g1 = new MockWorkspaceParent(root);
        const g2 = new MockWorkspaceParent(root);
        const mk = (id: string, g: MockWorkspaceParent) => new MockWorkspaceLeaf(`${id}.md`).setId(id).setParent(g).setContainer(root);
        const g3 = new MockWorkspaceParent(root);
        const leaves = [mk('a', g1), mk('b', g1), mk('c', g2), mk('d', g3)];
        app.workspace.rootLeaves = leaves;
        app.workspace.allLeaves = leaves;
        app.workspace.setActiveLeaf(leaves[0]);
    }

    it('names the dimension of each key and hides Left/Right once the user types', () => {
        twoGroups();
        const modal = open(() => plugin['switchToAnyTab']());
        const cmds = () => modal.instructions.map((i) => i.command);
        expect(cmds()).toEqual(['↑↓', '←→', '↵', 'esc']);
        expect(modal.instructions.find((i) => i.command === '←→')?.purpose).toBe('neighbor tab');

        modal.inputEl.value = 'x';
        modal.inputEl.dispatchEvent(new Event('input'));
        expect(cmds()).toEqual(['↑↓', '↵', 'esc']);

        modal.inputEl.value = '';
        modal.inputEl.dispatchEvent(new Event('input'));
        expect(cmds()).toContain('←→');
    });

    it('labels Up/Down by what the list order really is', () => {
        twoGroups();
        plugin.settings.groupSwitchByContext = true;
        expect(open(() => plugin['switchToAnyTab']()).instructions[0].purpose).toBe('by group');
        plugin.settings.groupSwitchByContext = false;
        expect(open(() => plugin['switchToAnyTab']()).instructions[0].purpose).toBe('recent');
    });

    it('offers Left/Right in the tab group picker', () => {
        twoGroups();
        const modal = open(() => plugin['switchToTabGroup']());
        expect(modal.instructions.find((i) => i.command === '←→')?.purpose).toBe('neighbor group');
    });

    it('omits Left/Right when the setting is off', () => {
        twoGroups();
        plugin.settings.switchLeftRightNavigation = false;
        const modal = open(() => plugin['switchToAnyTab']());
        expect(modal.instructions.map((i) => i.command)).toEqual(['↑↓', '↵', 'esc']);
    });
});
