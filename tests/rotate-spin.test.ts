import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import NextTabGroupPlugin, { ringOrder, type Rect } from '../main.ts';
import { MockApp } from './mocks/obsidian';

interface Node {
    id?: string;
    direction?: 'vertical' | 'horizontal';
    children?: Node[];
}

const leaf = (id: string): Node => ({ id });
const split = (direction: 'vertical' | 'horizontal', ...children: Node[]): Node => ({ direction, children });

/** Lays a split tree out in a 120x120 box. 'vertical' puts children side by side, 'horizontal' stacks them. */
function layout(node: Node, box: Rect = { x: 0, y: 0, w: 120, h: 120 }, out: Record<string, Rect> = {}): Record<string, Rect> {
    if (!node.children) {
        out[node.id!] = box;
        return out;
    }
    const n = node.children.length;
    node.children.forEach((child, i) => {
        const r: Rect =
            node.direction === 'vertical'
                ? { x: box.x + (box.w / n) * i, y: box.y, w: box.w / n, h: box.h }
                : { x: box.x, y: box.y + (box.h / n) * i, w: box.w, h: box.h / n };
        layout(child, r, out);
    });
    return out;
}

const ring = (tree: Node): string[] => {
    const rects = layout(tree);
    return ringOrder(Object.keys(rects), (id) => rects[id], (a, b) => a.localeCompare(b));
};

/** The cycle written starting from `A`, so rotations of the same cycle compare equal. */
const cycle = (order: string[]): string[] => {
    const i = order.indexOf('A');
    return [...order.slice(i), ...order.slice(0, i)];
};

const plugin = () => new NextTabGroupPlugin(new MockApp() as unknown as App, { dir: '' } as never);
const snapshot = (tree: Node) => JSON.stringify(tree);

const trees: Array<[string, () => Node]> = [
    // Three or more collinear items have no true clockwise sense (the middle one sits
    // at the ring's center), so only two-item lines are checked for ring invariance.
    ['a row of two', () => split('vertical', leaf('A'), leaf('B'))],
    ['a column of two', () => split('horizontal', leaf('A'), leaf('B'))],
    ['A beside a stacked B/C', () => split('vertical', leaf('A'), split('horizontal', leaf('B'), leaf('C')))],
    ['2x2', () => split('horizontal', split('vertical', leaf('A'), leaf('B')), split('vertical', leaf('D'), leaf('C')))],
    [
        'three levels',
        () => split('vertical', split('horizontal', leaf('A'), leaf('B')), split('horizontal', leaf('C'), split('vertical', leaf('D'), leaf('E')))),
    ],
];

describe('rotateSplit spin', () => {
    for (const [name, make] of trees) {
        for (const spin of [1, -1] as const) {
            it(`${name}: the ring's cyclic order is unchanged by a spin ${spin} rotation`, () => {
                const tree = make();
                const before = cycle(ring(tree));
                plugin().rotateSplit(tree, undefined, spin);
                expect(cycle(ring(tree))).toEqual(before);
            });
        }

        it(`${name}: clockwise then counterclockwise restores the layout (and the reverse)`, () => {
            const tree = make();
            const original = snapshot(tree);
            plugin().rotateSplit(tree, undefined, 1);
            plugin().rotateSplit(tree, undefined, -1);
            expect(snapshot(tree)).toBe(original);
            plugin().rotateSplit(tree, undefined, -1);
            plugin().rotateSplit(tree, undefined, 1);
            expect(snapshot(tree)).toBe(original);
        });
    }

    it('clockwise and counterclockwise move a left/right pair in opposite directions', () => {
        const cw = split('vertical', leaf('A'), leaf('B'));
        plugin().rotateSplit(cw, undefined, 1);
        // A (left) swings to the top when rotating clockwise.
        expect(cw.direction).toBe('horizontal');
        expect(cw.children!.map((c) => c.id)).toEqual(['A', 'B']);
        const ccw = split('vertical', leaf('A'), leaf('B'));
        plugin().rotateSplit(ccw, undefined, -1);
        // Counterclockwise sends the left tab to the bottom.
        expect(ccw.children!.map((c) => c.id)).toEqual(['B', 'A']);
    });
});