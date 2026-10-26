import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { App, WorkspaceLeaf, WorkspaceParent } from 'obsidian';
import * as kit from 'commons/workspace';
import NextTabGroupPlugin from '../main.ts';
import { MockApp, MockWorkspaceContainer, MockWorkspaceLeaf, MockWorkspaceParent } from './mocks/obsidian';
import { setLastActive } from './helpers/recency';
import { CollectTabsModal, getSessionWindowIndex, resetSessionWindowIndices } from '../src/ui/collect-tabs-modal';
import type { WindowInfo } from '../main';

describe('Phase 1b owner-window cleanup', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); CollectTabsModal.activeModal?.close(); });

    it('returns undefined when commons cannot resolve a main window', () => {
        vi.spyOn(kit, 'getMainWindow').mockReturnValue(undefined);
        const plugin = createPlugin(new MockApp()) as any;
        expect(plugin.getMainWindow()).toBeUndefined();
        expect(() => plugin.startDiagnostics()).not.toThrow();
    });

    it('uses model identity for numbering, MAIN marks and search even when it differs from the global window', () => {
        resetSessionWindowIndices();
        const doc = document.implementation.createHTMLDocument('popout');
        const win = { document: doc } as Window;
        vi.stubGlobal('activeDocument', doc);
        vi.stubGlobal('activeWindow', win);
        const info = (host: Window, main: boolean): WindowInfo => ({ window: host, isMainWindow: main,
            isCurrentWindow: main, groups: [], representative: new MockWorkspaceLeaf('A.md') as unknown as WorkspaceLeaf,
            label: 'A', lastActive: 1 });
        const main = info(win, true);
        const pop = info(window, false);
        expect(getSessionWindowIndex(pop)).toBe(2);
        expect(getSessionWindowIndex(main)).toBe(1);
        const plugin = createPlugin(new MockApp()) as any;
        const mainRow = doc.createElement('div');
        plugin.renderWindowSuggestion(main, mainRow);
        expect(mainRow.querySelector('.ntg-window-badge')?.textContent).toBe('1');
        expect(mainRow.querySelector('.ntg-status-pill')?.textContent).toBe('HERE · MAIN');
        const popRow = doc.createElement('div');
        plugin.renderWindowSuggestion(pop, popRow);
        expect(popRow.querySelector('.ntg-window-badge')?.textContent).toBe('2');
        expect(popRow.querySelector('.ntg-status-pill')).toBeNull();
        const modal = new CollectTabsModal(new MockApp() as unknown as App, main, [pop], () => {});
        expect(modal.getSuggestions('main').map((r) => r.kind)).toEqual(['current']);
        const row = doc.createElement('div');
        modal.renderSuggestion(modal.buildChoices()[2], row);
        expect(row.textContent).not.toContain('MAIN');
    });

    it('schedules modal work and creates toolbar and summary in its owner document', () => {
        const doc = document.implementation.createHTMLDocument('popout');
        const schedule = vi.fn(() => 42);
        const win = { document: doc, setTimeout: schedule, clearTimeout: vi.fn() } as unknown as Window;
        Object.defineProperty(doc, 'defaultView', { value: win });
        vi.stubGlobal('activeDocument', doc);
        vi.stubGlobal('activeWindow', win);
        const modal = new CollectTabsModal(new MockApp() as unknown as App, null, [], () => {}, { getSummary: () => 'Owner-window picker summary' });
        modal.containerEl.appendChild(modal.modalEl);
        doc.body.appendChild(modal.containerEl);
        Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => modal.inputEl });
        const create = vi.spyOn(doc, 'createElement');
        modal.isOpen = true;
        modal.onOpen();
        expect(schedule).toHaveBeenCalledTimes(3);
        expect(create).toHaveBeenCalledWith('div');
        expect(modal.toolbarEl?.ownerDocument).toBe(doc);
        const focus = vi.spyOn(modal.selectAllBtn!, 'focus');
        modal.handleTabNavigation(new KeyboardEvent('keydown', { key: 'Tab' }));
        expect(focus).toHaveBeenCalledOnce();
        modal.close();
        expect(win.clearTimeout).toHaveBeenCalledWith(42);
    });
});

interface GroupModel {
    group: WorkspaceParent;
    window: Window;
    leaves: WorkspaceLeaf[];
    representative: WorkspaceLeaf;
    lastActive: number;
    label: string;
    relativeLabel: string | null;
    isCurrent: boolean;
    isCurrentGroup: boolean;
    direction: 'left' | 'right' | 'above' | 'below' | null;
}

