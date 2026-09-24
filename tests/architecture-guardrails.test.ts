import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * This file locks in structural invariants that this repo's history shows are
 * easy for an AI editing session to silently reintroduce -- each one caused a
 * real, shipped regression at least once. These are text-level/static checks
 * (not behavioral tests) because the whole point is to catch the *pattern*
 * being reintroduced anywhere in the file, not just in the one call site an
 * agent happened to be looking at.
 *
 * If a check here fails because of a genuinely new, deliberate, and reviewed
 * exception, update the check itself (with a comment explaining why) rather
 * than deleting it -- the goal is to keep the guard's reasoning attached to
 * the code, not to make the test pass.
 */

const mainTsPath = path.resolve(__dirname, '../main.ts');
const mainTsSource = fs.readFileSync(mainTsPath, 'utf-8');

describe('Architecture guardrails: workspace/leaf lifecycle safety', () => {
    it('never manually detaches a split/tab-group container (WorkspaceParent), only individual leaves', () => {
        // History: commit 0fff05f added `parent.detach()` calls on now-empty
        // split/tab-group containers after evacuating their leaves during
        // collectTabs(). Commit 97bfc70 (~2 hours later) reverted this with the
        // message "Remove manual parent.detach() from collectTabs to prevent
        // Obsidian split tree corruption" -- manually detaching a container
        // Obsidian itself manages corrupts its internal split tree, which then
        // gets serialized into workspace.json on save and can prevent window /
        // tab-group layouts from being reconstructed on the next launch.
        // Obsidian already prunes empty split/tab-group containers on its own
        // once their leaves are gone; never do it manually.
        const detachCalls = [...mainTsSource.matchAll(/(\w+)\.detach\(\)/g)];
        expect(detachCalls.length).toBeGreaterThan(0); // sanity: the pattern still exists somewhere (dedupe/collect)

        const nonLeafDetach = detachCalls
            .map((m) => m[1])
            .filter((identifier) => !/leaf/i.test(identifier));

        expect(nonLeafDetach).toEqual([]);
    });

    it('never writes to Obsidian workspace/layout persistence directly', () => {
        // This plugin only ever manipulates live in-memory WorkspaceLeaf /
        // WorkspaceParent objects; Obsidian itself is solely responsible for
        // serializing layout to workspace.json. Calling any of these APIs
        // directly is either redundant (requestSaveLayout), destructive
        // (getLayout/setLayout wholesale-replace the layout and have caused
        // corruption here before -- see commit e258296's description of the
        // "destructive layout APIs" it replaced), or bypasses Obsidian's own
        // atomic-write handling for workspace.json.
        const forbiddenPatterns = [
            'requestSaveLayout',
            'saveLocalStorage',
            '.getLayout(',
            '.setLayout(',
            "workspace.json",
        ];
        for (const pattern of forbiddenPatterns) {
            expect(mainTsSource.includes(pattern)).toBe(false);
        }
    });

    it('closePopoutWindowIfEmpty checks for an open modal before closing a window', () => {
        // History: a popout window can have no WorkspaceLeaf left in it while
        // still hosting an open Obsidian Modal (e.g. Settings / Community
        // plugins), because Modal.open() attaches to whichever window was
        // active when it was opened, not necessarily the main window. Closing
        // the window out from under that modal tears down its document
        // mid-render and leaves a blank, unresponsive window behind. See the
        // commit that introduced this check for the concrete repro.
        const fnMatch = mainTsSource.match(
            /private closePopoutWindowIfEmpty\(win: Window\): void \{[\s\S]*?\n    \}/
        );
        expect(fnMatch).not.toBeNull();
        expect(fnMatch![0]).toContain('modal-container');
    });

    it('closePopoutWindowIfEmpty never force-closes a window without a prior win.closed guard', () => {
        // History: a "double-closing race condition" in this function (fixed in
        // commit 97bfc70) force-closed a window a second time after it had
        // already been closed via WorkspaceWindow.close(). The function must
        // bail out immediately if the window is already closed.
        const fnMatch = mainTsSource.match(
            /private closePopoutWindowIfEmpty\(win: Window\): void \{[\s\S]*?\n    \}/
        );
        expect(fnMatch).not.toBeNull();
        expect(fnMatch![0]).toMatch(/win\.closed/);
    });
});

describe('Architecture guardrails: single-source-of-truth event handling', () => {
    it('collect-tabs-modal registers Space exactly once, never via Scope', () => {
        // History: Space was registered in THREE overlapping places (Scope ' ',
        // Scope 'Space', and an inputEl DOM listener) in addition to the
        // modalEl capture listener. Each registration ran handleSpace() on the
        // same physical keypress, netting out to a check-then-uncheck no-op
        // that looked to the user like Space "did nothing". Space must be
        // handled by exactly one listener (the modalEl capture listener).
        const modalTsPath = path.resolve(__dirname, '../src/ui/collect-tabs-modal.ts');
        const modalSource = fs.readFileSync(modalTsPath, 'utf-8');

        expect(modalSource).not.toMatch(/scope\.register\(\[\],\s*['"] ['"]/);
        expect(modalSource).not.toMatch(/scope\.register\(\[\],\s*['"]Space['"]/);
        expect(modalSource).not.toMatch(/inputEl\.addEventListener\(['"]keydown['"]/);
    });
});
