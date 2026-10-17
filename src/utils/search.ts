import { prepareFuzzySearch } from 'obsidian';
import { mapFuzzyMatchesToDisplayText, renderHighlightedText } from './modal';

/**
 * Search text for the pickers. A row is found by what the user can recognise
 * it by: the titles of the tabs it holds, its window number, and HERE/MAIN.
 * Never by derived counts or labels such as "11 tabs in 4 tab groups".
 */

/** One independently searchable piece of a row. `show` marks a tab title worth listing under the row when it matches. */
export interface SearchPart {
    text: string;
    show?: boolean;
}

export interface PartHit {
    part: SearchPart;
    matches: number[][];
}

/**
 * Orderless fuzzy match. The query is split into words and EVERY word must
 * match some part (a tab title, the window number, HERE/MAIN); different words
 * may match different parts and in any order. Inside one word the letters must
 * appear in order but may be scattered ("lfsp" finds "Lifespan"). Returns the
 * parts that matched with their highlight ranges, or [] when any word matches
 * nothing (or the query is empty).
 */
export function matchParts(query: string, parts: SearchPart[]): PartHit[] {
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const byPart = new Map<SearchPart, number[][]>();
    for (const word of words) {
        const search = prepareFuzzySearch(word);
        let found = false;
        for (const part of parts) {
            const m = search(part.text);
            if (!m) continue;
            found = true;
            byPart.set(part, [...(byPart.get(part) ?? []), ...m.matches]);
        }
        if (!found) return [];
    }
    return parts
        .filter((p) => byPart.has(p))
        .map((part) => ({ part, matches: mergeRanges(byPart.get(part)!) }));
}

function mergeRanges(ranges: number[][]): number[][] {
    const sorted = ranges.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const out: number[][] = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else out.push(r);
    }
    return out;
}
/** Distinct, non-empty titles in order, first occurrence wins. */
export function uniqueTitles(titles: Array<string | null | undefined>): string[] {
    const out: string[] = [];
    for (const t of titles) {
        const title = (t ?? '').trim();
        if (title && !out.includes(title)) out.push(title);
    }
    return out;
}

/** The status words a row's HERE/MAIN pill stands for, lower-cased, so "here" and "main" find it. */
export function statusWords(status: string | undefined): string[] {
    return (status ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

/**
 * Search text for the Obsidian-fuzzy pickers, which match one string per item:
 * the titles joined with " · ", then `suffix` (location, window number, ...).
 * `spans` records where each title sits so matches can be mapped back to it.
 */
export interface JoinedSearch {
    text: string;
    spans: Array<{ title: string; start: number }>;
}

export function joinedSearch(titles: string[], suffix: string): JoinedSearch {
    const spans: JoinedSearch['spans'] = [];
    let text = '';
    for (const title of titles) {
        if (text) text += ' · ';
        spans.push({ title, start: text.length });
        text += title;
    }
    if (suffix) text += (text ? ' · ' : '') + suffix;
    return { text, spans };
}

/** Appends a short list of matching tab titles (highlighted) under a row's content column. */
function appendHitList(el: HTMLElement, hits: PartHit[], isShown: (title: string) => boolean, max = 4): void {
    const content = el.querySelector<HTMLElement>('.ntg-col-content');
    const shown = hits.filter((h) => h.part.show && !isShown(h.part.text));
    if (!content || shown.length === 0) return;
    content.addClass('ntg-col-content-multiline');
    const list = content.createDiv({ cls: 'ntg-scope-items ntg-match-items' });
    for (const hit of shown.slice(0, max)) {
        const item = list.createDiv({ cls: 'ntg-scope-item ntg-scope-item-match' });
        renderHighlightedText(item, hit.part.text, hit.matches);
    }
    if (shown.length > max) {
        list.createDiv({ cls: 'ntg-scope-item ntg-scope-item-more', text: `+${shown.length - max} more matches` });
    }
}

/** For the checkbox pickers: list the matching tab titles this row does not already show. */
export function renderMatchingTitles(el: HTMLElement, hits: PartHit[], isShown: (title: string) => boolean): void {
    appendHitList(el, hits, isShown);
}

/** For the Obsidian-fuzzy pickers: list tab titles (other than the first, already displayed) hit by `matches`. */
export function renderJoinedHits(el: HTMLElement, search: JoinedSearch, matches: number[][]): void {
    const hits: PartHit[] = [];
    search.spans.forEach((span, i) => {
        if (i === 0) return;
        const mapped = mapFuzzyMatchesToDisplayText(search.text, span.title, span.start, matches);
        if (mapped.length > 0) hits.push({ part: { text: span.title, show: true }, matches: mapped });
    });
    appendHitList(el, hits, () => false);
}