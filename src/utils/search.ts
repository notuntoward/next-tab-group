// Thin shim over the shared library. The implementation lives in commons/search;
// this file only supplies this plugin's CSS prefix.
import {
    renderJoinedHits as renderJoinedHitsCommon,
    renderMatchingTitles as renderMatchingTitlesCommon,
    type JoinedSearch,
    type PartHit,
} from 'commons/search';

export * from 'commons/search';
export const renderMatchingTitles = (el: HTMLElement, hits: PartHit[], isShown: (title: string) => boolean): void =>
    renderMatchingTitlesCommon(el, hits, isShown, 'ntg');
export const renderJoinedHits = (el: HTMLElement, search: JoinedSearch, matches: number[][]): void =>
    renderJoinedHitsCommon(el, search, matches, 'ntg');
