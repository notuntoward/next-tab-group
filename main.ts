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

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface NextTabGroupSettings {
    confirmDedupeGroup: boolean;
    confirmDedupeAllGroups: boolean;
    confirmDedupeAllWindows: boolean;
}

const DEFAULT_SETTINGS: NextTabGroupSettings = {
    confirmDedupeGroup: false,
    confirmDedupeAllGroups: true,
    confirmDedupeAllWindows: true,
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

interface ObsidianWorkspaceInternal {
    activeLeaf: WorkspaceLeafInternal | null;
    rootSplit: WorkspaceContainerEl;
    getLayout(): WorkspaceLayout;
    setLayout(layout: WorkspaceLayout): Promise<void>;
    setActiveLeaf(leaf: WorkspaceLeaf, opts: { focus: boolean }): void;
}

interface WorkspaceLayout {
    main: WorkspaceLayoutNode;
    left?: WorkspaceLayoutNode;
    right?: WorkspaceLayoutNode;
    floating?: Record<string, WorkspaceLayoutNode>;
}

interface WorkspaceLayoutNode {
    id?: string;
    type: string;
    direction?: string;
    children?: WorkspaceLayoutNode[];
    currentTab?: number;
    state?: Record<string, unknown>;
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
// Plugin
// ---------------------------------------------------------------------------

export default class NextTabGroupPlugin extends Plugin {
    private tabGroupActiveLeaves: Map<WorkspaceParent, WorkspaceLeaf> = new Map();
    private leafLastActive: Map<string, number> = new Map();
    settings: NextTabGroupSettings = { ...DEFAULT_SETTINGS };

    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        this.addCommand({
            id: 'next',
            name: 'Next',
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

        this.loadStyleSheet();

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
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    private async loadStyleSheet() {
        const adapter = this.app.vault.adapter;
        let cssPath: string | null = null;
        for (const candidate of [`${this.manifest.dir}/styles.css`, 'styles.css']) {
            if (await adapter.exists(candidate)) {
                cssPath = candidate;
                break;
            }
        }
        if (!cssPath) return;

        try {
            const css = await adapter.read(cssPath);
            const styleEl = document.createElement('style');
            styleEl.setAttribute('data-ntg-styles', '');
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
            this.register(() => styleEl.remove());
        } catch (error) {
            console.error('[next-tab-group] Failed to load styles.css:', error);
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

    private collectLeavesWithPosition(workspace: Workspace): LeafPosition[] {
        const positions: LeafPosition[] = [];
        const allLeaves: WorkspaceLeaf[] = [];

        workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            allLeaves.push(leaf);
        });

        const seenTabGroups = new Set<WorkspaceParent>();
        for (const leaf of allLeaves) {
            const tabGroup = leaf.parent;
            if (!tabGroup || seenTabGroups.has(tabGroup)) continue;
            seenTabGroups.add(tabGroup);

            const position = this.getRelativePosition(leaf);
            positions.push({
                leaf,
                tabGroup,
                position
            });
        }

        return positions;
    }

    private getRelativePosition(leaf: WorkspaceLeaf): { x: number; y: number } {
        // Use real DOM boundaries
        try {
            const tabGroup = leaf.parent as WorkspaceContainerEl | null;
            const containerEl = tabGroup?.containerEl;
            if (containerEl && containerEl.instanceOf(HTMLElement)) {
                const rect = containerEl.getBoundingClientRect();
                return { x: rect.left, y: rect.top };
            }
        } catch {
            // fall through to fallback
        }

        // Fallback: approximate via split hierarchy
        let x = 0;
        let y = 0;
        let parent: WorkspaceContainerEl | null = leaf.parent as WorkspaceContainerEl | null;
        let childRef: WorkspaceContainerEl | WorkspaceLeaf = leaf;

        while (parent) {
            const children = parent.children;
            if (Array.isArray(children)) {
                const index = children.indexOf(childRef as WorkspaceContainerEl);
                if (index >= 0) {
                    const dir = parent.direction;
                    if (dir === 'vertical') {
                        x += index * 1000;
                    } else if (dir === 'horizontal') {
                        y += index * 1000;
                    }
                }
            }
            childRef = parent;
            parent = parent.parent as WorkspaceContainerEl | null;
        }

        return { x, y };
    }

    private sortLeavesSpatially(positions: LeafPosition[]): LeafPosition[] {
        return positions.sort((a, b) => {
            const yDiff = a.position.y - b.position.y;
            if (Math.abs(yDiff) > 50) return yDiff;
            return a.position.x - b.position.x;
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

    private buildTabGroupInfos(
        leaves: WorkspaceLeaf[],
        activeLeaf: WorkspaceLeaf | null,
    ): TabGroupInfo[] {
        const byGroup = new Map<WorkspaceParent, WorkspaceLeaf[]>();

        for (const leaf of leaves) {
            const group = leaf.parent;
            if (!group) continue;

            const groupLeaves = byGroup.get(group);
            if (groupLeaves) {
                groupLeaves.push(leaf);
            } else {
                byGroup.set(group, [leaf]);
            }
        }

        const activeGroup = activeLeaf?.parent ?? null;
        const activeGroupRect = activeGroup
            ? this.getTabGroupRect(activeGroup as WorkspaceContainerEl)
            : null;

        const infos: TabGroupInfo[] = [];

        for (const [group, groupLeaves] of byGroup) {
            const representative = this.pickMostRecent(groupLeaves);
            const isCurrentGroup = group === activeGroup;
            const groupRect = this.getTabGroupRect(group as WorkspaceContainerEl);

            let relativeLabel: string | null = null;
            if (!isCurrentGroup && groupRect && activeGroupRect) {
                relativeLabel = this.capitalizeFirst(
                    this.relativePosition(groupRect, activeGroupRect),
                );
                if (relativeLabel === "another group") {
                    relativeLabel = null;
                }
            }

            infos.push({
                group,
                leaves: groupLeaves,
                representative,
                lastActive: this.getLeafLastActive(representative),
                label: this.formatTabGroupLabel(
                    representative,
                    groupLeaves.length,
                    isCurrentGroup,
                    relativeLabel,
                ),
                relativeLabel,
                isCurrentGroup,
                window: representative.getContainer()?.win,
            });
        }

        return infos.sort((a, b) => {
            const recency = b.lastActive - a.lastActive;
            if (recency !== 0) return recency;
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

    private getTabSearchText(tab: TabInfo): string {
        return `${tab.leaf.getDisplayText()} ${tab.group.label}`;
    }

    private cycleTabGroups() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const workspace = activeLeaf ? this.getWorkspaceForLeaf(activeLeaf) : this.app.workspace;

        const positions = this.collectLeavesWithPosition(workspace);
        if (positions.length <= 1) {
            return;
        }

        const sorted = this.sortLeavesSpatially(positions);

        if (!activeLeaf) {
            this.focusTabGroup(sorted[0], workspace);
            return;
        }

        const activeTabGroup = activeLeaf.parent as WorkspaceParent | null;
        if (activeTabGroup) {
            this.tabGroupActiveLeaves.set(activeTabGroup, activeLeaf);
        }

        const currentIndex = sorted.findIndex(pos => pos.tabGroup === activeTabGroup);
        if (currentIndex === -1) {
            this.focusTabGroup(sorted[0], workspace);
            return;
        }

        const nextIndex = (currentIndex + 1) % sorted.length;
        this.focusTabGroup(sorted[nextIndex], workspace);
    }

    private focusTabGroup(position: LeafPosition, workspace: Workspace) {
        const tabGroup = position.tabGroup;
        const storedLeaf = this.tabGroupActiveLeaves.get(tabGroup);

        if (storedLeaf && storedLeaf.parent === tabGroup) {
            workspace.setActiveLeaf(storedLeaf, { focus: true });
            return;
        }

        workspace.setActiveLeaf(position.leaf, { focus: true });
    }

    // ------------------------------------------------------------------------
    // Collect tabs into the active tab group
    // ------------------------------------------------------------------------

    private async collectTabs() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const workspace = activeLeaf ? this.getWorkspaceForLeaf(activeLeaf) : this.app.workspace;
        const ws = workspace as unknown as ObsidianWorkspaceInternal;

        // 1. Get the FULL current layout (includes left, right, floating, and main)
        const layout = ws.getLayout();

        // 2. Extract leaves ONLY from the MAIN area
        // We specifically target 'layout.main' so we don't accidentally
        // collect tabs from the sidebars (like the File Explorer or Outline).
        const mainRoot = layout.main;
        const allLeaves: WorkspaceLayoutNode[] = [];
        this.extractLeaves(mainRoot, allLeaves);

        if (allLeaves.length <= 1) {
            return;
        }

        // 3. Prepare the new Main Layout structure
        const activeLeafId = activeLeaf ? (activeLeaf as WorkspaceLeafInternal).id : null;

        const newMain: WorkspaceLayoutNode = {
            id: 'root-split',
            type: 'split',
            direction: 'vertical',
            children: [
                {
                    type: 'tabs',
                    children: allLeaves,
                    currentTab: activeLeafId ? allLeaves.findIndex(l => l.id === activeLeafId) : 0
                }
            ]
        };

        // 4. Update the layout object IN PLACE
        // CRITICAL: This keeps layout.left and layout.right untouched,
        // preventing sidebars from resetting or popping open.
        layout.main = newMain;

        // 5. Apply
        await ws.setLayout(layout);

        // 6. Restore Focus
        if (activeLeaf) {
            ws.setActiveLeaf(activeLeaf, { focus: true });
        }
    }

    // Helper to extract all leaves from a node tree
    private extractLeaves(node: WorkspaceLayoutNode, collection: WorkspaceLayoutNode[]) {
        if (!node || typeof node !== 'object') return;

        if (node.type === 'leaf') {
            collection.push(node);
            return;
        }

        if (node.children && Array.isArray(node.children)) {
            for (const child of node.children) {
                this.extractLeaves(child, collection);
            }
        }
    }

    // ------------------------------------------------------------------------
    // ------------------------------------------------------------------------
    // Rotate tab groups — getLayout/setLayout, with pop-out safety guards
    //
    // Two guards before we touch the workspace layout:
    //  1. Active leaf must be in the MAIN window. Pop-out windows are simply
    //     skipped with a notice (per user direction: don't fight pop-outs).
    //  2. There must be no pop-out windows in the layout at all. setLayout()
    //     rebuilds the entire workspace from the layout object, and any
    //     floating entries cause it to create new pop-out windows, duplicating
    //     the ones already open. With zero pop-outs, setLayout() only rebuilds
    //     the main editor area.
    // ------------------------------------------------------------------------

    private async rotateTabGroups() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        if (!activeLeaf) return;

        if (!this.isMainWindow(activeLeaf)) {
            new Notice('Rotate tab groups only works in the main Obsidian window.');
            return;
        }

        const ws = this.app.workspace as unknown as ObsidianWorkspaceInternal;
        const layout = ws.getLayout();
        if (!layout.main) return;

        if (layout.floating && Object.keys(layout.floating).length > 0) {
            new Notice('Close pop-out windows before rotating tab groups.');
            return;
        }

        const rotatedMain = JSON.parse(JSON.stringify(layout.main)) as WorkspaceLayoutNode;
        this.rotateLayoutNode(rotatedMain);
        this.stripSplitIds(rotatedMain);

        layout.main = rotatedMain;
        await ws.setLayout(layout);
    }

    private rotateLayoutNode(node: WorkspaceLayoutNode): void {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'split' && Array.isArray(node.children)) {
            if (node.direction === 'horizontal') {
                node.direction = 'vertical';
                node.children.reverse();
            } else if (node.direction === 'vertical') {
                node.direction = 'horizontal';
            }
            for (const child of node.children) {
                this.rotateLayoutNode(child);
            }
        }
    }

    private stripSplitIds(node: WorkspaceLayoutNode): void {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'split') {
            delete node.id;
        }
        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                this.stripSplitIds(child);
            }
        }
    }

    private isMainWindow(leaf: WorkspaceLeaf): boolean {
        const container = leaf.getContainer();
        return (container as unknown as { win?: Window }).win === window;
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
        const root = document.createElement('div');
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

        const summary = document.createElement('p');
        summary.classList.add('ntg-dedupe-summary');
        summary.textContent = `Will close ${totalRemoved} duplicate tab${totalRemoved === 1 ? '' : 's'} of ${entries.length} note${entries.length === 1 ? '' : 's'}.`;
        root.appendChild(summary);

        if (entries.length > 0) {
            const list = document.createElement('ul');
            list.classList.add('ntg-dedupe-list');
            root.appendChild(list);
            for (const entry of entries) {
                const li = document.createElement('li');
                li.classList.add('ntg-dedupe-item');
                list.appendChild(li);

                const name = document.createElement('span');
                name.classList.add('ntg-dedupe-name');
                name.textContent = this.basename(entry.file);
                li.appendChild(name);

                const tail = document.createElement('span');
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
        if (!activeLeaf || !activeLeaf.parent) return;

        // Read the tab group's children directly. Each child of a
        // WorkspaceTabs parent is a WorkspaceLeaf.
        const tabGroup = activeLeaf.parent as WorkspaceContainerEl;
        const leaves = (tabGroup.children ?? []) as unknown as WorkspaceLeaf[];
        await this.runDedupe(leaves, activeLeaf, this.settings.confirmDedupeGroup, 'Deduplicate tabs in group');
    }

    private async dedupeInAllGroups() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const workspace = activeLeaf ? this.getWorkspaceForLeaf(activeLeaf) : this.app.workspace;

        // Pop-out windows live in the workspace's `floating` section, not under
        // the root split, so `iterateRootLeaves()` skips them entirely. To make
        // "all groups" actually mean "all groups in the focused window", scan
        // every leaf and keep only those that belong to the same window as the
        // active leaf. With no active leaf, fall back to the main window's
        // root split so we don't silently expand scope to all windows.
        const activeWin = activeLeaf ? activeLeaf.getContainer()?.win : undefined;
        const leaves: WorkspaceLeaf[] = [];
        if (activeWin) {
            workspace.iterateAllLeaves((leaf) => {
                const container = leaf.getContainer();
                if (!container) return;
                if (container.win !== activeWin) return;
                leaves.push(leaf);
            });
        } else {
            workspace.iterateRootLeaves((leaf) => {
                leaves.push(leaf);
            });
        }
        await this.runDedupe(leaves, activeLeaf, this.settings.confirmDedupeAllGroups, 'Deduplicate tabs in all groups');
    }

    private async dedupeInAllWindows() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();

        const leaves: WorkspaceLeaf[] = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
            leaves.push(leaf);
        });
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
        const leaves = this.getActiveTabGroupLeaves();

        if (!leaves || leaves.length === 0) {
            new Notice("No tabs in the active tab group to switch to.");
            return;
        }

        const newestFirst = [...leaves].sort(
            (a, b) => this.compareRecency(b, a),
        );

        new NavigationSuggestModal(
            this.app,
            newestFirst,
            "Switch to tab in group",
            (leaf) => leaf.getDisplayText(),
            (leaf) => this.app.workspace.setActiveLeaf(leaf, { focus: true }),
        ).open();
    }

    private switchToAnyTab(): void {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const leaves = this.getLeavesInFocusedWindow();

        if (leaves.length === 0) {
            new Notice("No tabs in this window to switch to.");
            return;
        }

        const groups = this.buildTabGroupInfos(leaves, activeLeaf);
        const tabs = this.buildTabInfos(groups);

        new NavigationSuggestModal(
            this.app,
            tabs,
            "Switch to any tab",
            (tab) => this.getTabSearchText(tab),
            (tab) => this.app.workspace.setActiveLeaf(tab.leaf, { focus: true }),
        ).open();
    }

    private activateTabGroup(
        group: WorkspaceParent,
        fallbackLeaf: WorkspaceLeaf,
    ): void {
        const storedLeaf = this.tabGroupActiveLeaves.get(group);

        if (storedLeaf && storedLeaf.parent === group) {
            this.app.workspace.setActiveLeaf(storedLeaf, { focus: true });
            return;
        }

        this.app.workspace.setActiveLeaf(fallbackLeaf, { focus: true });
    }

    private switchToTabGroup(): void {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const leaves = this.getLeavesInFocusedWindow();
        const groups = this.buildTabGroupInfos(leaves, activeLeaf);

        if (groups.length === 0) {
            new Notice("No tab groups in this window to switch to.");
            return;
        }

        new NavigationSuggestModal(
            this.app,
            groups,
            "Switch to tab group",
            (group) => `${group.label} ${group.representative.getDisplayText()}`,
            (group) => this.activateTabGroup(group.group, group.representative),
        ).open();
    }

    private formatWindowLabel(
        win: Window | undefined,
        groups: TabGroupInfo[],
        representative: WorkspaceLeaf,
    ): string {
        const isMain = win === window;
        const role = isMain ? "Main window" : "Pop-out";
        const title = representative.getDisplayText() || "Untitled tab";

        if (isMain) return `${role} — ${title}`;

        const count = `${groups.length} group${groups.length === 1 ? "" : "s"}`;
        return `${role} — ${title} · ${count}`;
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

        for (const [win, windowGroups] of byWindow) {
            const sortedGroups = [...windowGroups].sort((a, b) => {
                const recency = b.lastActive - a.lastActive;
                if (recency !== 0) return recency;
                return a.label.localeCompare(b.label);
            });

            const representative = sortedGroups[0].representative;

            windows.push({
                window: win,
                groups: sortedGroups,
                representative,
                lastActive: this.getLeafLastActive(representative),
                label: this.formatWindowLabel(win, sortedGroups, representative),
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

        const allLeaves: WorkspaceLeaf[] = [];
        this.app.workspace.iterateAllLeaves((leaf) => allLeaves.push(leaf));

        const groups = this.buildTabGroupInfos(allLeaves, activeLeaf);
        const windows = this.buildWindowInfos(groups, activeLeaf);

        if (windows.length === 0) {
            new Notice("No Obsidian windows to switch to.");
            return;
        }

        new NavigationSuggestModal(
            this.app,
            windows,
            "Switch to window",
            (item) => `${item.label} ${item.representative.getDisplayText()}`,
            (item) =>
                this.app.workspace.setActiveLeaf(item.representative, {
                    focus: true,
                }),
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

        const buttonRow = document.createElement('div');
        buttonRow.classList.add('ntg-dedupe-buttons');
        this.contentEl.appendChild(buttonRow);

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        buttonRow.appendChild(cancelBtn);

        const okBtn = document.createElement('button');
        okBtn.textContent = 'Close tabs';
        okBtn.classList.add('mod-warning');
        buttonRow.appendChild(okBtn);

        const finish = (ok: boolean) => {
            this.resolve(ok);
            this.close();
        };
        cancelBtn.addEventListener('click', () => finish(false));
        okBtn.addEventListener('click', () => finish(true));

        this.scope.register([], 'Escape', () => { finish(false); return false; });
        this.scope.register([], 'Enter', () => { finish(true); return false; });
    }
}

// ---------------------------------------------------------------------------
// Reusable suggestion modal
// ---------------------------------------------------------------------------

class NavigationSuggestModal<T> extends FuzzySuggestModal<T> {
    constructor(
        app: App,
        private readonly items: T[],
        placeholder: string,
        private readonly getSearchText: (item: T) => string,
        private readonly onChoose: (item: T) => void,
    ) {
        super(app);
        this.setPlaceholder(placeholder);
    }

    getItems(): T[] {
        return this.items;
    }

    getItemText(item: T): string {
        return this.getSearchText(item);
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
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LeafPosition {
    leaf: WorkspaceLeaf;
    tabGroup: WorkspaceParent;
    position: { x: number; y: number };
}
