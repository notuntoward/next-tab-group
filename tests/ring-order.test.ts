import { describe, it, expect } from 'vitest';
import { ringOrder, windowScreenRect, cyclicNeighbor, type Rect } from '../main.ts';

const byName = (a: string, b: string) => a.localeCompare(b);
const order = (rects: Record<string, Rect>, names = Object.keys(rects).reverse()) =>
    ringOrder(names, (n) => rects[n], byName);
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe('ringOrder', () => {
    it('orders a 2x2 grid clockwise: TL, TR, BR, BL', () => {
        const rects = { tl: r(0, 0, 10, 10), tr: r(10, 0, 10, 10), bl: r(0, 10, 10, 10), br: r(10, 10, 10, 10) };
        expect(order(rects)).toEqual(['tl', 'tr', 'br', 'bl']);
    });

    it('orders left/middle/right as a cycle l -> m -> r', () => {
        const rects = { l: r(0, 0, 10, 20), m: r(10, 0, 10, 20), r: r(20, 0, 10, 20) };
        const o = order(rects);
        expect(cyclicNeighbor(o, 'l', 1)).toBe('m');
        expect(cyclicNeighbor(o, 'm', 1)).toBe('r');
        expect(cyclicNeighbor(o, 'r', 1)).toBe('l');
        expect(cyclicNeighbor(o, 'l', -1)).toBe('r');
    });

    it('orders a column top -> middle -> bottom as a cycle', () => {
        const rects = { t: r(0, 0, 20, 10), m: r(0, 10, 20, 10), b: r(0, 20, 20, 10) };
        const o = order(rects);
        expect(cyclicNeighbor(o, 't', 1)).toBe('m');
        expect(cyclicNeighbor(o, 'm', 1)).toBe('b');
        expect(cyclicNeighbor(o, 'b', 1)).toBe('t');
    });

    it('puts edge-touching items first, then interior items (clockwise spiral)', () => {
        const rects = {
            tl: r(0, 0, 10, 10), tr: r(20, 0, 10, 10), bl: r(0, 20, 10, 10), br: r(20, 20, 10, 10),
            mid: r(10, 10, 10, 10),
        };
        expect(order(rects)).toEqual(['tl', 'tr', 'br', 'bl', 'mid']);
    });

    it('orders the three-window screenshot layout TL, right, BL', () => {
        const w1 = r(0, 0, 1000, 720);
        const w3 = r(0, 727, 1000, 600);
        const w2 = r(1000, 0, 1000, 1333);
        const o = ringOrder(['w3', 'w2', 'w1'], (n) => ({ w1, w2, w3 })[n as 'w1'], byName);
        expect(o).toEqual(['w1', 'w2', 'w3']);
        expect(cyclicNeighbor(o, 'w1', 1)).toBe('w2');
        expect(cyclicNeighbor(o, 'w1', -1)).toBe('w3');
    });

    it('falls back to the stable order when windows overlap heavily', () => {
        const rects = { b: r(0, 0, 100, 100), a: r(5, 5, 100, 100), c: r(300, 0, 100, 100) };
        expect(order(rects)).toEqual(['a', 'b', 'c']);
    });

    it('falls back to the stable order when a rectangle is unknown', () => {
        expect(ringOrder(['b', 'a'], (n) => (n === 'a' ? r(0, 0, 1, 1) : null), byName)).toEqual(['a', 'b']);
    });

    it('reads window screen rectangles', () => {
        expect(windowScreenRect({ screenX: 1, screenY: 2, outerWidth: 3, outerHeight: 4 } as unknown as Window)).toEqual(r(1, 2, 3, 4));
        expect(windowScreenRect({} as Window)).toBeNull();
        expect(windowScreenRect(undefined)).toBeNull();
    });
});