import { describe, it, expect } from 'vitest';
import { mapFuzzyMatchesToDisplayText } from '../src/utils/modal';

describe('mapFuzzyMatchesToDisplayText', () => {
    it('keeps matches that fall entirely within the display range', () => {
        const matches = mapFuzzyMatchesToDisplayText(
            'Burton15libsNeuroticConsrvsHappy right',
            'Burton15libsNeuroticConsrvsHappy',
            0,
            [[0, 6]],
        );

        expect(matches).toEqual([[0, 6]]);
    });

    it('shifts matches to be relative to the display text', () => {
        const matches = mapFuzzyMatchesToDisplayText(
            'right Burton15libsNeuroticConsrvsHappy',
            'Burton15libsNeuroticConsrvsHappy',
            6,
            [[6, 12]],
        );

        expect(matches).toEqual([[0, 6]]);
    });

    it('clips matches that extend beyond the display range', () => {
        const matches = mapFuzzyMatchesToDisplayText(
            'Burton15libsNeuroticConsrvsHappy right',
            'Burton15libsNeuroticConsrvsHappy',
            0,
            [[0, 100]],
        );

        expect(matches).toEqual([[0, 32]]);
    });

    it('drops matches that fall completely outside the display range', () => {
        const matches = mapFuzzyMatchesToDisplayText(
            'Burton15libsNeuroticConsrvsHappy oticCon',
            'Burton15libsNeuroticConsrvsHappy',
            0,
            [[33, 40]],
        );

        expect(matches).toEqual([]);
    });

    it('returns an empty array when no matches are provided', () => {
        const matches = mapFuzzyMatchesToDisplayText('anything', 'display', 0, []);

        expect(matches).toEqual([]);
    });

    it('splits matches that straddle the display boundary', () => {
        const matches = mapFuzzyMatchesToDisplayText(
            'abc displayText xyz',
            'displayText',
            4,
            [[2, 8]],
        );

        expect(matches).toEqual([[0, 4]]);
    });
});