interface Model {
    locations: Array<{ leaf: WorkspaceLeaf; window: Window; group: WorkspaceParent | null }>;
    groups: GroupModel[];
    tabs: Array<{ leaf: WorkspaceLeaf; group: GroupModel; lastActive: number }>;
    windows: Array<{
        window: Window;
        groups: GroupModel[];
        label: string;
        isCurrentWindow: boolean;
        isMainWindow?: boolean;
    }>;
}

type TestPlugin = NextTabGroupPlugin & {
    buildNavigationModel: (activeLeaf: WorkspaceLeaf | null) => Model;
    dedupeInAllGroups: () => Promise<void>;
    dedupeInAllWindows: () => Promise<void>;
    askConfirmation: (title: string, body: HTMLElement) => Promise<boolean>;
    recency: kit.LeafRecency;
};

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

function leaf(
    id: string,
    file: string | null,
    parent: MockWorkspaceParent,
    container: MockWorkspaceContainer,
): MockWorkspaceLeaf {
    return new MockWorkspaceLeaf(file).setId(id).setParent(parent).setContainer(container);
}

function asLeaf(l: MockWorkspaceLeaf): WorkspaceLeaf {
    return l as unknown as WorkspaceLeaf;
}

function setRect(group: MockWorkspaceParent, x: number, y: number, w = 100, h = 100): void {
    (group.containerEl as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
        ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON: () => ({}) }) as DOMRect;
}

const idOf = (l: unknown) => (l as { id: string }).id;

function expectSameItems<T>(actual: T[], expected: T[]): void {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((item, i) => expect(item).toBe(expected[i]));
}

