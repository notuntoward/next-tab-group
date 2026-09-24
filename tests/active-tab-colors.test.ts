import { describe, it, expect, beforeEach } from 'vitest';
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

describe('onunload', () => {
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

        plugin.applyActiveTabColors();
    });

    it('removes the marker class and CSS variables on unload', () => {
        expect(document.body.classList.contains('ntg-color-active-tab')).toBe(true);

        plugin.onunload();

        expect(document.body.classList.contains('ntg-color-active-tab')).toBe(false);
        expect(document.body.style.getPropertyValue('--ntg-active-tab-color-light')).toBe('');
        expect(document.body.style.getPropertyValue('--ntg-active-tab-color-dark')).toBe('');
    });
});