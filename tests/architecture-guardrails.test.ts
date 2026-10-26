import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { ESLint } from 'eslint';

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

    it('closePopoutWindowIfEmpty delegates to commons, which owns the modal-container and win.closed guards', () => {
        // History: (1) a popout with no leaf left can still host an open Modal
        // (Settings / Community plugins) because Modal.open() attaches to the
        // window that was active, so closing it tears the document down
        // mid-render. (2) a "double-closing race condition" (commit 97bfc70)
        // force-closed a window a second time. Both guards now live in
        // commons/workspace closePopoutWindowIfEmpty and are tested in the
        // commons repo (tests/workspace.test.ts). This plugin must not grow its
        // own close logic again.
        const fnMatch = mainTsSource.match(
            /private closePopoutWindowIfEmpty\(win: Window\): void \{[\s\S]*?\n    \}/
        );
        expect(fnMatch).not.toBeNull();
        expect(fnMatch![0]).toContain('kit.closePopoutWindowIfEmpty');
        expect(fnMatch![0]).not.toMatch(/\.close\(\)/);
    });
});

describe('Architecture guardrails: private Obsidian API calls', () => {
    it('uses the shared target highlighter instead of retaining a private copy', () => {
        expect(mainTsSource).toMatch(/import \{[^}]*TargetHighlighter[^}]*\} from 'commons\/workspace'/);
        const modalSource = fs.readFileSync(path.resolve(__dirname, '../src/ui/collect-tabs-modal.ts'), 'utf-8');
        expect(modalSource).toMatch(/import \{[^}]*TargetHighlighter[^}]*\} from 'commons\/workspace'/);
        expect(fs.existsSync(path.resolve(__dirname, '../src/utils/target-highlight.ts'))).toBe(false);
    });

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

    it('the modal\'s single-window choice uses the captured snapshot, never collectTabs("current") which re-queries the active window', () => {
        // History: the CollectTabsModal's single-result onPick branch called
        // collectTabs('current'), which re-derives the active leaf/window via
        // getActiveLeafInFocusedWindow() at the moment the callback runs. If live
        // focus moved while the modal was up (e.g. the user clicked another
        // window, or closing the modal restored focus elsewhere), the collection
        // targeted the wrong window, so the intended window's tab groups were
        // left untouched -- appearing to the user as "collect tabs did nothing".
        // The single-window choice must instead reuse the currentWinInfo snapshot
        // captured when the modal opened, i.e. collectTabs('multi', [currentWinInfo]).
        const modalCall = mainTsSource.match(/new CollectTabsModal\([\s\S]*?\.open\(\);/);
        expect(modalCall).not.toBeNull();
        const callbackRegion = modalCall![0];

        expect(callbackRegion).toContain("collectTabs('multi', [currentWinInfo])");
        expect(callbackRegion).not.toMatch(/collectTabs\('current'\)/);
    });
});