describe('commons adoption: the plugin model is the commons model plus labels', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let mainContainer: MockWorkspaceContainer;
    let popContainer: MockWorkspaceContainer;

    beforeEach(async () => {
        app = new MockApp();
        mainContainer = new MockWorkspaceContainer('root', globalThis.window);
        popContainer = new MockWorkspaceContainer('window', { closed: false } as unknown as Window);
        plugin = createPlugin(app);
        await plugin.onload();
    });

    function arrange() {
        const groupA = new MockWorkspaceParent(mainContainer);
        const groupB = new MockWorkspaceParent(mainContainer);
        const groupC = new MockWorkspaceParent(popContainer);
        setRect(groupA, 0, 0);
        setRect(groupB, 200, 0);
        setRect(groupC, 0, 0);
        const a1 = leaf('main-a1', 'A1.md', groupA, mainContainer);
        const a2 = leaf('main-a2', 'A2.md', groupA, mainContainer);
        const b1 = leaf('main-b1', 'B1.md', groupB, mainContainer);
        const c1 = leaf('popup-c1', 'C1.md', groupC, popContainer);
        const sidebar = leaf('sidebar', 'Files', groupA, mainContainer);
        (sidebar as unknown as { getRoot: () => unknown }).getRoot = () => app.workspace.leftSplit;
        app.workspace.allLeaves = [a1, a2, b1, c1, sidebar];
        return { groupA, groupB, groupC, a1, a2, b1, c1 };
    }

    it('carries the commons locations, current flags, directions and window decisions through unchanged', () => {
        const ar = arrange();
        const model = plugin.buildNavigationModel(asLeaf(ar.a1));
        const base = kit.buildNavigationModel(app as unknown as App, asLeaf(ar.a1), { recency: plugin.recency });

        expectSameItems(
            model.locations.map((l) => l.leaf),
            base.locations.map((l) => l.leaf),
        );
        expectSameItems(
            model.locations.map((l) => l.window),
            base.locations.map((l) => l.window),
        );
        expect(model.groups).toHaveLength(base.groups.length);
        for (const baseGroup of base.groups) {
            const group = model.groups.find((g) => g.group === baseGroup.group)!;
            expect(group.window).toBe(baseGroup.window);
            expectSameItems(group.leaves, baseGroup.leaves);
            expect(group.representative).toBe(baseGroup.representative);
            expect(group.direction).toBe(baseGroup.direction);
            expect(group.isCurrent).toBe(baseGroup.isCurrent);
            expect(group.isCurrentGroup).toBe(baseGroup.isCurrent);
        }
        for (const baseWindow of base.windows) {
            const info = model.windows.find((w) => w.window === baseWindow.window)!;
            expect(info.isMainWindow).toBe(baseWindow.isMain);
            expect(info.isCurrentWindow).toBe(baseWindow.isCurrent);
        }
        expect(model.tabs.map((t) => idOf(t.leaf)).sort()).toEqual(base.tabs.map((t) => idOf(t.leaf)).sort());
    });

    it('hands out the same decorated group objects from the groups, tabs and windows lists', () => {
        const ar = arrange();
        const model = plugin.buildNavigationModel(asLeaf(ar.a1));

        for (const tab of model.tabs) expect(model.groups).toContain(tab.group);
        for (const win of model.windows) for (const group of win.groups) expect(model.groups).toContain(group);
        expect(model.groups.every((g) => typeof g.label === 'string' && g.label.length > 0)).toBe(true);
    });

    it('labels the main window and numbers pop-outs from the commons decision', () => {
        const ar = arrange();
        const model = plugin.buildNavigationModel(asLeaf(ar.a1));
        const main = model.windows.find((w) => w.isMainWindow)!;
        const popout = model.windows.find((w) => !w.isMainWindow)!;

        expect(main.window).toBe(globalThis.window);
        expect(main.label).toMatch(/^Main window — /);
        expect(popout.label).toMatch(/^Pop-out 1 — /);
        expect(main.isCurrentWindow).toBe(true);
        expect(popout.isCurrentWindow).toBe(false);
    });

    it('keeps its own ordering: recency first, then label, for groups and windows', () => {
        const ar = arrange();
        const model = plugin.buildNavigationModel(asLeaf(ar.a1));

        expect(model.groups.map((g) => g.lastActive)).toEqual([0, 0, 0]);
        const labels = model.groups.map((g) => g.label);
        expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));

        setLastActive(plugin, 'popup-c1', 500);
        const recent = plugin.buildNavigationModel(asLeaf(ar.a1));
        expect(recent.groups[0].representative).toBe(asLeaf(ar.c1));
        expect(recent.windows[0].window).toBe(popContainer.win);
    });

    it.each([
        ['left', 0, 100, 'Left group'],
        ['right', 200, 100, 'Right group'],
        ['above', 100, 0, 'Group above'],
        ['below', 100, 200, 'Group below'],
    ] as const)('a group to the %s of the active group has that commons direction and label %s', (direction, x, y, label) => {
        const active = new MockWorkspaceParent(mainContainer);
        const other = new MockWorkspaceParent(mainContainer);
        setRect(active, 100, 100);
        setRect(other, x, y);
        const here = leaf('here', 'Here.md', active, mainContainer);
        const there = leaf('there', 'There.md', other, mainContainer);
        app.workspace.allLeaves = [here, there];

        const model = plugin.buildNavigationModel(asLeaf(here));
        const info = model.groups.find((g) => g.group === (other as unknown as WorkspaceParent))!;
        const activeInfo = model.groups.find((g) => g.group === (active as unknown as WorkspaceParent))!;

        expect(info.direction).toBe(direction);
        expect(info.relativeLabel).toBe(label);
        expect(info.label).toBe(`${label} — There.md · 1 tab`);
        expect(activeInfo.direction).toBeNull();
        expect(activeInfo.relativeLabel).toBeNull();
    });

    it('never gives a direction to a group in another window', () => {
        const ar = arrange();
        const model = plugin.buildNavigationModel(asLeaf(ar.a1));
        const popGroup = model.groups.find((g) => g.group === (ar.groupC as unknown as WorkspaceParent))!;

        expect(popGroup.direction).toBeNull();
        expect(popGroup.relativeLabel).toBeNull();
    });
});

