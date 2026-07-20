import { describe, it, expect, beforeEach } from 'vitest';
import type { App, WorkspaceLeaf, WorkspaceParent } from 'obsidian';
import NextTabGroupPlugin from '../main.ts';
import {
    MockApp,
    MockWorkspaceContainer,
    MockWorkspaceLeaf,
    MockWorkspaceParent,
} from './mocks/obsidian';

type TestPlugin = NextTabGroupPlugin & {
    buildTopology: (
        locations: LeafLocation[],
        model: WorkspaceNavigationModel,
    ) => void;
    buildNavigationModel: (activeLeaf: WorkspaceLeaf | null) => WorkspaceNavigationModel;
};

interface LeafLocation {
    leaf: WorkspaceLeaf;
    window: Window | undefined;
    group: WorkspaceParent | null;
}

interface SplitNodeInfo {
    id: string;
    direction: 'horizontal' | 'vertical';
    parentSplitId: string | null;
    childIds: string[];
}

interface WorkspaceNavigationModel {
    locations: LeafLocation[];
    windows: unknown[];
    groups: unknown[];
    tabs: unknown[];
    splits: Map<string, SplitNodeInfo>;
    groupToSplitMap: Map<WorkspaceParent, string>;
}

function createPlugin(app: MockApp): TestPlugin {
    return new NextTabGroupPlugin(app as unknown as App, { dir: '' } as never) as unknown as TestPlugin;
}

/**
 * Build a live Object graph resembling Obsidian's real hierarchy:
 *   WorkspaceTabs (group) -> WorkspaceSplit -> ... -> root
 * Each node carries a `type`, `direction`, `parent`, and `children` so
 * `buildTopology` can walk it without any JSON serialization.
 */
function makeSplit(direction: 'horizontal' | 'vertical'): any {
    return { type: 'split', direction, parent: null, children: [] };
}

function makeGroup(): any {
    return { type: 'tabs', parent: null, children: [] };
}

function makeLeaf(parent: any): any {
    const leaf = new MockWorkspaceLeaf(null);
    (leaf as unknown as { parent: unknown }).parent = parent;
    return leaf;
}

function loc(leaf: any): LeafLocation {
    const container = leaf.getContainer?.() as { win?: Window } | null;
    return {
        leaf: leaf as unknown as WorkspaceLeaf,
        window: container?.win,
        group: (leaf.parent as MockWorkspaceParent) ?? null,
    };
}

describe('topology graph (live-object)', () => {
    let app: MockApp;
    let plugin: TestPlugin;
    let container: MockWorkspaceContainer;

    beforeEach(() => {
        app = new MockApp();
        container = new MockWorkspaceContainer('root', {} as Window);
        plugin = createPlugin(app);
    });

    it('maps a single tier vertical split wrapping a tab group', () => {
        const split = makeSplit('vertical');
        const group = makeGroup();
        split.children.push(group);
        group.parent = split;
        const leaf = makeLeaf(group);

        const model: WorkspaceNavigationModel = {
            locations: [],
            windows: [],
            groups: [],
            tabs: [],
            splits: new Map(),
            groupToSplitMap: new Map(),
        };

        plugin.buildTopology([loc(leaf)], model);

        const splitId = model.groupToSplitMap.get(group);
        expect(splitId).toBeDefined();
        const node = model.splits.get(splitId!);
        expect(node).toBeDefined();
        expect(node!.direction).toBe('vertical');
        expect(node!.parentSplitId).toBeNull();
        expect(node!.childIds).toContain(group._ntg_id);
    });

    it('assigns stable ids so the same split is recorded once', () => {
        const split = makeSplit('horizontal');
        const groupA = makeGroup();
        const groupB = makeGroup();
        split.children.push(groupA, groupB);
        groupA.parent = split;
        groupB.parent = split;
        const leafA = makeLeaf(groupA);
        const leafB = makeLeaf(groupB);

        const model: WorkspaceNavigationModel = {
            locations: [],
            windows: [],
            groups: [],
            tabs: [],
            splits: new Map(),
            groupToSplitMap: new Map(),
        };

        plugin.buildTopology([loc(leafA), loc(leafB)], model);

        expect(model.splits.size).toBe(1);
        expect(model.groupToSplitMap.get(groupA)).toBe(model.groupToSplitMap.get(groupB));
        expect(model.groupToSplitMap.get(groupA)).toBe(split._ntg_id);
    });

    it('bubbles up nested splits and records parent links', () => {
        const root = makeSplit('horizontal');
        const mid = makeSplit('vertical');
        const group = makeGroup();
        root.children.push(mid);
        mid.parent = root;
        mid.children.push(group);
        group.parent = mid;
        const leaf = makeLeaf(group);

        const model: WorkspaceNavigationModel = {
            locations: [],
            windows: [],
            groups: [],
            tabs: [],
            splits: new Map(),
            groupToSplitMap: new Map(),
        };

        plugin.buildTopology([loc(leaf)], model);

        expect(model.splits.size).toBe(2);

        const midId = model.groupToSplitMap.get(group)!;
        expect(midId).toBe(mid._ntg_id);

        const midNode = model.splits.get(midId)!;
        expect(midNode.parentSplitId).toBe(root._ntg_id);

        const rootNode = model.splits.get(root._ntg_id)!;
        expect(rootNode.parentSplitId).toBeNull();
        expect(rootNode.childIds).toContain(mid._ntg_id);
    });

    it('buildNavigationModel populates topology alongside the canonical model', () => {
        const split = makeSplit('vertical');
        const group = makeGroup();
        split.children.push(group);
        group.parent = split;
        const leaf = makeLeaf(group);
        leaf.setId('only');
        app.workspace.allLeaves = [leaf];

        const model = plugin.buildNavigationModel(leaf as unknown as WorkspaceLeaf);

        expect(model.splits.size).toBe(1);
        expect(model.groupToSplitMap.size).toBe(1);
        const splitNode = model.splits.get(model.groupToSplitMap.get(group)!);
        expect(splitNode?.direction).toBe('vertical');
    });

    it('records nothing when a group has no enclosing split', () => {
        const group = makeGroup();
        const leaf = makeLeaf(group);
        const model: WorkspaceNavigationModel = {
            locations: [],
            windows: [],
            groups: [],
            tabs: [],
            splits: new Map(),
            groupToSplitMap: new Map(),
        };

        plugin.buildTopology([loc(leaf)], model);

        expect(model.splits.size).toBe(0);
        expect(model.groupToSplitMap.has(group)).toBe(false);
    });
});
