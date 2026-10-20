import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { App } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import { MockApp, MockWorkspaceLeaf, MockWorkspaceContainer, MockWorkspaceParent } from './mocks/obsidian';

function createPlugin(app: MockApp): NextTabGroupPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as NextTabGroupPlugin;
}

describe('applyActiveTabColors', () => {
    let app: MockApp;
    let plugin: NextTabGroupPlugin;
    let container: MockWorkspaceContainer;

    beforeEach(async () => {
        document.body.className = '';
        document.body.style.cssText = '';
        app = new MockApp();
        container = new MockWorkspaceContainer('root', globalThis.window);
        plugin = createPlugin(app);
        plugin.settings = {
            colorActiveTabEnabled: true,
            activeTabColorLight: '#test-light',
            activeTabColorDark: '#test-dark',
        } as NextTabGroupPlugin['settings'];
    });

    it('adds the marker class and CSS variables when enabled', () => {
        const leaf = new MockWorkspaceLeaf(null).setId('leaf_0');
        leaf.setContainer(container);
        app.workspace.allLeaves = [leaf];
        app.workspace.rootLeaves = [leaf];

        plugin.applyActiveTabColors();

        expect(document.body.classList.contains('ntg-color-active-tab')).toBe(true);
        expect(document.body.style.getPropertyValue('--ntg-active-tab-color-light')).toBe('#test-light');
        expect(document.body.style.getPropertyValue('--ntg-active-tab-color-dark')).toBe('#test-dark');
    });

    it('removes the marker class when disabled', () => {
        document.body.classList.add('ntg-color-active-tab');
        plugin.settings = {
            colorActiveTabEnabled: false,
            activeTabColorLight: '#test-light',
            activeTabColorDark: '#test-dark',
        } as NextTabGroupPlugin['settings'];

        plugin.applyActiveTabColors();

        expect(document.body.classList.contains('ntg-color-active-tab')).toBe(false);
    });

    it('sets CSS variables even when the marker class is removed', () => {
        document.body.classList.add('ntg-color-active-tab');
        plugin.settings = {
            colorActiveTabEnabled: false,
            activeTabColorLight: '#test-light',
            activeTabColorDark: '#test-dark',
        } as NextTabGroupPlugin['settings'];

        plugin.applyActiveTabColors();

        expect(document.body.style.getPropertyValue('--ntg-active-tab-color-light')).toBe('#test-light');
        expect(document.body.style.getPropertyValue('--ntg-active-tab-color-dark')).toBe('#test-dark');
    });

    it('applies colors to pop-out windows in addition to the main window', () => {
        const popoutWin = { ...globalThis.window, document: { body: globalThis.document.body } } as unknown as Window;
        const leaf = new MockWorkspaceLeaf(null).setId('leaf_0');
        leaf.setContainer(new MockWorkspaceContainer('root', popoutWin));
        app.workspace.allLeaves = [leaf];
        app.workspace.rootLeaves = [leaf];

        plugin.applyActiveTabColors();

        expect(document.body.classList.contains('ntg-color-active-tab')).toBe(true);
    });

    it('applies colors to newly opened windows via window-open event', async () => {
        await plugin.onload();

        const newBody = document.createElement('body');
        const newWin = {
            closed: false,
            document: { body: newBody },
        } as unknown as Window;

        app.workspace.trigger('window-open', null, newWin);

        expect(newBody.classList.contains('ntg-color-active-tab')).toBe(true);
        expect(newBody.style.getPropertyValue('--ntg-active-tab-color-light')).toBe('#test-light');
        expect(newBody.style.getPropertyValue('--ntg-active-tab-color-dark')).toBe('#test-dark');
    });

    it('safely skips closed windows and does not throw', () => {
        const closedWin = {
            closed: true,
            get document(): any {
                throw new Error('Access denied to closed window');
            },
        } as unknown as Window;

        const leaf = new MockWorkspaceLeaf(null).setId('leaf_closed');
        leaf.setContainer(new MockWorkspaceContainer('root', closedWin));
        app.workspace.allLeaves = [leaf];

        expect(() => plugin.applyActiveTabColors()).not.toThrow();
    });
});

function popoutWindow(): { win: Window; doc: Document } {
    const doc = document.implementation.createHTMLDocument('pop-out');
    return { win: { closed: false, document: doc } as unknown as Window, doc };
}

function leafIn(container: MockWorkspaceContainer, id: string): MockWorkspaceLeaf {
    const leaf = new MockWorkspaceLeaf(null).setId(id);
    leaf.setContainer(container);
    return leaf;
}

const colored = (doc: Document) => doc.body.classList.contains('ntg-color-active-tab');
const lightVar = (doc: Document) => doc.body.style.getPropertyValue('--ntg-active-tab-color-light');
const darkVar = (doc: Document) => doc.body.style.getPropertyValue('--ntg-active-tab-color-dark');