describe('commons adoption: recency lives in LeafRecency', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;
    let group: MockWorkspaceParent;
    let a: MockWorkspaceLeaf;
    let b: MockWorkspaceLeaf;

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        app = new MockApp();
        container = new MockWorkspaceContainer('root', globalThis.window);
        group = new MockWorkspaceParent(container);
        a = leaf('a', 'A.md', group, container);
        b = leaf('b', 'B.md', group, container);
        app.workspace.allLeaves = [a, b];
        plugin = createPlugin(app);
        await plugin.onload();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('records each activated leaf with its time and orders the model by it', () => {
        vi.setSystemTime(1000);
        app.workspace.trigger('active-leaf-change', b);
        vi.setSystemTime(2000);
        app.workspace.trigger('active-leaf-change', a);

        expect(plugin.recency.get(asLeaf(a))).toBe(2000);
        expect(plugin.recency.get(asLeaf(b))).toBe(1000);

        const model = plugin.buildNavigationModel(asLeaf(a));
        expect(model.tabs.map((t) => idOf(t.leaf))).toEqual(['a', 'b']);
        expect(model.groups[0].representative).toBe(asLeaf(a));
        expect(model.groups[0].lastActive).toBe(2000);
    });

    it('does not record detached leaves or sidebar leaves', () => {
        const detached = leaf('gone', 'Gone.md', group, container);
        detached.detached = true;
        const sidebar = leaf('side', 'Files', group, container);
        (sidebar as unknown as { getRoot: () => unknown }).getRoot = () => app.workspace.leftSplit;

        app.workspace.trigger('active-leaf-change', detached);
        app.workspace.trigger('active-leaf-change', sidebar);
        app.workspace.trigger('active-leaf-change', null);

        expect(plugin.recency.size).toBe(0);
    });

    it('drops recency of leaves that no longer exist once more than 200 are tracked', () => {
        for (let i = 0; i < 250; i++) setLastActive(plugin, `dead-${i}`, i + 1);
        expect(plugin.recency.size).toBe(250);

        app.workspace.trigger('active-leaf-change', a);

        expect(plugin.recency.size).toBe(1);
        expect(plugin.recency.get(asLeaf(a))).toBeGreaterThan(0);
    });

    it('keeps recency of leaves that still exist when pruning', () => {
        setLastActive(plugin, 'b', 77);
        for (let i = 0; i < 250; i++) setLastActive(plugin, `dead-${i}`, i + 1);

        app.workspace.trigger('active-leaf-change', a);

        expect(plugin.recency.size).toBe(2);
        expect(plugin.recency.get(asLeaf(b))).toBe(77);
    });
});

describe('commons adoption: the dedupe confirmation names groups from the model direction', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;

    beforeEach(async () => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', {} as Window);
        plugin = createPlugin(app);
        await plugin.onload();
        plugin.settings.confirmDedupeAllGroups = true;
        plugin.askConfirmation = vi.fn().mockResolvedValue(false);
    });

    async function confirmationText(): Promise<string> {
        await plugin.dedupeInAllGroups();
        const call = (plugin.askConfirmation as unknown as { mock: { calls: [string, HTMLElement][] } }).mock
            .calls[0];
        return call[1].textContent ?? '';
    }

    it.each([
        ['right', 200, 100, '1 in right group (current window)'],
        ['left', 0, 100, '1 in left group (current window)'],
        ['below', 100, 200, '1 in group below (current window)'],
        ['above', 100, 0, '1 in group above (current window)'],
    ] as const)('says a duplicate in the %s group is in the %s group', async (_name, x, y, expected) => {
        const active = new MockWorkspaceParent(container);
        const other = new MockWorkspaceParent(container);
        setRect(active, 100, 100);
        setRect(other, x, y);
        const keep = leaf('keep', 'Note.md', active, container);
        const dup = leaf('dup', 'Note.md', other, container);
        app.workspace.allLeaves = [keep, dup];
        app.workspace.setActiveLeaf(keep);

        expect(await confirmationText()).toContain(expected);
    });

    it('says another group when the neighbouring group has no known rectangle', async () => {
        const active = new MockWorkspaceParent(container);
        const other = new MockWorkspaceParent(container);
        setRect(active, 100, 100);
        setRect(other, 0, 0, 0, 0);
        const keep = leaf('keep', 'Note.md', active, container);
        const dup = leaf('dup', 'Note.md', other, container);
        app.workspace.allLeaves = [keep, dup];
        app.workspace.setActiveLeaf(keep);

        expect(await confirmationText()).toContain('1 in another group (current window)');
    });

    it('says the current group for a duplicate beside the active tab', async () => {
        const active = new MockWorkspaceParent(container);
        const keep = leaf('keep', 'Note.md', active, container);
        const dup = leaf('dup', 'Note.md', active, container);
        app.workspace.allLeaves = [keep, dup];
        app.workspace.setActiveLeaf(keep);

        expect(await confirmationText()).toContain('1 in current group (current window)');
    });

    it('counts a duplicate in a pop-out as another window, not a direction', async () => {
        const popContainer = new MockWorkspaceContainer('window', {} as Window);
        const active = new MockWorkspaceParent(container);
        const popGroup = new MockWorkspaceParent(popContainer);
        const keep = leaf('keep', 'Note.md', active, container);
        const dup = leaf('dup', 'Note.md', popGroup, popContainer);
        app.workspace.allLeaves = [keep, dup];
        app.workspace.setActiveLeaf(keep);
        plugin.settings.confirmDedupeAllWindows = true;

        await plugin.dedupeInAllWindows();
        const call = (plugin.askConfirmation as unknown as { mock: { calls: [string, HTMLElement][] } }).mock
            .calls[0];

        expect(call[1].textContent).toContain('1 in 1 other window');
    });
});
