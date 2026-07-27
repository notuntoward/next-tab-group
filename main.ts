import {
    FuzzySuggestModal,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    WorkspaceLeaf,
} from 'obsidian';
import type { App, Workspace, WorkspaceParent } from 'obsidian';
import { updateElementPathDatasets } from './src/utils/dom';
import { registerEmacsMotionKeys, mapFuzzyMatchesToDisplayText } from './src/utils/modal';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface NextTabGroupSettings {
    confirmDedupeGroup: boolean;
    confirmDedupeAllGroups: boolean;
    confirmDedupeAllWindows: boolean;
    groupSwitchByContext: boolean;
    colorActiveTabEnabled: boolean;
    activeTabColorLight: string;
    activeTabColorDark: string;
}

const DEFAULT_SETTINGS: NextTabGroupSettings = {
    confirmDedupeGroup: false,
    confirmDedupeAllGroups: true,
    confirmDedupeAllWindows: true,
    // When true, "switch to any tab" / "switch to tab group" cluster results by
    // window then tab group (current behavior). When false, everything is
    // sorted by pure recency instead.
    groupSwitchByContext: true,
    colorActiveTabEnabled: false,
    activeTabColorLight: "#e0edff",
    activeTabColorDark: "#33415c",
};

// ---------------------------------------------------------------------------
// Internal Obsidian structures not exposed in the public API
// ---------------------------------------------------------------------------

interface WorkspaceLeafInternal extends WorkspaceLeaf {
    id: string;
}

interface WorkspaceContainerEl extends WorkspaceParent {
    containerEl: HTMLElement;
    direction?: string;
    children?: WorkspaceContainerEl[];
}

interface WorkspaceItemInternal {
    workspace?: Workspace;
}

/**
 * A serializable snapshot of a split's position in the live-object topology
 * graph. `childIds` may contain ids of both nested splits and tab groups.
 */
interface SplitNodeInfo {
    id: string;
    direction: 'horizontal' | 'vertical';
    parentSplitId: string | null;
    childIds: string[];
    // Retained reference to the live Obsidian split object so layout commands
    // can mutate its orientation in place instead of tearing down the tree.
    liveSplit?: unknown;
}

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

interface TabInfo {
    leaf: WorkspaceLeaf;
    group: TabGroupInfo;
    lastActive: number;
}

interface WindowInfo {
    window: Window | undefined;
    groups: TabGroupInfo[];
    representative: WorkspaceLeaf;
    lastActive: number;
    label: string;
    isCurrentWindow: boolean;
}

// ---------------------------------------------------------------------------
// Canonical workspace navigation model
//
// Every editor leaf is represented as a location that knows both its real
// native window and its parent group. Tab groups are always built from leaves
// that share both, so a group's identity is conceptually (window, parent).
// ---------------------------------------------------------------------------

interface LeafLocation {
    leaf: WorkspaceLeaf;
    window: Window | undefined;
    group: WorkspaceParent | null;
}

interface WorkspaceNavigationModel {
    locations: LeafLocation[];
    windows: WindowInfo[];
    groups: TabGroupInfo[];
    tabs: TabInfo[];

    // Live-object topology graph: a map of split id -> split node info, and a
    // map from each tab group's `WorkspaceParent` to the id of the split that
    // directly contains it. Lets layout commands reason about split directions
    // and nesting without going through the destructive `getLayout`/`setLayout`.
    splits: Map<string, SplitNodeInfo>;
    groupToSplitMap: Map<WorkspaceParent, string>;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface FuzzyMatch<T> {
    item: T;
    match: {
        score: number;
        matches: number[][];
    };
}

/**
 * Helper utility to break a string down by matching index pairs
 * and render bolded/highlighted HTML elements natively.
 */
export function renderHighlightedText(parentEl: HTMLElement, text: string, matches: number[][]): void {
    if (!matches || matches.length === 0) {
        parentEl.setText(text);
        return;
    }

    let lastIndex = 0;
    for (const [start, end] of matches) {
        // Append unmatched prefix string segment
        if (start > lastIndex) {
            parentEl.createSpan().setText(text.slice(lastIndex, start));
        }
        // Append highlighted match segment
        const highlightSpan = parentEl.createSpan({ cls: 'suggestion-highlight' });
        highlightSpan.setText(text.slice(start, end));

        lastIndex = end;
    }

    // Append trailing leftover text segment
    if (lastIndex < text.length) {
        parentEl.createSpan().setText(text.slice(lastIndex));
    }
}

export default class NextTabGroupPlugin extends Plugin {
    private tabGroupActiveLeaves: Map<WorkspaceParent, WorkspaceLeaf> = new Map();
    private leafLastActive: Map<string, number> = new Map();
    settings: NextTabGroupSettings = { ...DEFAULT_SETTINGS };

    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.applyActiveTabColors();

        this.addCommand({
            id: 'next',
            // eslint-disable-next-line obsidianmd/commands/no-plugin-name-in-command-name
            name: 'Next tab group',
            callback: () => {
                this.cycleTabGroups();
            }
        });

        this.addCommand({
            id: 'collect-tabs',
            name: 'Collect tabs',
            callback: () => {
                this.collectTabs();
            }
        });

        this.addCommand({
            id: 'rotate-tab-groups',
            name: 'Rotate tab groups',
            callback: () => {
                this.rotateTabGroups();
            }
        });

        this.addCommand({
            id: 'dedupe-tabs-in-group',
            name: 'Deduplicate tabs in group',
            callback: () => {
                void this.dedupeInGroup();
            }
        });

        this.addCommand({
            id: 'dedupe-tabs-in-all-groups',
            name: 'Deduplicate tabs in all groups',
            callback: () => {
                void this.dedupeInAllGroups();
            }
        });

        this.addCommand({
            id: 'dedupe-tabs-in-all-windows',
            name: 'Deduplicate tabs in all windows',
            callback: () => {
                void this.dedupeInAllWindows();
            }
        });

        this.addCommand({
            id: 'switch-to-tab-in-group',
            name: 'Switch to tab in group',
            callback: () => {
                this.switchToTabInGroup();
            }
        });

        this.addCommand({
            id: 'switch-to-any-tab',
            name: 'Switch to any tab',
            callback: () => {
                this.switchToAnyTab();
            }
        });

        this.addCommand({
            id: 'switch-to-tab-group',
            name: 'Switch to tab group',
            callback: () => {
                this.switchToTabGroup();
            }
        });

        this.addCommand({
            id: 'switch-to-window',
            name: 'Switch to window',
            callback: () => {
                this.switchToWindow();
            }
        });

        this.addSettingTab(new NextTabGroupSettingTab(this.app, this));

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (!leaf) return;

                const internal = leaf as WorkspaceLeafInternal;
                if (internal.id) {
                    this.leafLastActive.set(internal.id, Date.now());
                }

