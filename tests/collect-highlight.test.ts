import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import { MockApp } from './mocks/obsidian';

type P = {
    collectHighlightTargets: (chosen: unknown[], cur: unknown, all: unknown[]) => Array<{ el: HTMLElement; cls: string }>;
    settings: Record<string, boolean>;
};

function win(): { representative: unknown; groups: Array<{ group: { containerEl: HTMLElement } }>; frame: HTMLElement; groupEl: HTMLElement } {
    const frame = document.createElement('div');
    const groupEl = document.createElement('div');
    return {
        frame,
        groupEl,
        representative: { getContainer: () => ({ containerEl: frame }) },
        groups: [{ group: { containerEl: groupEl } }],
    };
}

describe('collect tabs highlight targets', () => {
    const plugin = new NextTabGroupPlugin(new MockApp() as unknown as App, { dir: '' } as never) as unknown as P;

    it('marks the windows and groups of the checked rows only', () => {
        const a = win();
        const b = win();
        const t = plugin.collectHighlightTargets([{ kind: 'current', winInfo: a }], a, [a, b]);
        expect(t.map((x) => x.el)).toEqual([a.frame, a.groupEl]);
    });

    it('a single other-window row includes the window the command was opened from', () => {
        const a = win();
        const b = win();
        const t = plugin.collectHighlightTargets([{ kind: 'window', winInfo: b }], a, [a, b]);
        expect(t.map((x) => x.el)).toEqual([a.frame, a.groupEl, b.frame, b.groupEl]);
    });

    it('All windows marks every window, and the settings turn each part off', () => {
        const a = win();
        const b = win();
        plugin.settings.highlightCollectGroups = false;
        const t = plugin.collectHighlightTargets([{ kind: 'all' }], a, [a, b]);
        expect(t.map((x) => x.el)).toEqual([a.frame, b.frame]);
        plugin.settings.highlightCollectWindows = false;
        expect(plugin.collectHighlightTargets([{ kind: 'all' }], a, [a, b])).toEqual([]);
    });
});
