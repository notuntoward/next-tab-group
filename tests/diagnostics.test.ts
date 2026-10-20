import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DiagLog, summarizeLayout, FreezeWatchdog } from '../src/utils/diagnostics';
import { vi } from 'vitest';

vi.mock('child_process', () => ({ spawn: vi.fn(() => ({ on: vi.fn(), kill: vi.fn() })) }));

describe('Phase 1b diagnostics owner window', () => {
    it.skipIf(process.platform !== 'win32')('writes visibility and cancels heartbeat on the explicitly supplied main window', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ntg-heartbeat-'));
        const watchdog = new FreezeWatchdog();
        const doc = document.implementation.createHTMLDocument('diagnostic main');
        Object.defineProperty(doc, 'visibilityState', { value: 'hidden' });
        const win = { document: doc, setInterval: vi.fn(() => 123), clearInterval: vi.fn() } as unknown as Window;
        try {
            (watchdog.start as (...args: unknown[]) => void)(join(dir, 'log'), join(dir, 'heartbeat'), () => 'context', () => {}, win);
            expect(readFileSync(join(dir, 'heartbeat'), 'utf8')).toContain('|hidden|context');
            expect(win.setInterval).toHaveBeenCalledWith(expect.any(Function), 1000);
            watchdog.stop();
            expect(win.clearInterval).toHaveBeenCalledWith(123);
        } finally {
            watchdog.stop();
            vi.restoreAllMocks();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

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

describe('summarizeLayout', () => {
    it('marks a detached leaf and leaves a live one unmarked', () => {
        const root: { type: string; direction: string; children: unknown[] } = {
            type: 'split',
            direction: 'vertical',
            children: [],
        };
        const live = { parent: root, view: { getViewType: () => 'markdown' }, detached: false };
        const gone = { parent: root, view: { getViewType: () => 'graph' }, detached: true };
        root.children.push(live, gone);

        const { text, anomalies } = summarizeLayout({ rootSplit: root });

        expect(text).toContain('rootSplit=split:v[L(markdown),L(graph,detached)]');
        expect(anomalies).toEqual([]);
    });
});