                if (leaf.parent) {
                    this.tabGroupActiveLeaves.set(leaf.parent, leaf);
                }
            })
        );

        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                for (const [parent, leaf] of this.tabGroupActiveLeaves.entries()) {
                    if (!leaf.parent || leaf.parent !== parent) {
                        this.tabGroupActiveLeaves.delete(parent);
                    }
                }
                this.applyActiveTabColors();
            })
        );
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    onunload(): void {
        const windows = new Set<Window>();
        windows.add(window);
        this.app.workspace.iterateAllLeaves((leaf) => {
            const win = leaf.getContainer()?.win;
            if (win) windows.add(win);
        });
        for (const win of windows) {
            const body = win.document.body;
            body.classList.remove("ntg-color-active-tab");
            body.style.removeProperty("--ntg-active-tab-color-light");
            body.style.removeProperty("--ntg-active-tab-color-dark");
        }
    }

    /**
     * Pushes the configured active-tab colors onto every open window's body
     * element as CSS custom properties, and toggles the marker class so the
     * CSS rule only applies when the feature is enabled.
     */
    applyActiveTabColors(): void {
        const { colorActiveTabEnabled, activeTabColorLight, activeTabColorDark } = this.settings;

        const windows = new Set<Window>();
        windows.add(window);
        this.app.workspace.iterateAllLeaves((leaf) => {
            const win = leaf.getContainer()?.win;
            if (win) windows.add(win);
        });

        for (const win of windows) {
            const body = win.document.body;
            body.classList.toggle("ntg-color-active-tab", colorActiveTabEnabled);
            body.style.setProperty("--ntg-active-tab-color-light", activeTabColorLight);
            body.style.setProperty("--ntg-active-tab-color-dark", activeTabColorDark);
        }
    }

    /**
     * Activates a leaf and guarantees OS-level window focus.
     */
    private focusLeafAndWindow(leaf: WorkspaceLeaf): void {
        const targetWin = leaf.getContainer()?.win;
        this.app.workspace.setActiveLeaf(leaf, { focus: true });

        if (targetWin && targetWin !== activeWindow && typeof targetWin.focus === 'function') {
            targetWin.focus();
        }
    }

    // ------------------------------------------------------------------------
    // Window-aware helpers
    // ------------------------------------------------------------------------

    /**
     * Get the workspace for a leaf. Note: Obsidian has only one Workspace
     * instance (app.workspace) shared across all windows. This method exists
     * for API consistency but always returns app.workspace.
     */
    private getWorkspaceForLeaf(_leaf: WorkspaceLeaf): Workspace {
        return this.app.workspace;
    }

    /**
     * Get the active leaf in the currently focused window. Falls back to
     * app.workspace.activeLeaf when the focused window cannot be determined.
     *
     * TODO: In multi-window Obsidian states, app.workspace.activeLeaf can
     * describe a different native window than the focused command surface.
     * Commands must use the leaf's actual container window once resolved;
     * do not infer group/window membership from app.workspace.activeLeaf alone.
     */
    private getActiveLeafInFocusedWindow(): WorkspaceLeaf | null {
        const globalActive = this.app.workspace.activeLeaf;

        if (typeof activeWindow === 'undefined') {
            return globalActive;
        }

        if (globalActive) {
            const container = globalActive.getContainer();
            if (container && container.win === activeWindow) {
                return globalActive;
            }
        }

        let leafInFocusedWindow: WorkspaceLeaf | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leafInFocusedWindow) return;
            const container = leaf.getContainer();
            if (container && container.win === activeWindow) {
                leafInFocusedWindow = leaf;
            }
        });

        return leafInFocusedWindow ?? globalActive;
    }

    private getLeavesInFocusedWindow(): WorkspaceLeaf[] {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const focusedWin = activeLeaf?.getContainer()?.win;

        const leaves: WorkspaceLeaf[] = [];

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (!focusedWin || leaf.getContainer()?.win === focusedWin) {
                leaves.push(leaf);
            }
        });

        return leaves;
    }

    // ------------------------------------------------------------------------
    // Tab group discovery & navigation
    // ------------------------------------------------------------------------

    private getSpatiallySortedGroups(
        groups: TabGroupInfo[],
    ): TabGroupInfo[] {
        return [...groups].sort((a, b) => {
            const aRect = this.getTabGroupRect(a.group as WorkspaceContainerEl);
            const bRect = this.getTabGroupRect(b.group as WorkspaceContainerEl);

            if (aRect && bRect) {
                const yDiff = aRect.y - bRect.y;
                if (Math.abs(yDiff) > 50) {
                    return yDiff;
                }
                return aRect.x - bRect.x;
            }

            if (aRect) return -1;
            if (bRect) return 1;

            return a.label.localeCompare(b.label);
        });
    }

    private capitalizeFirst(value: string): string {
        return value.length === 0
            ? value
            : value.charAt(0).toUpperCase() + value.slice(1);
    }

    private formatTabGroupLabel(
        representative: WorkspaceLeaf,
        leafCount: number,
        isCurrentGroup: boolean,
        relativeLabel: string | null,
    ): string {
        const count = `${leafCount} tab${leafCount === 1 ? "" : "s"}`;
        const name = representative.getDisplayText() || "Untitled tab";

        let prefix: string | null = null;
        if (isCurrentGroup) {
            prefix = "Current group";
        } else if (relativeLabel) {
            prefix = relativeLabel;
        }

        return prefix ? `${prefix} — ${name} · ${count}` : `${name} · ${count}`;
    }

    /**
     * True when a leaf lives in the left or right sidebar (File Explorer,
     * Outline, Backlinks, etc.) rather than the main editor area. Such leaves
     * have a `WorkspaceParent` like editor tabs do, but they are not tab groups
     * and must not be offered as switch targets. A sidebar leaf's `getRoot()`
     * is the corresponding `WorkspaceSidedock`, whereas editor leaves root at
     * the main `WorkspaceRoot`.
     */
    private isSidebarLeaf(leaf: WorkspaceLeaf): boolean {
        const root = leaf.getRoot();
        const ws = this.app.workspace as unknown as {
            leftSplit?: unknown;
            rightSplit?: unknown;
        };
        return root === ws.leftSplit || root === ws.rightSplit;
    }

    /**
     * Central editor-leaf discovery for the canonical model. Enumerates every
     * editor leaf via `iterateAllLeaves()` (so pop-out/floating leaves are
     * included), records each leaf's real native window and parent group, and
     * excludes sidebar leaves exactly once. Commands must not re-check
     * `isSidebarLeaf()` or call `iterateRootLeaves()` for features that should
     * include pop-outs.
     */
    private getEditorLeafLocations(): LeafLocation[] {
        const locations: LeafLocation[] = [];

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (this.isSidebarLeaf(leaf)) return;

            locations.push({
                leaf,
                window: leaf.getContainer()?.win,
                group: leaf.parent ?? null,
            });
        });

        return locations;
    }

    /**
     * Build tab groups from already-classified leaf locations. Grouping is by
     * (window, WorkspaceParent), never by parent alone: a leaf's window comes
     * from the bucket key, not from `representative.getContainer()?.win`. A
     * group is current only when both the parent and native window match the
     * active leaf. Relative labels are computed only among groups sharing the
     * active leaf's window.
     */
    private buildTabGroupInfos(
        locations: LeafLocation[],
        activeLeaf: WorkspaceLeaf | null,
    ): TabGroupInfo[] {
        const byWindow = new Map<
            Window | undefined,
            Map<WorkspaceParent, WorkspaceLeaf[]>
        >();

        for (const location of locations) {
            if (!location.group) continue;

            let groupsInWindow = byWindow.get(location.window);
            if (!groupsInWindow) {
                groupsInWindow = new Map<WorkspaceParent, WorkspaceLeaf[]>();
                byWindow.set(location.window, groupsInWindow);
            }

            const leaves = groupsInWindow.get(location.group);
            if (leaves) {
                leaves.push(location.leaf);
            } else {
                groupsInWindow.set(location.group, [location.leaf]);
            }
        }

        const activeWindow = activeLeaf?.getContainer()?.win;
        const activeGroup = activeLeaf?.parent ?? null;
        const activeGroupRect = activeGroup
            ? this.getTabGroupRect(activeGroup as WorkspaceContainerEl)
            : null;

        const infos: TabGroupInfo[] = [];

        for (const [groupWindow, groupsInWindow] of byWindow) {
            for (const [group, leaves] of groupsInWindow) {
                if (leaves.length === 0) continue;

                const representative = this.pickMostRecent(leaves);

                const isCurrentGroup =
                    groupWindow === activeWindow &&
                    group === activeGroup;

                const groupRect = this.getTabGroupRect(
                    group as WorkspaceContainerEl,
                );

                let relativeLabel: string | null = null;

                /*
                 * Spatial relationships only make sense within one native window.
                 * Do not label a pop-out group "left" or "below" the main window.
                 */
                if (
                    !isCurrentGroup &&
                    groupWindow === activeWindow &&
                    activeGroupRect &&
                    groupRect
                ) {
                    const relation = this.relativePosition(
                        groupRect,
                        activeGroupRect,
                    );

                    relativeLabel = relation === "another group"
                        ? null
                        : this.capitalizeFirst(relation);
                }

                infos.push({
                    group,
                    leaves,
                    representative,
                    lastActive: this.getLeafLastActive(representative),
                    label: this.formatTabGroupLabel(
                        representative,
                        leaves.length,
                        isCurrentGroup,
                        relativeLabel,
                    ),
                    relativeLabel,
                    isCurrentGroup,
                    window: groupWindow,
                });
            }
        }

        return infos.sort((a, b) => {
            const byRecency = b.lastActive - a.lastActive;
            if (byRecency !== 0) return byRecency;
            return a.label.localeCompare(b.label);
        });
    }

    private buildTabInfos(groups: TabGroupInfo[]): TabInfo[] {
        return groups
            .flatMap((group) =>
                group.leaves.map((leaf) => ({
                    leaf,
                    group,
                    lastActive: this.getLeafLastActive(leaf),
                })),
            )
            .sort((a, b) => {
                const recency = b.lastActive - a.lastActive;
                if (recency !== 0) return recency;
                return this.getLeafId(a.leaf).localeCompare(this.getLeafId(b.leaf));
            });
    }

    /**
     * The single source of truth for every tab/group/window switching command.
     * One canonical editor-leaf snapshot is classified into locations, then
     * expanded into groups, tabs, and windows. Commands choose a scope from
     * this model rather than running their own workspace scans.
     */
    private buildNavigationModel(
        activeLeaf: WorkspaceLeaf | null,
    ): WorkspaceNavigationModel {
        const locations = this.getEditorLeafLocations();
        const groups = this.buildTabGroupInfos(locations, activeLeaf);
        const tabs = this.buildTabInfos(groups);
        const windows = this.buildWindowInfos(groups, activeLeaf);

        const model: WorkspaceNavigationModel = {
            locations,
            groups,
            tabs,
            windows,
            splits: new Map<string, SplitNodeInfo>(),
            groupToSplitMap: new Map<WorkspaceParent, string>(),
        };

        this.buildTopology(locations, model);

        return model;
    }

    /**
     * Build the live-object topology graph by bubbling up from each discovered
     * tab group's `WorkspaceParent` to its enclosing `WorkspaceSplit` and
     * recursively through ancestor splits. Each Obsidian split object is tagged
     * with a stable synthetic id (`_ntg_id`) so we can reference it in a plain
     * Map without depending on Obsidian's private `id` field. The result lets
     * layout commands read split directions and nesting from live references
     * instead of serializing the workspace via `getLayout`/`setLayout`.
     */
    private buildTopology(
        locations: LeafLocation[],
        model: WorkspaceNavigationModel,
    ): void {
        const processedParents = new Set<WorkspaceParent>();

        // Obsidian's live hierarchy nodes aren't fully described by the public
        // typings (the `type` discriminator and `direction` live on private
        // internals), so we read them off the real objects via this loose shape.
        type SplitNode = {
            _ntg_id?: string;
            type?: string;
            direction?: 'horizontal' | 'vertical';
            parent?: SplitNode | null;
            children?: (SplitNode | WorkspaceParent)[];
        };

        const getObjectId = (obj: SplitNode): string => {
            if (!obj._ntg_id) {
                obj._ntg_id = 'split_' + Math.random().toString(36).substring(2, 11);
            }
            return obj._ntg_id;
        };

        for (const loc of locations) {
            if (!loc.group || processedParents.has(loc.group)) continue;
            processedParents.add(loc.group);

            const firstParent = (loc.group.parent as unknown as SplitNode) ?? null;
            if (firstParent && firstParent.type === 'split') {
                model.groupToSplitMap.set(loc.group, getObjectId(firstParent));
            }

            let currentParent = firstParent;
            while (currentParent && currentParent.type === 'split') {
                const currentId = getObjectId(currentParent);
                const upperParent = (currentParent.parent as SplitNode) ?? null;
                if (!model.splits.has(currentId)) {
                    model.splits.set(currentId, {
                        id: currentId,
                        direction: currentParent.direction!,
                        parentSplitId:
                            upperParent && upperParent.type === 'split'
                                ? getObjectId(upperParent)
                                : null,
                        childIds: (currentParent.children ?? []).map((child) =>
                            getObjectId(child as { _ntg_id?: string }),
                        ),
                        liveSplit: currentParent,
                    });
                }
                currentParent = upperParent;
            }
        }
    }

    // ------------------------------------------------------------------------
    // Canonical model scope helpers
    // ------------------------------------------------------------------------

    private getWindowForLeaf(
        leaf: WorkspaceLeaf | null,
    ): Window | undefined {
        return leaf?.getContainer()?.win;
    }

    private getGroupsInWindow(
        model: WorkspaceNavigationModel,
        targetWindow: Window | undefined,
    ): TabGroupInfo[] {
        return model.groups.filter((group) => group.window === targetWindow);
    }

    private getTabsInWindow(
        model: WorkspaceNavigationModel,
        targetWindow: Window | undefined,
    ): TabInfo[] {
        return model.tabs.filter((tab) => tab.group.window === targetWindow);
    }

    private getGroupForLeaf(
        model: WorkspaceNavigationModel,
        leaf: WorkspaceLeaf | null,
    ): TabGroupInfo | null {
        if (!leaf) return null;

        const leafWindow = this.getWindowForLeaf(leaf);

        return model.groups.find(
            (group) =>
                group.window === leafWindow &&
                group.group === leaf.parent,
        ) ?? null;
    }

    /**
     * Windows in display order, shared by "switch to any tab" and "switch to
     * tab group" so both present the same arrangement: the active window first,
     * then every other window ordered by recency of its most recent tab group.
     */
    private orderWindowsForDisplay(
        model: WorkspaceNavigationModel,
        activeWindow: Window | undefined,
    ): WindowInfo[] {
        return [...model.windows].sort((a, b) => {
            const aActive = a.window === activeWindow ? 1 : 0;
            const bActive = b.window === activeWindow ? 1 : 0;
            if (aActive !== bActive) return bActive - aActive;

            const recency = b.lastActive - a.lastActive;
            if (recency !== 0) return recency;
            return a.label.localeCompare(b.label);
        });
    }

    /**
     * Tab groups in display order, reused by "switch to tab group" (all
     * windows) and to expand the "switch to any tab" list: windows lead with the
     * active one (then others by recency), and within each window groups are
     * ordered by recency of their most recent tab.
     */
    private orderGroupsForDisplay(
        model: WorkspaceNavigationModel,
        activeWindow: Window | undefined,
    ): TabGroupInfo[] {
        const ordered: TabGroupInfo[] = [];

        for (const win of this.orderWindowsForDisplay(model, activeWindow)) {
            const windowGroups = this.sortByRecency(
                win.groups,
                (group) => group.lastActive,
                (a, b) => a.label.localeCompare(b.label),
            );
            ordered.push(...windowGroups);
        }

        return ordered;
    }

    /**
     * Tabs in display order for "switch to any tab": windows lead with the
     * active one (then others by recency), each window's groups are ordered by
     * recency of their most recent tab, and within a group tabs follow recency.
     * Built directly on top of `orderGroupsForDisplay` so the window/group
     * ordering is identical to "switch to tab group".
     */
    private orderTabsForDisplay(
        model: WorkspaceNavigationModel,
        activeWindow: Window | undefined,
    ): TabInfo[] {
        const tabByLeaf = new Map(model.tabs.map((tab) => [tab.leaf, tab]));

        const ordered: TabInfo[] = [];

        for (const group of this.orderGroupsForDisplay(model, activeWindow)) {
            const groupTabs = this.sortByRecency(
                group.leaves
                    .map((leaf) => tabByLeaf.get(leaf))
                    .filter((tab): tab is TabInfo => tab !== undefined),
                (tab) => tab.lastActive,
                (a, b) => a.group.label.localeCompare(b.group.label),
            );
            ordered.push(...groupTabs);
        }

        return ordered;
    }

    /**
     * Tabs sorted by pure recency across every window/group, used when the
     * "group by tab group and window" setting is off. The tiebreak keeps the
     * order deterministic. The default selection (most recent non-active tab)
     * is computed independently of display order, so it stays correct here.
     */
    private orderTabsByRecency(model: WorkspaceNavigationModel): TabInfo[] {
        return this.sortByRecency(
            model.tabs,
            (tab) => tab.lastActive,
            (a, b) => a.group.label.localeCompare(b.group.label),
        );
    }

    /**
     * Tab groups sorted by pure recency across every window, used when the
     * "group by tab group and window" setting is off.
     */
    private orderGroupsByRecency(model: WorkspaceNavigationModel): TabGroupInfo[] {
        return this.sortByRecency(
            model.groups,
            (group) => group.lastActive,
            (a, b) => a.label.localeCompare(b.label),
        );
    }

    /**
     * Sort items recency-first (newest first), preserving the active item's
     * natural position rather than pushing it to the bottom. `getRecency`
     * extracts the timestamp used for ordering; `tiebreak` breaks ties.
     */
    private sortByRecency<T>(
        items: T[],
        getRecency: (item: T) => number,
        tiebreak?: (a: T, b: T) => number,
    ): T[] {
        return [...items].sort((a, b) => {
            const diff = getRecency(b) - getRecency(a);
            if (diff !== 0) return diff;
            return tiebreak ? tiebreak(a, b) : 0;
        });
    }

    /**
     * Position in the display list of the most-recent item that is not active,
     * used to set the modal's initial selection so ENTER switches to it
     * immediately. The display list is grouped by window/tab group, not by pure
     * recency, so we must rank items by `recency` (higher = newer) to find the
     * true most-recent non-active item, then return where that item sits in the
     * already-grouped `items` array. Falls back to 0 when every item is active
     * (degenerate) or the list is empty.
     */
    private firstNonActiveIndex<T>(
        items: T[],
        isActive: (item: T) => boolean,
        recency: (item: T) => number,
    ): number {
        let bestItem: T | null = null;
        let bestRecency = -Infinity;

        for (const item of items) {
            if (isActive(item)) continue;
            const r = recency(item);
            if (r > bestRecency) {
                bestRecency = r;
                bestItem = item;
            }
        }

        if (bestItem === null) return 0;

        return items.indexOf(bestItem);
    }

    private getTabSearchText(tab: TabInfo): string {
        return `${tab.leaf.getDisplayText()} ${tab.group.label}`;
    }

    private getTabGroupLocation(group: TabGroupInfo): string {
        return group.isCurrentGroup
            ? "Current group"
            : group.relativeLabel || "Other group";
    }

    private getTabGroupMeta(tab: TabInfo): string {
        const group = tab.group;

        let location: string;
        if (group.isCurrentGroup) {
            location = "Current group";
        } else if (group.relativeLabel) {
            location = group.relativeLabel;
        } else {
            location = "Other group";
        }

        const count =
            `${group.leaves.length} ` +
            `tab${group.leaves.length === 1 ? "" : "s"}`;

        return `${location} · ${count}`;
    }

    private renderTabSuggestion(
        tab: TabInfo,
        el: HTMLElement,
        labels: Map<Window | undefined, string>,
        showGroup: boolean,
        showWindow: boolean,
        match?: FuzzyMatch<TabInfo>,
    ): void {
        el.empty();
        el.addClass("ntg-nav-row");

        const filePath = this.getLeafFileKey(tab.leaf);
        if (filePath) {
            updateElementPathDatasets(el, filePath);
        }

        const primaryContainer = el.createDiv({
            cls: "ntg-nav-primary suggestion-title data-link-text",
        });
        const rawDisplayText = tab.leaf.getDisplayText();
        const searchText = this.getTabSearchText(tab);
        const matches = mapFuzzyMatchesToDisplayText(
            searchText,
            rawDisplayText,
            0,
            match?.match.matches ?? [],
        );

        renderHighlightedText(primaryContainer, rawDisplayText, matches);

        const parts: string[] = [];
        if (showGroup) parts.push(this.getTabGroupMeta(tab));
        if (showWindow) parts.push(this.getWindowLabel(tab.group.window, labels));

        const secondaryContainer = el.createDiv({ cls: "ntg-nav-secondary" });
        secondaryContainer.setText(parts.join(" · "));
    }

    private getWindowLabel(
        win: Window | undefined,
        labels: Map<Window | undefined, string>,
    ): string {
        return labels.get(win) ?? (win === window ? "Main window" : "Pop-out");
    }

    private renderTabGroupSuggestion(
        group: TabGroupInfo,
        el: HTMLElement,
        labels: Map<Window | undefined, string>,
        showGroup: boolean,
        showWindow: boolean,
        match?: FuzzyMatch<TabGroupInfo>,
    ): void {
        const title = group.representative.getDisplayText() || "Untitled tab";

        el.empty();
        el.addClass("ntg-nav-row");

        const filePath = this.getLeafFileKey(group.representative);
        if (filePath) {
            updateElementPathDatasets(el, filePath);
        }

        const primaryContainer = el.createDiv({
            cls: "ntg-nav-primary suggestion-title data-link-text",
        });
        const location = this.getTabGroupLocation(group);
        const searchText = location ? `${location} ${title}` : title;
        const displayOffset = location ? location.length + 1 : 0;
        const matches = mapFuzzyMatchesToDisplayText(
            searchText,
            title,
            displayOffset,
            match?.match.matches ?? [],
        );

        renderHighlightedText(primaryContainer, title, matches);

        const parts: string[] = [];
        if (showGroup) {
            const count =
                `${group.leaves.length} ` +
                `tab${group.leaves.length === 1 ? "" : "s"}`;
            parts.push(`${location} · ${count}`);
        }
        if (showWindow) parts.push(this.getWindowLabel(group.window, labels));

        const secondaryContainer = el.createDiv({ cls: "ntg-nav-secondary" });
        secondaryContainer.setText(parts.join(" · "));
    }

    private renderWindowSuggestion(
        item: WindowInfo,
        el: HTMLElement,
        match?: FuzzyMatch<WindowInfo>,
    ): void {
        const groupCount =
            `${item.groups.length} ` +
            `group${item.groups.length === 1 ? "" : "s"}`;

        const recent = item.representative.getDisplayText() || "Untitled tab";

        el.empty();
        el.addClass("ntg-nav-row");

        const primaryContainer = el.createDiv({ cls: "ntg-nav-primary" });
        const searchText = `${item.label} ${recent}`;
        const matches = mapFuzzyMatchesToDisplayText(
            searchText,
            item.label,
            0,
            match?.match.matches ?? [],
        );

        renderHighlightedText(primaryContainer, item.label, matches);

        const secondaryContainer = el.createDiv({ cls: "ntg-nav-secondary" });
        secondaryContainer.setText(`Most recent: ${recent} · ${groupCount}`);
    }

    private renderInGroupTabSuggestion(
        leaf: WorkspaceLeaf,
        el: HTMLElement,
        labels: Map<Window | undefined, string>,
        showWindow: boolean,
        match?: FuzzyMatch<WorkspaceLeaf>,
    ): void {
        const secondary = showWindow
            ? this.getWindowLabel(leaf.getContainer()?.win, labels)
            : "";

        el.empty();
        el.addClass("ntg-nav-row");

        const filePath = this.getLeafFileKey(leaf);
        if (filePath) {
            updateElementPathDatasets(el, filePath);
        }

        const primaryContainer = el.createDiv({
            cls: "ntg-nav-primary suggestion-title data-link-text",
        });
        renderHighlightedText(primaryContainer, leaf.getDisplayText(), match?.match.matches ?? []);

        const secondaryContainer = el.createDiv({ cls: "ntg-nav-secondary" });
        secondaryContainer.setText(secondary);
    }

    private cycleTabGroups() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const activeWindow = this.getWindowForLeaf(activeLeaf);

        // Scope cycling to the active leaf's window: never cycle from the main
        // window into a pop-out or vice versa. The model already buckets groups
        // by (window, parent), so we only need to filter on window here.
        const model = this.buildNavigationModel(activeLeaf);
        const windowGroups = this.getGroupsInWindow(model, activeWindow);

        if (windowGroups.length <= 1) {
            return;
        }

        const sorted = this.getSpatiallySortedGroups(windowGroups);

        if (!activeLeaf) {
            this.focusTabGroup(sorted[0]);
            return;
        }

        const activeTabGroup = activeLeaf.parent as WorkspaceParent | null;
        if (activeTabGroup) {
            this.tabGroupActiveLeaves.set(activeTabGroup, activeLeaf);
        }

        const currentIndex = sorted.findIndex((group) =>
            group.window === activeWindow &&
            group.group === activeTabGroup,
        );
        if (currentIndex === -1) {
            this.focusTabGroup(sorted[0]);
            return;
        }

        const nextIndex = (currentIndex + 1) % sorted.length;
        this.focusTabGroup(sorted[nextIndex]);
    }

    private focusTabGroup(group: TabGroupInfo) {
        const tabGroup = group.group;
        const storedLeaf = this.tabGroupActiveLeaves.get(tabGroup);

        if (storedLeaf && storedLeaf.parent === tabGroup) {
            this.focusLeafAndWindow(storedLeaf);
            return;
        }

        this.focusLeafAndWindow(group.representative);
    }

    // ------------------------------------------------------------------------
    // Collect tabs into the active tab group
    // ------------------------------------------------------------------------

    /**
     * Collect every editor tab in the active leaf's window into the active tab
     * group, leaving the rest of the workspace (selections, history, scroll,
     * view state) untouched. We snapshot each leaf's view state, detach it in
     * place, then re-create each one as a tab next to the active survivor leaf
     * using native workspace APIs — no `getLayout`/`setLayout`, so nothing is
     * recreated from scratch.
     */
    private async collectTabs() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        if (!activeLeaf) return;

        const model = this.buildNavigationModel(activeLeaf);
        const activeWindow = this.getWindowForLeaf(activeLeaf);
        const tabsToMigrate = this.getTabsInWindow(model, activeWindow)
            .map((t) => t.leaf)
            .filter((leaf) => leaf !== activeLeaf);

        if (tabsToMigrate.length === 0) return;

        const states = tabsToMigrate.map((leaf) => leaf.getViewState());
        for (const leaf of tabsToMigrate) {
            leaf.detach();
        }

        const targetParent = activeLeaf.parent as any;
        for (const state of states) {
            const newLeaf = this.app.workspace.createLeafInParent(targetParent, -1);
            await newLeaf.setViewState(state);
        }

        if (activeLeaf.parent) {
            this.tabGroupActiveLeaves.set(activeLeaf.parent, activeLeaf);
        }
        this.focusLeafAndWindow(activeLeaf);
    }

    // ------------------------------------------------------------------------
    // ------------------------------------------------------------------------
    // Rotate tab groups — safe in-place split orientation toggle.
    //
    // Swapping every tab group's nesting orientation (vertical <-> horizontal)
    // does NOT require tearing down the workspace. Detaching every leaf destroys
    // the layout tree, leaving `createLeafBySplit` with no valid parent and
    // wiping selections, history, and scroll. Instead we mutate the live
    // `direction` property and the corresponding `mod-horizontal`/`mod-vertical`
    // CSS class on each captured split object, then ask Obsidian to re-flow.
    // Nothing is recreated, so 100% of workspace state is preserved.
    // ------------------------------------------------------------------------

    /**
     * Rotates the tab group split tree 90 degrees clockwise within the focused window.
     * Replaces simple direction flipping with true tree transposition + child reversal.
     */
    private async rotateTabGroups() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        if (!activeLeaf) return;

        const activeWin = this.getWindowForLeaf(activeLeaf);

        // Walk up from the active leaf to find the root split in the active window
        let rootSplit: any = activeLeaf.parent;
        let highestSplit: any = null;

        while (rootSplit) {
            if (rootSplit.type === 'split') {
                highestSplit = rootSplit;
            }
            rootSplit = rootSplit.parent;
        }

        // If there are no split containers (e.g., in a single-group popup window), inform the user
        if (!highestSplit) {
            new Notice("Cannot rotate: current window has no split groups.");
            return;
        }

        // Perform recursive 90-degree clockwise rotation on the split tree
        this.rotateSplitClockwise(highestSplit, activeWin);

        // Notify Obsidian to re-render layout bounds and tab header containers
        (this.app.workspace as unknown as { onLayoutChange: () => void }).onLayoutChange();
    }

    /**
     * Recursively transforms a split node 90 degrees clockwise.
     * 1. Inverts direction ('vertical' <-> 'horizontal')
     * 2. Reverses child order array
     * 3. Re-orders containerEl child DOM nodes to match
     */
    public rotateSplitClockwise(node: any, activeWin?: Window): void {
        if (!node) return;

        // Verify that the target node belongs to the currently active window context
        if (activeWin && node.containerEl) {
            const nodeWin = node.containerEl.ownerDocument?.defaultView;
            if (nodeWin && nodeWin !== activeWin) return;
        }

        // Check if current node is a Split container with children
        if (node.children && Array.isArray(node.children) && node.direction) {
            // 1. Recurse into child splits first (post-order) so nested
            //    rotations are applied before this node is transposed.
            for (const child of node.children) {
                this.rotateSplitClockwise(child, activeWin);
            }

            const oldDirection = node.direction;
            if (oldDirection === 'vertical' || oldDirection === 'horizontal') {
                const newDirection: 'horizontal' | 'vertical' =
                    oldDirection === 'vertical' ? 'horizontal' : 'vertical';

                // 2. Update internal split direction flag and CSS modifier class
                node.direction = newDirection;
                if (node.containerEl) {
                    node.containerEl.classList.remove(`mod-${oldDirection}`);
                    node.containerEl.classList.add(`mod-${newDirection}`);
                }

                // 3. For true clockwise rotation matching Emacs transpose-frame:
                //    Reversing when converting horizontal to vertical turns
                //    Top/Bottom into Right/Left (Clockwise 90°).
                if (oldDirection === 'horizontal' && newDirection === 'vertical') {
                    node.children.reverse();
                }

                // 4. Re-order actual DOM elements to match the (possibly reversed) array order
                if (node.containerEl && node.containerEl.children) {
                    for (const child of node.children) {
                        if (child.containerEl) {
                            node.containerEl.appendChild(child.containerEl);
                        }
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // Deduplicate tabs
    // ------------------------------------------------------------------------

    /**
     * Identify the underlying file a leaf displays, if any. Returns null for
     * leaves that don't point to a file (graph view, settings, etc.) so they
     * are never considered duplicates.
     */
    private getLeafFileKey(leaf: WorkspaceLeaf): string | null {
        const view = leaf.view;
        if (view && typeof (view as { file?: unknown }).file !== 'undefined') {
            const file = (view as { file?: { path?: string } | null }).file;
            if (file && typeof file.path === 'string') {
                return file.path;
            }
        }
        const vs = leaf.getViewState();
        const file = (vs.state as Record<string, unknown> | undefined)?.['file'];
        if (typeof file === 'string' && file.length > 0) {
            return file;
        }
        return null;
    }

    private getLeafId(leaf: WorkspaceLeaf): string {
        return (leaf as WorkspaceLeafInternal).id ?? '';
    }

    private getLeafLastActive(leaf: WorkspaceLeaf): number {
        const id = this.getLeafId(leaf);
        return this.leafLastActive.get(id) ?? 0;
    }

    /**
     * Compare two leaves for "recency". Higher is more recent. Leaves with
     * no recorded timestamp fall back to a stable id comparison so the order
     * is deterministic across runs even before the first active-leaf-change.
     */
    private compareRecency(a: WorkspaceLeaf, b: WorkspaceLeaf): number {
        const aTime = this.getLeafLastActive(a);
        const bTime = this.getLeafLastActive(b);
        if (aTime !== bTime) {
            return aTime - bTime;
        }
        return this.getLeafId(a).localeCompare(this.getLeafId(b));
    }

    private pickMostRecent(leaves: WorkspaceLeaf[]): WorkspaceLeaf {
        const sorted = [...leaves].sort((a, b) => this.compareRecency(a, b));
        return sorted[sorted.length - 1];
    }

    /**
     * Pick the leaf to keep for one set of duplicates. Resolution order:
     *  1. The active leaf, if present in the set.
     *  2. The most recently visited leaf in the active tab group.
     *  3. The most recently visited leaf in the active window.
     *  4. The most recently visited leaf globally (tracked by recency map).
     *  5. Stable tie-break by leaf id.
     */
    private pickSurvivor(leaves: WorkspaceLeaf[], activeLeaf: WorkspaceLeaf | null): WorkspaceLeaf {
        const activeTabGroup = activeLeaf?.parent as WorkspaceParent | null;
        const activeContainer = activeLeaf ? activeLeaf.getContainer() : null;

        if (activeLeaf) {
            const found = leaves.find((l) => l === activeLeaf);
            if (found) return found;
        }

        if (activeTabGroup) {
            const inGroup = leaves.filter((l) => l.parent === activeTabGroup);
            if (inGroup.length > 0) {
                return this.pickMostRecent(inGroup);
            }
        }

        if (activeContainer) {
            const inWindow = leaves.filter((l) => l.getContainer() === activeContainer);
            if (inWindow.length > 0) {
                return this.pickMostRecent(inWindow);
            }
        }

        return this.pickMostRecent(leaves);
    }

    /**
     * Group leaves by the file they point to. Leaves with no file (graph,
     * settings, etc.) are excluded.
     */
    private groupLeavesByFile(leaves: WorkspaceLeaf[]): Map<string, WorkspaceLeaf[]> {
        const groups = new Map<string, WorkspaceLeaf[]>();
        for (const leaf of leaves) {
            const key = this.getLeafFileKey(leaf);
            if (!key) continue;
            const list = groups.get(key);
            if (list) {
                list.push(leaf);
            } else {
                groups.set(key, [leaf]);
            }
        }
        return groups;
    }

    /**
     * Compute the set of leaves to remove, and the per-file duplicates that
     * remain. Returns null if there is nothing to deduplicate.
     */
    private planDedupe(
        scope: WorkspaceLeaf[],
        activeLeaf: WorkspaceLeaf | null
    ): { toRemove: WorkspaceLeaf[]; notesAffected: number } | null {
        const groups = this.groupLeavesByFile(scope);
        const toRemove: WorkspaceLeaf[] = [];
        let notesAffected = 0;
        for (const [, leaves] of groups) {
            if (leaves.length <= 1) continue;
            notesAffected++;
            const survivor = this.pickSurvivor(leaves, activeLeaf);
            for (const leaf of leaves) {
                if (leaf !== survivor) {
                    toRemove.push(leaf);
                }
            }
        }
        if (toRemove.length === 0) return null;
        return { toRemove, notesAffected };
    }

    /**
     * Render the confirmation contents into the given element. Lists each
     * note that has duplicate tabs, the count of tabs being removed, and
     * where those tabs live (current window vs other windows).
     */
    private renderConfirmation(
        scope: WorkspaceLeaf[],
        activeLeaf: WorkspaceLeaf | null,
        removed: WorkspaceLeaf[]
    ): HTMLElement {
        // Multi-window context safety: createElement using activeDocument
        const doc = activeDocument as unknown as Document;
        const root = doc.createElement('div');
        root.classList.add('ntg-dedupe-confirm');

        const removedIds = new Set(removed.map((l) => this.getLeafId(l)));
        const fileGroups = this.groupLeavesByFile(scope);
        const activeTabGroup = activeLeaf?.parent as WorkspaceParent | null;
        const activeContainer = activeLeaf ? activeLeaf.getContainer() : null;
        const activeGroupRect = activeTabGroup
            ? this.getTabGroupRect(activeTabGroup as WorkspaceContainerEl)
            : null;

        const entries: Array<{ file: string; count: number; parts: string[] }> = [];
        let totalRemoved = 0;
        const sortedEntries = [...fileGroups.entries()].sort(([a], [b]) => a.localeCompare(b));
        for (const [file, leaves] of sortedEntries) {
            if (leaves.length <= 1) continue;
            const fileRemoved = leaves.filter((l) => removedIds.has(this.getLeafId(l)));
            if (fileRemoved.length === 0) continue;
            totalRemoved += fileRemoved.length;

            const currentWindowTabs: WorkspaceLeaf[] = [];
            const otherWindowTabs: WorkspaceLeaf[] = [];
            for (const leaf of fileRemoved) {
                if (activeContainer && leaf.getContainer() !== activeContainer) {
                    otherWindowTabs.push(leaf);
                } else {
                    currentWindowTabs.push(leaf);
                }
            }

            const parts: string[] = [];
            if (currentWindowTabs.length > 0) {
                const locationCounts = new Map<string, number>();
                for (const leaf of currentWindowTabs) {
                    let label: string;
                    if (activeTabGroup && leaf.parent === activeTabGroup) {
                        label = 'current group (current window)';
                    } else {
                        const leafRect = this.getTabGroupRect(leaf.parent as WorkspaceContainerEl);
                        const rel = this.relativePosition(leafRect, activeGroupRect);
                        label = `${rel} (current window)`;
                    }
                    locationCounts.set(label, (locationCounts.get(label) ?? 0) + 1);
                }
                for (const [label, n] of locationCounts) {
                    parts.push(`${n} in ${label}`);
                }
            }
            if (otherWindowTabs.length > 0) {
                const distinctWindows = new Set(otherWindowTabs.map((l) => l.getContainer()));
                const windowCount = distinctWindows.size;
                parts.push(`${otherWindowTabs.length} in ${windowCount} other window${windowCount === 1 ? '' : 's'}`);
            }

            entries.push({ file, count: fileRemoved.length, parts });
        }

        const summary = doc.createElement('p');
        summary.classList.add('ntg-dedupe-summary');
        summary.textContent = `Will close ${totalRemoved} duplicate tab${totalRemoved === 1 ? '' : 's'} of ${entries.length} note${entries.length === 1 ? '' : 's'}.`;
        root.appendChild(summary);

        if (entries.length > 0) {
            const list = doc.createElement('ul');
            list.classList.add('ntg-dedupe-list');
            root.appendChild(list);
            for (const entry of entries) {
                const li = doc.createElement('li');
                li.classList.add('ntg-dedupe-item');
                list.appendChild(li);

                const name = doc.createElement('span');
                name.classList.add('ntg-dedupe-name');
                name.textContent = this.basename(entry.file);
                li.appendChild(name);

                const tail = doc.createElement('span');
                tail.classList.add('ntg-dedupe-locations');
                const tabWord = entry.count === 1 ? 'tab' : 'tabs';
                tail.textContent = ` (${entry.count} ${tabWord} removed: ${entry.parts.join(', ')})`;
                li.appendChild(tail);
            }
        }

        return root;
    }

    private getTabGroupRect(tabGroup: WorkspaceContainerEl | null): { x: number; y: number; w: number; h: number } | null {
        if (!tabGroup) return null;
        try {
            const el = tabGroup.containerEl;
            if (el && el.instanceOf(HTMLElement)) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
                }
            }
        } catch {
            // fall through
        }
        return null;
    }

    private relativePosition(
        target: { x: number; y: number; w: number; h: number } | null,
        ref: { x: number; y: number; w: number; h: number } | null
    ): string {
        if (!target) return 'another group';
        if (!ref) return 'another group';
        const targetCx = target.x + target.w / 2;
        const targetCy = target.y + target.h / 2;
        const refCx = ref.x + ref.w / 2;
        const refCy = ref.y + ref.h / 2;
        const dx = targetCx - refCx;
        const dy = targetCy - refCy;
        if (Math.abs(dx) > Math.abs(dy)) {
            return dx > 0 ? 'right group' : 'left group';
        }
        return dy > 0 ? 'group below' : 'group above';
    }

    private basename(path: string): string {
        const idx = path.lastIndexOf('/');
        return idx >= 0 ? path.slice(idx + 1) : path;
    }

    private askConfirmation(title: string, body: HTMLElement): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new DedupeConfirmModal(this.app, title, body, resolve);
            modal.open();
        });
    }

    private async dedupeInGroup() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        if (!activeLeaf) return;

        const model = this.buildNavigationModel(activeLeaf);
        const activeGroup = this.getGroupForLeaf(model, activeLeaf);

        // "In group" means the exact group in the exact window of the active
        // leaf. The model already excludes sidebar leaves, so this never
        // includes unexpected workspace items from activeLeaf.parent.children.
        if (!activeGroup || activeGroup.leaves.length === 0) return;
        await this.runDedupe(activeGroup.leaves, activeLeaf, this.settings.confirmDedupeGroup, 'Deduplicate tabs in group');
    }

    private async dedupeInAllGroups() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const model = this.buildNavigationModel(activeLeaf);
        const activeWindow = this.getWindowForLeaf(activeLeaf);

        // "All groups" means every editor group in the active leaf's actual
        // window. With no active leaf to identify a window, fall back to the
        // main layout's root leaves so scope never silently expands to all
        // windows.
        const leaves: WorkspaceLeaf[] = [];
        if (activeWindow) {
            for (const tab of this.getTabsInWindow(model, activeWindow)) {
                leaves.push(tab.leaf);
            }
        } else {
            this.app.workspace.iterateRootLeaves((leaf) => {
                leaves.push(leaf);
            });
        }
        await this.runDedupe(leaves, activeLeaf, this.settings.confirmDedupeAllGroups, 'Deduplicate tabs in all groups');
    }

    private async dedupeInAllWindows() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();

        // All-window scope, but built from the canonical model so sidebar
        // leaves are excluded consistently.
        const model = this.buildNavigationModel(activeLeaf);
        const leaves = model.tabs.map((tab) => tab.leaf);
        await this.runDedupe(leaves, activeLeaf, this.settings.confirmDedupeAllWindows, 'Deduplicate tabs in all windows');
    }

    private async runDedupe(leaves: WorkspaceLeaf[], activeLeaf: WorkspaceLeaf | null, confirm: boolean, title: string) {
        const plan = this.planDedupe(leaves, activeLeaf);
        if (!plan) return;

        if (confirm) {
            const ok = await this.askConfirmation(title, this.renderConfirmation(leaves, activeLeaf, plan.toRemove));
            if (!ok) return;
        }

        for (const leaf of plan.toRemove) {
            leaf.detach();
        }
    }

    // ------------------------------------------------------------------------
    // Switch to tab in group
    // ------------------------------------------------------------------------

    /**
     * Returns the leaves in the active tab group (the `WorkspaceTabs` parent of
     * the focused leaf), reusing the same `activeLeaf.parent` identification
     * the rest of the plugin uses. Returns null when there is no active leaf.
     */
    private getActiveTabGroupLeaves(): WorkspaceLeaf[] | null {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        if (!activeLeaf || !activeLeaf.parent) return null;

        const tabGroup = activeLeaf.parent as WorkspaceContainerEl;
        return (tabGroup.children ?? []) as unknown as WorkspaceLeaf[];
    }

    private switchToTabInGroup(): void {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const model = this.buildNavigationModel(activeLeaf);
        const activeGroup = this.getGroupForLeaf(model, activeLeaf);

        if (!activeGroup || activeGroup.leaves.length === 0) {
            new Notice("No tabs in the active tab group to switch to.");
            return;
        }

        const leaves = this.sortByRecency(
            activeGroup.leaves,
            (leaf) => this.getLeafLastActive(leaf),
            (a, b) => this.getLeafId(a).localeCompare(this.getLeafId(b)),
        );

        // The active group is the only group in this modal, so its name is
        // never needed; the window is named only when more than one exists.
        const showWindow =
            new Set(model.groups.map((group) => group.window)).size > 1;
        const windowLabels = this.buildWindowLabels(model);

        new NavigationSuggestModal(
            this.app,
            leaves,
            "Switch to tab in group",
            (leaf) => leaf.getDisplayText(),
            (leaf) => this.focusLeafAndWindow(leaf),
            (leaf, el, match) => this.renderInGroupTabSuggestion(leaf, el, windowLabels, showWindow, match),
            this.firstNonActiveIndex(
                leaves,
                (leaf) => leaf === activeLeaf,
                (leaf) => this.getLeafLastActive(leaf),
            ),
            (leaf) => this.getLeafFileKey(leaf),
        ).open();
    }

    private switchToAnyTab(): void {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const model = this.buildNavigationModel(activeLeaf);
        const activeWindow = this.getWindowForLeaf(activeLeaf);

        if (model.tabs.length === 0) {
            new Notice("No editor tabs to switch to.");
            return;
        }

        // When the setting is on, tabs are grouped by tab group within each
        // window and windows (and their groups) are ordered by recency so the
        // freshest contexts sit at the top. When off, everything is a single
        // pure-recency list. The most-recent non-active tab is selected by
        // default either way, so ENTER switches to it immediately.
        const tabs = this.settings.groupSwitchByContext
            ? this.orderTabsForDisplay(model, activeWindow)
            : this.orderTabsByRecency(model);

        const multipleWindows =
            new Set(model.groups.map((group) => group.window)).size > 1;
        const showGroup = model.groups.length > 1;
        const windowLabels = this.buildWindowLabels(model);

        new NavigationSuggestModal(
            this.app,
            tabs,
            "Switch to any tab",
            (tab) => this.getTabSearchText(tab),
            (tab) => this.focusLeafAndWindow(tab.leaf),
            (tab, el, match) => this.renderTabSuggestion(tab, el, windowLabels, showGroup, multipleWindows, match),
            this.firstNonActiveIndex(
                tabs,
                (tab) => tab.leaf === activeLeaf,
                (tab) => tab.lastActive,
            ),
            (tab) => this.getLeafFileKey(tab.leaf),
        ).open();
    }

    private activateTabGroup(
        group: WorkspaceParent,
        fallbackLeaf: WorkspaceLeaf,
    ): void {
        const storedLeaf = this.tabGroupActiveLeaves.get(group);

        if (storedLeaf && storedLeaf.parent === group) {
            this.focusLeafAndWindow(storedLeaf);
            return;
        }

        this.focusLeafAndWindow(fallbackLeaf);
    }

    private switchToTabGroup(): void {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const model = this.buildNavigationModel(activeLeaf);
        const activeWindow = this.getWindowForLeaf(activeLeaf);

        // When the setting is on, groups are ordered the same way as "switch
        // to any tab": the active window first, then other windows by recency,
        // with each window's groups ordered by recency of their most recent
        // tab. When off, every group is in a single pure-recency list across
        // all windows.
        const orderedGroups = this.settings.groupSwitchByContext
            ? this.orderGroupsForDisplay(model, activeWindow)
            : this.orderGroupsByRecency(model);

        if (orderedGroups.length === 0) {
            new Notice("No tab groups to switch to.");
            return;
        }

        const multipleWindows =
            new Set(model.groups.map((group) => group.window)).size > 1;
        const showGroup = model.groups.length > 1;
        const windowLabels = this.buildWindowLabels(model);

        new NavigationSuggestModal(
            this.app,
            orderedGroups,
            "Switch to tab group",
            (group) => {
                const title = group.representative.getDisplayText() || "Untitled tab";
                const location = this.getTabGroupLocation(group);
                return location ? `${location} ${title}` : title;
            },            (group) => this.activateTabGroup(group.group, group.representative),
            (group, el, match) => this.renderTabGroupSuggestion(group, el, windowLabels, showGroup, multipleWindows, match),
            this.firstNonActiveIndex(
                orderedGroups,
                (group) =>
                    group.window === activeWindow &&
                    group.group === activeLeaf?.parent,
                (group) => group.lastActive,
            ),
            (group) => this.getLeafFileKey(group.representative),
        ).open();
    }

    private formatWindowLabel(
        role: string,
        groups: TabGroupInfo[],
        representative: WorkspaceLeaf,
    ): string {
        const title = representative.getDisplayText() || "Untitled tab";

        if (role === "Main window") return `${role} — ${title}`;

        const count = `${groups.length} group${groups.length === 1 ? "" : "s"}`;
        return `${role} — ${title} · ${count}`;
    }

    /**
     * Map each window to a stable display label. The main window (the global
     * `window`) is "Main window"; every pop-out is numbered by its position in
     * the recency-ordered window list ("Pop-out 1", "Pop-out 2", …) so distinct
     * pop-outs are distinguishable from one another.
     */
    private buildWindowLabels(
        model: WorkspaceNavigationModel,
    ): Map<Window | undefined, string> {
        const labels = new Map<Window | undefined, string>();
        let popoutOrdinal = 0;

        for (const win of model.windows) {
            if (win.window === window) {
                labels.set(win.window, "Main window");
            } else {
                popoutOrdinal += 1;
                labels.set(win.window, `Pop-out ${popoutOrdinal}`);
            }
        }

        return labels;
    }

    private buildWindowInfos(
        groups: TabGroupInfo[],
        activeLeaf: WorkspaceLeaf | null,
    ): WindowInfo[] {
        const byWindow = new Map<Window | undefined, TabGroupInfo[]>();

        for (const group of groups) {
            const items = byWindow.get(group.window);
            if (items) {
                items.push(group);
            } else {
                byWindow.set(group.window, [group]);
            }
        }

        const currentWin = activeLeaf?.getContainer()?.win;

        const windows: WindowInfo[] = [];
        let popoutOrdinal = 0;

        for (const [win, windowGroups] of byWindow) {
            const sortedGroups = [...windowGroups].sort((a, b) => {
                const recency = b.lastActive - a.lastActive;
                if (recency !== 0) return recency;
                return a.label.localeCompare(b.label);
            });

            const representative = sortedGroups[0].representative;

            const role =
                win === window
                    ? "Main window"
                    : `Pop-out ${(popoutOrdinal += 1)}`;

            windows.push({
                window: win,
                groups: sortedGroups,
                representative,
                lastActive: this.getLeafLastActive(representative),
                label: this.formatWindowLabel(role, sortedGroups, representative),
                isCurrentWindow: win === currentWin,
            });
        }

        return windows.sort((a, b) => {
            const recency = b.lastActive - a.lastActive;
            if (recency !== 0) return recency;
            return a.label.localeCompare(b.label);
        });
    }

    private switchToWindow(): void {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const model = this.buildNavigationModel(activeLeaf);
        const activeWindow = this.getWindowForLeaf(activeLeaf);

        if (model.windows.length === 0) {
            new Notice("No Obsidian windows to switch to.");
            return;
        }

        const windows = this.sortByRecency(
            model.windows,
            (item) => item.lastActive,
            (a, b) => a.label.localeCompare(b.label),
        );

        if (windows.length === 0) {
            new Notice("No Obsidian windows to switch to.");
            return;
        }

        new NavigationSuggestModal(
            this.app,
            windows,
            "Switch to window",
            (item) => `${item.label} ${item.representative.getDisplayText()}`,
            (item) => this.focusLeafAndWindow(item.representative),
            (item, el, match) => this.renderWindowSuggestion(item, el, match),
            this.firstNonActiveIndex(
                windows,
                (item) => item.window === activeWindow,
                (item) => item.lastActive,
            ),
            (item) => this.getLeafFileKey(item.representative),
        ).open();
    }

}

