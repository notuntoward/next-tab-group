import { describe, it, expect, vi } from 'vitest';

interface MockSplitNode {
    direction?: 'vertical' | 'horizontal';
    children?: MockSplitNode[];
    containerEl?: {
        ownerDocument?: { defaultView?: Window };
        classList: { remove: (cls: string) => void; add: (cls: string) => void };
        appendChild: (el: any) => void;
        children: any[];
    };
}

function rotateSplitClockwise(node: any): void {
    if (!node || !node.children || !node.direction) return;

    for (const child of node.children) {
        rotateSplitClockwise(child);
    }

    const oldDirection = node.direction;
    const newDirection = oldDirection === 'vertical' ? 'horizontal' : 'vertical';

    node.direction = newDirection;
    if (node.containerEl) {
        node.containerEl.classList.remove(`mod-${oldDirection}`);
        node.containerEl.classList.add(`mod-${newDirection}`);
    }

    // Emacs-style clockwise rotation is asymmetric: only vertical->horizontal
    // reverses child order (Bottom swings to the Left). horizontal->vertical
    // keeps Left as Top / Right as Bottom.
    if (oldDirection === 'vertical' && newDirection === 'horizontal') {
        node.children.reverse();
    }

    if (node.containerEl) {
        for (const child of node.children) {
            if (child.containerEl) {
                node.containerEl.appendChild(child.containerEl);
            }
        }
    }
}

describe('rotateSplitClockwise Tree Rotation', () => {
    it('transposes vertical->horizontal (reversing) then horizontal->vertical (no reverse)', () => {
        const root: MockSplitNode = {
            direction: 'vertical',
            children: [
                { id: 'LeafA' },
                { id: 'LeafB' },
            ],
            containerEl: {
                classList: { remove: vi.fn(), add: vi.fn() },
                appendChild: vi.fn(),
                children: [],
            },
        };

        // vertical -> horizontal: Bottom swings to Left => [B, A]
        rotateSplitClockwise(root);
        expect(root.direction).toBe('horizontal');
        expect((root.children![0] as any).id).toBe('LeafB');
        expect((root.children![1] as any).id).toBe('LeafA');

        // horizontal -> vertical: Left stays Top, Right stays Bottom => [B, A] unchanged
        rotateSplitClockwise(root);
        expect(root.direction).toBe('vertical');
        expect((root.children![0] as any).id).toBe('LeafB');
        expect((root.children![1] as any).id).toBe('LeafA');

        // vertical -> horizontal: reverse again => [A, B]
        rotateSplitClockwise(root);
        expect(root.direction).toBe('horizontal');
        expect((root.children![0] as any).id).toBe('LeafA');
        expect((root.children![1] as any).id).toBe('LeafB');
    });

    it('correctly rotates asymmetric nested split structures', () => {
        const tree: MockSplitNode = {
            direction: 'vertical',
            children: [
                { id: 'LeafA' },
                {
                    direction: 'horizontal',
                    children: [{ id: 'LeafB' }, { id: 'LeafC' }],
                    containerEl: { classList: { remove: vi.fn(), add: vi.fn() }, appendChild: vi.fn(), children: [] },
                },
            ],
            containerEl: { classList: { remove: vi.fn(), add: vi.fn() }, appendChild: vi.fn(), children: [] },
        };

        rotateSplitClockwise(tree);

        // root vertical -> horizontal, children reversed: sub-split is now first,
        // LeafA (was first) is now last.
        expect(tree.direction).toBe('horizontal');
        expect(tree.children![1]).toHaveProperty('id', 'LeafA');
        expect(tree.children![0]).toHaveProperty('direction', 'vertical');

        // Sub-split was horizontal -> vertical. Left stays Top, Right stays Bottom,
        // so order is preserved [B, C].
        const subSplit = tree.children![0] as MockSplitNode;
        expect((subSplit.children![0] as any).id).toBe('LeafB');
        expect((subSplit.children![1] as any).id).toBe('LeafC');
    });
});