describe('active-tab colors follow every window (forEachWindow)', () => {
    let app: MockApp;
    let plugin: NextTabGroupPlugin;
    let mainContainer: MockWorkspaceContainer;

    beforeEach(() => {
        document.body.className = '';
        document.body.style.cssText = '';
        app = new MockApp();
        mainContainer = new MockWorkspaceContainer('root', globalThis.window);
        plugin = createPlugin(app);
        plugin.settings = {
            colorActiveTabEnabled: true,
            activeTabColorLight: '#test-light',
            activeTabColorDark: '#test-dark',
        } as NextTabGroupPlugin['settings'];
    });

    it('colors the own document of a pop-out that exists when the plugin loads, and the main document', async () => {
        const { win, doc } = popoutWindow();
        app.workspace.allLeaves = [leafIn(mainContainer, 'main'), leafIn(new MockWorkspaceContainer('window', win), 'pop')];

        await plugin.onload();

        expect(colored(doc)).toBe(true);
        expect(lightVar(doc)).toBe('#test-light');
        expect(darkVar(doc)).toBe('#test-dark');
        expect(colored(document)).toBe(true);
    });

    it('colors a pop-out opened later in its own document and never touches the main document', async () => {
        await plugin.onload();
        document.body.className = '';
        document.body.style.cssText = '';
        const { win, doc } = popoutWindow();

        app.workspace.trigger('window-open', null, win);

        expect(colored(doc)).toBe(true);
        expect(lightVar(doc)).toBe('#test-light');
        expect(darkVar(doc)).toBe('#test-dark');
        expect(colored(document)).toBe(false);
        expect(lightVar(document)).toBe('');
    });

    it('sets a window up once even when window-open repeats for it', async () => {
        await plugin.onload();
        const { win, doc } = popoutWindow();
        const toggle = vi.spyOn(doc.body.classList, 'toggle');

        app.workspace.trigger('window-open', null, win);
        app.workspace.trigger('window-open', null, win);

        expect(toggle).toHaveBeenCalledTimes(1);
    });

    it('removes the colors from a pop-out document when it closes and leaves other windows colored', async () => {
        await plugin.onload();
        const { win, doc } = popoutWindow();
        app.workspace.trigger('window-open', null, win);
        expect(colored(doc)).toBe(true);

        app.workspace.trigger('window-close', null, win);

        expect(colored(doc)).toBe(false);
        expect(lightVar(doc)).toBe('');
        expect(darkVar(doc)).toBe('');
        expect(colored(document)).toBe(true);
    });

    it('removes the colors from every window document, including a pop-out with no editor leaf, on unload', async () => {
        app.workspace.allLeaves = [leafIn(mainContainer, 'main')];
        await plugin.onload();
        const { win, doc } = popoutWindow();
        app.workspace.trigger('window-open', null, win);
        expect(colored(doc)).toBe(true);
        expect(colored(document)).toBe(true);

        (plugin as unknown as { unload: () => void }).unload();

        expect(colored(doc)).toBe(false);
        expect(lightVar(doc)).toBe('');
        expect(colored(document)).toBe(false);
        expect(lightVar(document)).toBe('');
    });

    it('recolors the document of every open window when the colors change', async () => {
        const { win, doc } = popoutWindow();
        app.workspace.allLeaves = [leafIn(mainContainer, 'main'), leafIn(new MockWorkspaceContainer('window', win), 'pop')];
        await plugin.onload();

        plugin.settings.activeTabColorLight = '#changed-light';
        plugin.settings.colorActiveTabEnabled = false;
        plugin.applyActiveTabColors();

        expect(lightVar(doc)).toBe('#changed-light');
        expect(lightVar(document)).toBe('#changed-light');
        expect(colored(doc)).toBe(false);
        expect(colored(document)).toBe(false);
    });

    it('skips a window that is already closed when announced, without throwing', async () => {
        await plugin.onload();
        const closedWin = {
            closed: true,
            get document(): never {
                throw new Error('Access denied to closed window');
            },
        } as unknown as Window;

        expect(() => app.workspace.trigger('window-open', null, closedWin)).not.toThrow();
    });
});

describe('unload', () => {
    let app: MockApp;
    let plugin: NextTabGroupPlugin;
    let container: MockWorkspaceContainer;

    beforeEach(async () => {
        document.body.className = '';
        document.body.style.cssText = '';
        app = new MockApp();
        container = new MockWorkspaceContainer('root', globalThis.window);
        plugin = createPlugin(app);
        plugin.settings = {
            colorActiveTabEnabled: true,
            activeTabColorLight: '#test-light',
            activeTabColorDark: '#test-dark',
        } as NextTabGroupPlugin['settings'];

        const leaf = new MockWorkspaceLeaf(null).setId('leaf_0');
        leaf.setContainer(container);
        app.workspace.allLeaves = [leaf];
        app.workspace.rootLeaves = [leaf];

        await plugin.onload();
    });

    it('removes the marker class and CSS variables on unload', () => {
        expect(document.body.classList.contains('ntg-color-active-tab')).toBe(true);

        (plugin as unknown as { unload: () => void }).unload();

        expect(document.body.classList.contains('ntg-color-active-tab')).toBe(false);
        expect(document.body.style.getPropertyValue('--ntg-active-tab-color-light')).toBe('');
        expect(document.body.style.getPropertyValue('--ntg-active-tab-color-dark')).toBe('');
    });
});