// ---------------------------------------------------------------------------
// Confirmation modal
// ---------------------------------------------------------------------------

class DedupeConfirmModal extends Modal {
    private readonly title: string;
    private readonly body: HTMLElement;
    private readonly resolve: (ok: boolean) => void;

    constructor(app: App, title: string, body: HTMLElement, resolve: (ok: boolean) => void) {
        super(app);
        this.title = title;
        this.body = body;
        this.resolve = resolve;
    }

    onOpen() {
        this.titleEl.setText(this.title);
        this.contentEl.empty();
        this.contentEl.classList.add('ntg-dedupe-modal');
        this.contentEl.appendChild(this.body);

        const finish = (ok: boolean) => {
            this.resolve(ok);
            this.close();
        };

        // Standardized abstraction row replaces manual div + button setups
        new Setting(this.contentEl)
            .addButton((btn) =>
                btn.setButtonText('Cancel')
                   .onClick(() => finish(false))
            )
            .addButton((btn) =>
                btn.setButtonText('Close tabs')
                   .setWarning()
                   .setCta()
                   .onClick(() => finish(true))
            );

        // Bind core accessibility commands
        this.scope.register([], 'Escape', () => { finish(false); return false; });
        this.scope.register([], 'Enter', () => { finish(true); return false; });
    }
}

