import { describe, expect, it, vi } from 'vitest';
import NextTabGroupPlugin, { NextTabGroupSettingTab } from '../main.ts';
import { MockApp } from './mocks/obsidian';

describe('NextTabGroupSettingTab getSettingDefinitions', () => {
    it('returns declarative setting definitions grouped into three sections', async () => {
        const app = new MockApp();
        const plugin = new NextTabGroupPlugin(app as any, {} as any);
        await plugin.onload();
        const settingTab = (plugin as any).settingTab as NextTabGroupSettingTab;

        expect(settingTab).toBeDefined();
        const definitions = settingTab.getSettingDefinitions();

        expect(definitions).toHaveLength(3);
        expect(definitions[0].heading).toBe('Deduplicate tabs');
        expect(definitions[1].heading).toBe('Switch tabs');
        expect(definitions[2].heading).toBe('Active tab color');
    });

    it('defines expected controls for deduplicate and switch tabs sections', () => {
        const app = new MockApp();
        const plugin = new NextTabGroupPlugin(app as any, {} as any);
        const settingTab = new NextTabGroupSettingTab(app as any, plugin);
        const definitions = settingTab.getSettingDefinitions();

        const dedupeItems = definitions[0].items;
        expect(dedupeItems).toHaveLength(3);
        expect(dedupeItems[0].control.key).toBe('confirmDedupeGroup');
        expect(dedupeItems[0].control.type).toBe('toggle');
        expect(dedupeItems[1].control.key).toBe('confirmDedupeAllGroups');
        expect(dedupeItems[1].control.type).toBe('toggle');
        expect(dedupeItems[2].control.key).toBe('confirmDedupeAllWindows');
        expect(dedupeItems[2].control.type).toBe('toggle');

        const switchItems = definitions[1].items;
        expect(switchItems).toHaveLength(1);
        expect(switchItems[0].control.key).toBe('groupSwitchByContext');
        expect(switchItems[0].control.type).toBe('toggle');
    });

    it('handles active tab color visibility predicate and onChange callbacks', () => {
        const app = new MockApp();
        const plugin = new NextTabGroupPlugin(app as any, {} as any);
        const applySpy = vi.spyOn(plugin, 'applyActiveTabColors').mockImplementation(() => {});

        const settingTab = new NextTabGroupSettingTab(app as any, plugin);
        const definitions = settingTab.getSettingDefinitions();

        const colorGroup = definitions[2];
        const colorItems = colorGroup.items;
        expect(colorItems).toHaveLength(3);

        const enableToggle = colorItems[0];
        const lightPicker = colorItems[1];
        const darkPicker = colorItems[2];

        expect(enableToggle.control.key).toBe('colorActiveTabEnabled');
        expect(enableToggle.control.type).toBe('toggle');

        expect(lightPicker.control.key).toBe('activeTabColorLight');
        expect(lightPicker.control.type).toBe('color');

        expect(darkPicker.control.key).toBe('activeTabColorDark');
        expect(darkPicker.control.type).toBe('color');

        // Test visibility logic
        plugin.settings.colorActiveTabEnabled = false;
        expect(lightPicker.visible()).toBe(false);
        expect(darkPicker.visible()).toBe(false);

        plugin.settings.colorActiveTabEnabled = true;
        expect(lightPicker.visible()).toBe(true);
        expect(darkPicker.visible()).toBe(true);

        // Test onChange callbacks
        enableToggle.control.onChange();
        expect(applySpy).toHaveBeenCalledTimes(1);

        lightPicker.control.onChange();
        expect(applySpy).toHaveBeenCalledTimes(2);

        darkPicker.control.onChange();
        expect(applySpy).toHaveBeenCalledTimes(3);
    });
});
