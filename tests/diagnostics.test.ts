import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DiagLog } from '../src/utils/diagnostics';

describe('DiagLog repeat collapsing', () => {
    it('collapses identical consecutive records and reports counts', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ntg-diag-'));
        try {
            const path = join(dir, 'd.log');
            const log = new DiagLog(path);
            for (let i = 0; i < 150; i++) log.log('ERROR', 'window error', { msg: 'ResizeObserver loop' });
            log.log('EVENT', 'layout-change');
            const lines = readFileSync(path, 'utf8').trim().split('\n');
            // first record, REPEAT at 10 and 100, final REPEAT x150 on change, then the new record
            expect(lines.filter((l) => l.includes('window error'))).toHaveLength(1);
            expect(lines.filter((l) => l.includes('REPEAT'))).toHaveLength(3);
            expect(lines.some((l) => l.includes('x149'))).toBe(true);
            expect(lines[lines.length - 1]).toContain('layout-change');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does not collapse records that differ or alternate', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ntg-diag-'));
        try {
            const path = join(dir, 'd.log');
            const log = new DiagLog(path);
            for (let i = 0; i < 3; i++) {
                log.log('VIS', 'main focus');
                log.log('VIS', 'main blur');
            }
            expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(6);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