// ---------------------------------------------------------------------------
// Reusable suggestion modal
// ---------------------------------------------------------------------------

type SuggestionRenderer<T> = (item: T, el: HTMLElement, match: FuzzyMatch<T>) => void;

class NavigationSuggestModal<T> extends FuzzySuggestModal<T> {
    constructor(
        app: App,
        private readonly items: T[],
        placeholder: string,
        private readonly getSearchText: (item: T) => string,
        private readonly onChoose: (item: T) => void,
        private readonly renderItem?: SuggestionRenderer<T>,
        private readonly initialIndex = 0,
        private readonly getFilePath?: (item: T) => string | null,
    ) {
        super(app);
        this.setPlaceholder(placeholder);
    }

    onOpen() {
        super.onOpen();

        registerEmacsMotionKeys(this);

        // Keep the list in recency order (the active item stays in its slot)
        // but select the most-recent item that is not the active one so ENTER
        // immediately switches to it.
        if (this.initialIndex > 0 && this.initialIndex < this.items.length) {
            // Defer execution until after the modal renders its initial suggestions
            window.setTimeout(() => {
                // Access Obsidian's internal chooser object
                const chooser = (this as any).chooser;
                if (chooser && typeof chooser.setSelectedItem === 'function') {
                    // Select the target index. The second argument (true) ensures
                    // the list scrolls down to the item if it happens to be off-screen.
                    chooser.setSelectedItem(this.initialIndex, true);
                }
            }, 0);
        }
    }