describe('Architecture guardrails: modal open() contract', () => {
    it('CollectTabsModal never sets this.isOpen = true before super.open()', () => {
        // History: open() set `this.isOpen = true` and then called super.open().
        // Real Obsidian's Modal.open() silently no-ops when the instance's own
        // isOpen flag is already truthy (no onOpen, no DOM, no error), so the
        // Collect tabs command appeared to do nothing at all. The mocks did not
        // model this guard, so every test passed.
        const src = fs.readFileSync(path.resolve(__dirname, '../src/ui/collect-tabs-modal.ts'), 'utf-8');
        const openStart = src.indexOf('    open(): void {');
        const superCall = src.indexOf('super.open()', openStart);
        expect(openStart).toBeGreaterThan(-1);
        expect(superCall).toBeGreaterThan(openStart);
        const before = src.slice(openStart, superCall).replace(/\/\/.*$/gm, '');
        expect(before).not.toMatch(/this\.isOpen\s*=\s*true/);
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

describe('Architecture guardrails: active-tab color scoping', () => {
    // History: the rule targeted bare `.workspace-tab-header.is-active`.
    // Obsidian puts `.is-active` on the selected tab of EVERY tab group (and
    // every popout window), so several tabs were highlighted at once. Only the
    // focused group carries `.workspace-tabs.mod-active`.
    const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const colorSelectors = [...css.matchAll(/([^{}]+)\{[^{}]*--ntg-active-tab-color[^{}]*\}/g)]
        .map((m) => m[1].trim())
        .filter((s) => s.includes('.workspace-tab-header'));

    function group(parent: HTMLElement, name: string, focused: boolean) {
        const tabs = document.createElement('div');
        tabs.className = 'workspace-tabs' + (focused ? ' mod-active' : '');
        const container = document.createElement('div');
        container.className = 'workspace-tab-header-container';
        const selected = document.createElement('div');
        selected.className = 'workspace-tab-header is-active';
        selected.dataset.name = `${name}-selected`;
        const other = document.createElement('div');
        other.className = 'workspace-tab-header';
        other.dataset.name = `${name}-other`;
        container.append(selected, other);
        tabs.append(container);
        parent.append(tabs);
        return [selected, other];
    }

    function highlighted(theme: 'theme-light' | 'theme-dark'): string[] {
        document.body.className = `ntg-color-active-tab ${theme}`;
        const main = document.createElement('div');
        const popout = document.createElement('div');
        document.body.append(main, popout);
        // Mirrors the reported layout: main window has two groups (top focused,
        // bottom not), plus a popout window group that is not focused.
        const headers = [
            ...group(main, 'main-top', true),
            ...group(main, 'main-bottom', false),
            ...group(popout, 'popout', false),
        ];
        const result = headers
            .filter((h) => colorSelectors.some((s) => h.matches(s)))
            .map((h) => h.dataset.name as string);
        main.remove();
        popout.remove();
        return result;
    }

    it('finds the light and dark active-tab color rules', () => {
        expect(colorSelectors.length).toBeGreaterThanOrEqual(2);
    });

    for (const theme of ['theme-light', 'theme-dark'] as const) {
        it(`highlights only the focused group's active tab (${theme})`, () => {
            expect(highlighted(theme)).toEqual(['main-top-selected']);
        });
    }
});
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function balancedBlockAfter(source: string, anchor: RegExp): string | null {
    const match = anchor.exec(source);
    if (!match) return null;
    const open = source.indexOf('{', match.index + match[0].length - 1);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
    }
    return null;
}

function bareGlobals(source: string): string[] {
    const file = ts.createSourceFile('runtime.ts', stripComments(source), ts.ScriptTarget.Latest, true);
    const hits: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && ['document', 'window', 'navigator', 'localStorage'].includes(node.text)) {
            const parent = node.parent;
            const property = (ts.isPropertyAccessExpression(parent) && parent.name === node)
                || ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node);
            if (!property) hits.push(node.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return hits;
}

describe('Phase 1b bare-global guardrails', () => {
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
    });

    it('rejects bare globals in all runtime sources without exceptions', () => {
        const violations = [mainTsPath, ...files(path.resolve(__dirname, '../src'))].flatMap((file) =>
            bareGlobals(fs.readFileSync(file, 'utf8')).map((name) => `${path.relative(path.dirname(mainTsPath), file)}: ${name}`));
        expect(violations).toEqual([]);
    });

    it('detects mutants, strips comments, and ignores property names and string literals', () => {
        expect(bareGlobals('window.setTimeout(() => document.body.focus(), 0); navigator.clipboard; localStorage.clear();'))
            .toEqual(['window', 'document', 'navigator', 'localStorage']);
        expect(bareGlobals('/* window */ const x = win.document; // document\nconst row = { window: win, label: "window" };')).toEqual([]);
    });

    it('eslint rejects all bare-global and timer mutants in runtime sources', async () => {
        const eslint = new ESLint({ cwd: path.dirname(mainTsPath) });
        for (const filePath of ['main.ts', 'src/ui/collect-tabs-modal.ts', 'src/utils/diagnostics.ts']) {
            const config = await eslint.calculateConfigForFile(filePath);
            const checker = new ESLint({ overrideConfigFile: true, overrideConfig: { rules: {
                'no-restricted-globals': config.rules['no-restricted-globals'],
                'no-restricted-properties': config.rules['no-restricted-properties'],
            } } });
            const [result] = await checker.lintText('document.body; window.setTimeout(() => {}, 0); window.requestAnimationFrame(() => {}); navigator.clipboard; localStorage.clear();');
            expect(result.messages.filter((m) => m.ruleId === 'no-restricted-globals')).toHaveLength(5);
            expect(result.messages.filter((m) => m.ruleId === 'no-restricted-properties')).toHaveLength(2);
        }
    });

    it('does not claim OS-level focus before commons/os exists', () => {
        expect(mainTsSource).not.toContain('guarantees OS-level window focus');
    });
});

const BARE_MAIN_WINDOW_GLOBAL = /(?<![\w.$])(document|window|navigator|localStorage)\b(?!\s*[:?]|\s*=>)/;

describe('Architecture guardrails: one navigation model', () => {
    const code = stripComments(mainTsSource);

    it('main.ts scans no workspace leaves; commons owns every scan', () => {
        // History: dedupeEmptied, closePopoutWindowIfEmpty, the active-tab-colour
        // window loops and getActiveLeafInFocusedWindow each ran their own
        // iterateAllLeaves scan with its own window/group/main-window rules, so
        // they drifted from the model the pickers use (the Deduplicate footer
        // miscounted emptied groups and windows). Derive windows, groups and
        // tabs from buildNavigationModel / getEditorLeafLocations instead.
        expect([...code.matchAll(/iterateAllLeaves\(/g)]).toHaveLength(0);
        expect([...code.matchAll(/iterateRootLeaves\(/g)]).toHaveLength(0);
    });

    it('builds groups, tabs and windows with the commons builders and keeps no model of its own', () => {
        expect(code).toMatch(/kit\s*\.getEditorLeafLocations\(/);
        expect(code).toMatch(/kit\s*\.buildTabGroups\(/);
        expect(code).toMatch(/kit\s*\.buildTabEntries\(/);
        expect(code).toMatch(/kit\s*\.buildWindowEntries\(/);
        expect(code).toMatch(/kit\s*\.getGroupsInWindow\(/);
        expect(code).toMatch(/kit\s*\.getTabsInWindow\(/);
        expect(code).toMatch(/kit\s*\.getGroupForLeaf\(/);
        expect(code).not.toMatch(/new Map<\s*Window\b[^>]*,\s*(Map<|TabGroupInfo|WorkspaceLeaf)/);
        expect(code).not.toMatch(/\bbyWindow\b/);
    });

    it('takes direction from TabGroup.direction, not from rectangles computed in the plugin', () => {
        expect(code).not.toMatch(/\brelativePosition\b/);
        expect(code).not.toMatch(/\bgetTabGroupRect\b/);
        expect(code).toMatch(/\.direction\b/);
    });

    it('keeps recency in commons LeafRecency instead of a private map', () => {
        expect(code).toMatch(/new LeafRecency\(\)/);
        expect(code).not.toMatch(/\bleafLastActive\b/);
        expect(code).not.toMatch(/\bpruneLeafLastActive\b/);
        expect(code).not.toMatch(/\bcompareRecency\b/);
    });

    it('reads no undocumented Obsidian leaf or container fields in main.ts or the collect modal', () => {
        const modalCode = stripComments(
            fs.readFileSync(path.resolve(__dirname, '../src/ui/collect-tabs-modal.ts'), 'utf-8'),
        );
        const diagnosticsCode = stripComments(
            fs.readFileSync(path.resolve(__dirname, '../src/utils/diagnostics.ts'), 'utf-8'),
        );
        expect(diagnosticsCode).not.toMatch(/\.detached\b/);
        for (const source of [code, modalCode]) {
            expect(source).not.toMatch(/\.getContainer\b/);
            expect(source).not.toMatch(/\.detached\b/);
            expect(source).not.toMatch(/\btabHeaderEl\b/);
            expect(source).not.toMatch(/\bas any\)\??\.id\b/);
            expect(source).not.toMatch(/WorkspaceLeafInternal/);
        }
    });
});

describe('Architecture guardrails: per-window setup goes through forEachWindow', () => {
    const code = stripComments(mainTsSource);
    const lifecycle: Array<[string, RegExp]> = [
        ['applyActiveTabColors', /\n    applyActiveTabColors\(\)[^{]*\{/],
        ['applyActiveTabColorsToWindow', /\n    private applyActiveTabColorsToWindow\(/],
        ['clearActiveTabColorsFromWindow', /\n    private clearActiveTabColorsFromWindow\(/],
        ['the forEachWindow setup', /forEachWindow\(this, \(win\) => \{/],
    ];

    it('colors every window, including pop-outs opened later, from a single forEachWindow registration', () => {
        expect([...code.matchAll(/forEachWindow\(this,/g)]).toHaveLength(1);
        expect(code).toMatch(/import \{[^}]*\bforEachWindow\b[^}]*\} from 'commons\/windows'/);
    });

    it.each(lifecycle)('%s never touches the main window document by a bare global', (_name, anchor) => {
        const body = balancedBlockAfter(code, anchor);
        expect(body).not.toBeNull();
        expect(body!.length).toBeGreaterThan(20);
        expect(body).not.toMatch(BARE_MAIN_WINDOW_GLOBAL);
    });

    it('the bare-global pattern flags main-window globals and ignores per-window access', () => {
        expect(BARE_MAIN_WINDOW_GLOBAL.test('document.body.classList.add(x)')).toBe(true);
        expect(BARE_MAIN_WINDOW_GLOBAL.test('window.setTimeout(f, 1)')).toBe(true);
        expect(BARE_MAIN_WINDOW_GLOBAL.test('const body = win.document?.body')).toBe(false);
        expect(BARE_MAIN_WINDOW_GLOBAL.test('doc.body.style.setProperty(a, b)')).toBe(false);
    });
});
describe('Architecture guardrails: checkbox picker state', () => {
    const modalSource = fs.readFileSync(path.resolve(__dirname, '../src/ui/collect-tabs-modal.ts'), 'utf-8');

    it('Left/Right in the checkbox pickers read and move the modal-owned cursor, not chooser.selectedItem', () => {
        // AGENTS.md rules 7 and 13: Obsidian can mutate chooser.selectedItem on
        // its own, so the neighbor lookup must go through highlightedIndex.
        expect(modalSource).toMatch(/registerEmacsMotionKeys\(\s*this,[\s\S]*?cursor:\s*\{[\s\S]*?getHighlightedItem\(\)[\s\S]*?setHighlightedIndex\(/);
    });

    it('mouse-sourced chooser selection is treated as hover and never moves the cursor', () => {
        const hook = modalSource.match(/chooser\.setSelectedItem = \([\s\S]*?this\.setHoveredRow\([\s\S]*?return;/);
        expect(hook).not.toBeNull();
    });

    it('the action acts only on checked rows', () => {
        const fn = modalSource.match(/public executeCollection\(\): void \{[\s\S]*?\n    \}/);
        expect(fn).not.toBeNull();
        expect(fn![0]).toContain('getCheckedRows()');
        expect(fn![0]).not.toContain('getHighlightedItem');
    });
});
