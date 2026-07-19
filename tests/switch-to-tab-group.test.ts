import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf, WorkspaceParent } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
    MockFuzzySuggestModal,
} from './mocks/obsidian';

type TestPlugin = NextTabGroupPlugin & {
    switchToTabGroup: () => void;
    activateTabGroup: (group: WorkspaceParent, fallbackLeaf: WorkspaceLeaf) => void;
    buildTabGroupInfos: (leaves: WorkspaceLeaf[], activeLeaf: WorkspaceLeaf | null) => TabGroupInfo[];
    tabGroupActiveLeaves: Map<WorkspaceParent, WorkspaceLeaf>;
};

interface TabGroupInfo {
    group: WorkspaceParent;
    leaves: WorkspaceLeaf[];
    representative: WorkspaceLeaf;
    lastActive: number;
    label: string;
    relativeLabel: string | null;
    isCurrentGroup: boolean;
    window: Window | undefined;
}

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

function leaf(
    id: string,
    file: string,
    parent: MockWorkspaceParent,
    container: MockWorkspaceContainer | null = null
): MockWorkspaceLeaf {
    const l = new MockWorkspaceLeaf(file).setId(id).setParent(parent);
    if (container) l.setContainer(container);
    return l;
}

function asLeaf(leaf: MockWorkspaceLeaf): WorkspaceLeaf {
    return leaf as unknown as WorkspaceLeaf;
}

interface LeafLocation {
    leaf: WorkspaceLeaf;
    window: Window | undefined;
    group: MockWorkspaceParent | null;
}

function loc(leaf: MockWorkspaceLeaf): LeafLocation {
    const container = leaf.getContainer() as unknown as { win?: Window } | null;
    return {
        leaf: leaf as unknown as WorkspaceLeaf,
        window: container?.win,
        group: (leaf.parent as MockWorkspaceParent) ?? null,
    };
}

describe('switchToTabGroup', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;
    let group1: MockWorkspaceParent;
    let group2: MockWorkspaceParent;

    beforeEach(() => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', {} as Window);
        group1 = new MockWorkspaceParent(container);
        group2 = new MockWorkspaceParent(container);
        plugin = createPlugin(app);
    });

    it('one picker item appears per distinct group', () => {
        const a1 = leaf('a1', 'A.md', group1, container);
        const a2 = leaf('a2', 'A2.md', group1, container);
        const b1 = leaf('b1', 'B.md', group2, container);

        app.workspace.rootLeaves = [a1, a2, b1];
        app.workspace.allLeaves = [a1, a2, b1];
        app.workspace.setActiveLeaf(a1);

        let captured: MockFuzzySuggestModal<TabGroupInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<TabGroupInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToTabGroup();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        expect(captured).toBeDefined();
        expect(captured!.getItems()).toHaveLength(2);
    });

    it('groups sort by the most-recent activity of their representative', () => {
        const a1 = leaf('a1', 'A.md', group1, container);
        const a2 = leaf('a2', 'A2.md', group1, container);
        const b1 = leaf('b1', 'B.md', group2, container);
        const b2 = leaf('b2', 'B2.md', group2, container);
        plugin.leafLastActive.set('a1', 100);
        plugin.leafLastActive.set('a2', 200);
        plugin.leafLastActive.set('b1', 300);
        plugin.leafLastActive.set('b2', 400);

        app.workspace.rootLeaves = [a1, a2, b1, b2];
        app.workspace.allLeaves = [a1, a2, b1, b2];
        app.workspace.setActiveLeaf(a1);

        let captured: MockFuzzySuggestModal<TabGroupInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<TabGroupInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToTabGroup();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        const items = captured!.getItems();
        expect(items[0].group).toBe(group2);
        expect(items[1].group).toBe(group1);
    });

    it('selecting a group focuses its stored last-active leaf when valid', () => {
        const a1 = leaf('a1', 'A.md', group1, container);
        const a2 = leaf('a2', 'A2.md', group1, container);
        const b1 = leaf('b1', 'B.md', group2, container);

        app.workspace.rootLeaves = [a1, a2, b1];
        app.workspace.allLeaves = [a1, a2, b1];
        app.workspace.setActiveLeaf(a1);

        plugin.tabGroupActiveLeaves.set(group1, a2);

        let captured: MockFuzzySuggestModal<TabGroupInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<TabGroupInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToTabGroup();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        const items = captured!.getItems();
        const group1Item = items.find((g) => g.group === group1)!;
        captured!.onChooseItem(group1Item);
        expect(app.workspace.activeLeaf).toBe(a2);
    });

    it('if stored leaf is absent or no longer belongs to that group, it focuses the group representative', () => {
        const a1 = leaf('a1', 'A.md', group1, container);
        const a2 = leaf('a2', 'A2.md', group1, container);
        const b1 = leaf('b1', 'B.md', group2, container);

        app.workspace.rootLeaves = [a1, a2, b1];
        app.workspace.allLeaves = [a1, a2, b1];
        app.workspace.setActiveLeaf(a1);

        // Store a leaf that no longer belongs to group1
        const orphan = leaf('orphan', 'Orphan.md', group2, container);
        plugin.tabGroupActiveLeaves.set(group1, orphan);

        let captured: MockFuzzySuggestModal<TabGroupInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<TabGroupInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToTabGroup();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        const items = captured!.getItems();
        const group1Item = items.find((g) => g.group === group1)!;
        captured!.onChooseItem(group1Item);
        expect(app.workspace.activeLeaf).toBe(a2);
    });

    it('the label used here is exactly the label used by TabInfo.group', () => {
        const a1 = leaf('a1', 'A.md', group1, container);
        const a2 = leaf('a2', 'A2.md', group1, container);
        const b1 = leaf('b1', 'B.md', group2, container);

        app.workspace.rootLeaves = [a1, a2, b1];
        app.workspace.allLeaves = [a1, a2, b1];
        app.workspace.setActiveLeaf(a1);

        const groups = plugin.buildTabGroupInfos([loc(a1), loc(a2), loc(b1)], asLeaf(a1));

        let captured: MockFuzzySuggestModal<TabGroupInfo> | undefined;
        const originalOpen = MockFuzzySuggestModal.prototype.open;
        MockFuzzySuggestModal.prototype.open = function (this: MockFuzzySuggestModal<TabGroupInfo>) {
            captured = this;
            return originalOpen.call(this);
        };

        plugin.switchToTabGroup();

        MockFuzzySuggestModal.prototype.open = originalOpen;

        const items = captured!.getItems();
        const group1Item = items.find((g) => g.group === group1)!;
        const group2Item = items.find((g) => g.group === group2)!;
        expect(group1Item.label).toBe(groups.find((g) => g.group === group1)!.label);
        expect(group2Item.label).toBe(groups.find((g) => g.group === group2)!.label);
    });
});
