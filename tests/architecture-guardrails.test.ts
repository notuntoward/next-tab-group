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

describe('Architecture guardrails: private Obsidian API calls', () => {
    it('never calls chooser.setSelectedItem with a boolean second argument, anywhere in the plugin', () => {
        // History: chooser.setSelectedItem(index, true) crashed real Obsidian
        // 1.13.7's internal forceSetSelectedItem with "t.instanceOf is not a
        // function", since its real signature is (index, event?: Event), not
        // (index, scrollIntoView: boolean). This exact pattern was found in
        // THREE separate places (src/ui/collect-tabs-modal.ts, src/utils/modal.ts's
        // Ctrl+N/Ctrl+P emacs motion keys, and main.ts's NavigationSuggestModal) --
        // all copied from the same stale assumption about the API signature.
        // Guard the whole plugin, not just one file.
        const filesToCheck = [
            path.resolve(__dirname, '../main.ts'),
            path.resolve(__dirname, '../src/ui/collect-tabs-modal.ts'),
            path.resolve(__dirname, '../src/utils/modal.ts'),
        ];
        for (const filePath of filesToCheck) {
            const source = fs.readFileSync(filePath, 'utf-8');
            expect(source).not.toMatch(/setSelectedItem\([^)]*,\s*true\)/);
        }
    });

    it('collect-tabs-modal.ts wraps its chooser.setSelectedItem calls in try/catch', () => {
        // The uncaught throw happened inside onOpen(), synchronously and early,
        // skipping the ArrowUp/ArrowDown scope registrations set up afterward.
        // Both call sites (the direct call in setHighlightedIndex, and the
        // hooked wrapper's call to the original method) must be wrapped in
        // try/catch, since this is an undocumented internal API that can change
        // or fail in ways obsidian.d.ts cannot warn about.
        const modalTsPath = path.resolve(__dirname, '../src/ui/collect-tabs-modal.ts');
        const modalSource = fs.readFileSync(modalTsPath, 'utf-8');

        const setSelectedItemCalls = [...modalSource.matchAll(/\bchooser\.setSelectedItem\(/g)];
        expect(setSelectedItemCalls.length).toBeGreaterThan(0); // sanity: still present somewhere

        // The direct call in setHighlightedIndex must be wrapped in try/catch.
        const setHighlightedIndexMatch = modalSource.match(
            /public setHighlightedIndex\(index: number\): void \{[\s\S]*?\n {4}\}/
        );
        expect(setHighlightedIndexMatch).not.toBeNull();
        expect(setHighlightedIndexMatch![0]).toMatch(/try\s*\{[\s\S]*?chooser\.setSelectedItem\([\s\S]*?\}\s*catch/);
    });
});

describe('Architecture guardrails: multi-window collection destination selection', () => {
    it('collectTabs("multi", ...) picks the destination from the checked-windows snapshot, never from a freshly re-queried active leaf/window', () => {
        // History: the destination for a multi-popout collection was picked by
        // re-querying "the active window" (via a fresh activeLeaf/currentWinInfo
        // computed at the moment collectTabs() runs) rather than using the
        // isCurrentWindow flag already captured in the checked-windows snapshot
        // when the modal opened. If live focus moved between modal-open and
        // modal-close (e.g. because closing the modal returned focus to the Main
        // Window), tabs landed in the wrong window, and a window that should
        // have survived as the destination could be evacuated too. The fix
        // derives destWinInfo purely from checkedWindows' own isCurrentWindow
        // flags (or mainWinInfo when Main is checked), never from currentWinInfo
        // or a bare activeLeaf fallback.
        const multiMatch = mainTsSource.match(
            /\} else if \(scope === 'multi' && Array\.isArray\(source\)\) \{[\s\S]*?\n {8}\}/
        );
        expect(multiMatch).not.toBeNull();
        const multiBranch = multiMatch![0];

        expect(multiBranch).toContain('checkedWindows.find((w) => w.isCurrentWindow)');
        expect(multiBranch).not.toMatch(/currentWinInfo\.window/);
        expect(multiBranch).not.toMatch(/destWinInfo\.isCurrentWindow\s*\?\s*activeLeaf/);
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
