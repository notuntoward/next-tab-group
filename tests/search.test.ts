import { describe, it, expect } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import { matchParts, joinedSearch, statusWords, uniqueTitles } from '../src/utils/search';
import { CollectTabsModal, resetSessionWindowIndices } from '../src/ui/collect-tabs-modal';
import type { WindowInfo } from '../main';
import { MockApp, MockWorkspaceLeaf } from './mocks/obsidian';

const parts = (...texts: string[]) => texts.map((text) => ({ text, show: true }));

describe('matchParts: orderless fuzzy matching across parts', () => {
    it('matches words in any order, each word in order within itself', () => {
        const p = parts('Lifespan', 'Window 3', 'here');
        expect(matchParts('lifespan 3', p).length).toBe(2);
        expect(matchParts('3 lifespan', p).length).toBe(2);
        expect(matchParts('lfsp', p).map((h) => h.part.text)).toEqual(['Lifespan']);
    });

    it('needs every word to match something, and ignores an empty query', () => {
        const p = parts('Lifespan', 'Window 3');
        expect(matchParts('lifespan zzz', p)).toEqual([]);
        expect(matchParts('   ', p)).toEqual([]);
    });

    it('does not match derived count text that is not part of the row', () => {
        expect(matchParts('tab groups', parts('Lifespan', 'Window 3'))).toEqual([]);
    });

    it('merges highlight ranges when two words hit the same part', () => {
        const [hit] = matchParts('li sp', parts('Lifespan'));
        expect(hit.matches).toEqual([[0, 2], [4, 6]]);
    });
});

describe('search helpers', () => {
    it('statusWords splits the HERE/MAIN pill text', () => {
        expect(statusWords('HERE · MAIN')).toEqual(['here', 'main']);
        expect(statusWords(undefined)).toEqual([]);
    });

    it('uniqueTitles drops blanks and repeats, keeping first-seen order', () => {
        expect(uniqueTitles(['A', ' ', 'B', 'A', null, undefined])).toEqual(['A', 'B']);
    });

    it('joinedSearch records where each title sits and appends the suffix', () => {
        const s = joinedSearch(['One', 'Two'], 'Window 2');
        expect(s.text).toBe('One · Two · Window 2');
        expect(s.spans).toEqual([{ title: 'One', start: 0 }, { title: 'Two', start: 6 }]);
        expect(s.text.slice(s.spans[1].start, s.spans[1].start + 3)).toBe('Two');
    });
});

describe('Collect tabs filter searches what the user can see or remember', () => {
    function modalWith(titles: string[]) {
        resetSessionWindowIndices();
        const app = new MockApp();
        const leaves = titles.map((t, i) => new MockWorkspaceLeaf(t).setId(`l${i}`));
        const here: WindowInfo = {
            window: globalThis.window,
            representative: leaves[0] as unknown as WorkspaceLeaf,
            groups: [{ leaves } as never],
            lastActive: 2, label: 'Main', isCurrentWindow: true, isMainWindow: true,
        };
        const other = new MockWorkspaceLeaf('Other.md').setId('o');
        const there: WindowInfo = {
            window: { name: 'pop' } as unknown as Window,
            representative: other as unknown as WorkspaceLeaf,
            groups: [{ leaves: [other] } as never],
            lastActive: 1, label: 'Pop', isCurrentWindow: false, isMainWindow: false,
        };
        return new CollectTabsModal(app as unknown as App, here, [there], () => undefined);
    }

    it('finds a window by a tab that is not one of the two titles its row shows', () => {
        const modal = modalWith(['First.md', 'Second.md', 'Zebra third.md']);
        const found = modal.getSuggestions('zebra');
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('current');
    });

    it('finds windows by number, HERE and MAIN, and by words in any order', () => {
        const modal = modalWith(['First.md', 'Second.md']);
        expect(modal.getSuggestions('here').map((r) => r.kind)).toEqual(['current']);
        expect(modal.getSuggestions('main').map((r) => r.kind)).toEqual(['current']);
        expect(modal.getSuggestions('window 1').map((r) => r.kind)).toEqual(['current']);
        expect(modal.getSuggestions('second first').map((r) => r.kind)).toEqual(['current']);
        expect(modal.getSuggestions('other').map((r) => r.kind)).toEqual(['window']);
    });

    it('lists the matching tab under the row when it is not already shown', () => {
        const modal = modalWith(['First.md', 'Second.md', 'Zebra third.md']);
        modal.inputEl.value = 'zebra';
        const row = modal.getSuggestions('zebra')[0];
        const el = document.createElement('div');
        modal.renderSuggestion(row, el);
        const hits = [...el.querySelectorAll('.ntg-scope-item-match')].map((n) => n.textContent);
        expect(hits).toEqual(['Zebra third.md']);
    });
});