    getItems(): T[] {
        return this.items;
    }

    getItemText(item: T): string {
        return this.getSearchText(item);
    }

    renderSuggestion(match: FuzzyMatch<T>, el: HTMLElement): void {
        if (this.getFilePath) {
            const filePath = this.getFilePath(match.item);
            updateElementPathDatasets(el, filePath);
        } else {
            updateElementPathDatasets(el, null);
        }

        if (this.renderItem) {
            el.empty();
            this.renderItem(match.item, el, match);
            return;
        }

        el.setText(this.getItemText(match.item));
    }

    onChooseItem(item: T): void {
        this.onChoose(item);
    }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class NextTabGroupSettingTab extends PluginSettingTab {
    private readonly plugin: NextTabGroupPlugin;

    constructor(app: App, plugin: NextTabGroupPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Deduplicate tabs' });

        new Setting(containerEl)
            .setName('Confirm before deduplicating in group')
            .setDesc('Show a confirmation dialog listing the tabs to be removed when running "Deduplicate tabs in group". Off by default; enable to prompt before closing tabs in the current group.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.confirmDedupeGroup)
                    .onChange(async (value) => {
                        this.plugin.settings.confirmDedupeGroup = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Confirm before deduplicating in all groups')
            .setDesc('Show a confirmation dialog listing the tabs to be removed when running "Deduplicate tabs in all groups". Disable to run without prompting.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.confirmDedupeAllGroups)
                    .onChange(async (value) => {
                        this.plugin.settings.confirmDedupeAllGroups = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Confirm before deduplicating in all windows')
            .setDesc('Show a confirmation dialog listing the tabs to be removed when running "Deduplicate tabs in all windows". Disable to run without prompting.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.confirmDedupeAllWindows)
                    .onChange(async (value) => {
                        this.plugin.settings.confirmDedupeAllWindows = value;
                        await this.plugin.saveSettings();
                    })
            );

        containerEl.createEl('h2', { text: 'Switch tabs' });

        new Setting(containerEl)
            .setName('Group results by tab group and window')
            .setDesc('When on, "Switch to any tab" and "Switch to tab group" cluster results by window and tab group (freshest first). When off, every result is listed in a single pure recency order, newest at the top.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.groupSwitchByContext)
                    .onChange(async (value) => {
                        this.plugin.settings.groupSwitchByContext = value;
                        await this.plugin.saveSettings();
                    })
            );

        containerEl.createEl('h2', { text: 'Active tab color' });

        new Setting(containerEl)
            .setName('Color the active tab')
            .setDesc('Highlight the active tab with a custom color in light and dark mode.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.colorActiveTabEnabled)
                    .onChange(async (value) => {
                        this.plugin.settings.colorActiveTabEnabled = value;
                        await this.plugin.saveSettings();
                        this.plugin.applyActiveTabColors();
                        this.display();
                    })
            );

        if (this.plugin.settings.colorActiveTabEnabled) {
            new Setting(containerEl)
                .setName('Active tab color (light mode)')
                .addColorPicker((picker) =>
                    picker
                        .setValue(this.plugin.settings.activeTabColorLight)
                        .onChange(async (value) => {
                            this.plugin.settings.activeTabColorLight = value;
                            await this.plugin.saveSettings();
                            this.plugin.applyActiveTabColors();
                        })
                );

            new Setting(containerEl)
                .setName('Active tab color (dark mode)')
                .addColorPicker((picker) =>
                    picker
                        .setValue(this.plugin.settings.activeTabColorDark)
                        .onChange(async (value) => {
                            this.plugin.settings.activeTabColorDark = value;
                            await this.plugin.saveSettings();
                            this.plugin.applyActiveTabColors();
                        })
                );
        }
    }
}

