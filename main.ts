import {
    Modal,
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
}

interface WorkspaceLayoutNode {
    id?: string;
    type: string;
    direction?: string;
    children?: WorkspaceLayoutNode[];
    currentTab?: number;
    state?: Record<string, unknown>;
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

        this.addSettingTab(new NextTabGroupSettingTab(this.app, this));

        this.loadStyleSheet();

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (leaf) {
                    const internal = leaf as WorkspaceLeafInternal;
                    if (internal.id) {
                        this.leafLastActive.set(internal.id, Date.now());
                    }
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
     * Get the workspace that owns a leaf. Each window has its own workspace,
     * so this lets commands target the window containing the leaf instead of
     * always using the main window's workspace.
     */
    private getWorkspaceForLeaf(leaf: WorkspaceLeaf): Workspace {
        const internal = leaf as unknown as WorkspaceItemInternal;
        return internal.workspace ?? this.app.workspace;
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

        if (leafInFocusedWindow) {
            const ws = this.getWorkspaceForLeaf(leafInFocusedWindow);
            return ws.activeLeaf;
        }

        return globalActive;
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
    // Rotate tab groups - Smart Wrapper Strategy
    // ------------------------------------------------------------------------

    /**
     * Rotate workspace layout 90° clockwise using smart wrapper strategy.
     * Works around root split's immutable direction by wrapping content.
     */
    private async rotateTabGroups() {
        // SAVE: Active tab for restoration
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const workspace = activeLeaf ? this.getWorkspaceForLeaf(activeLeaf) : this.app.workspace;
        let activeFileInfo: { file: string | null, type: string } | null = null;
        if (activeLeaf) {
            const vs = activeLeaf.getViewState();
            activeFileInfo = {
                file: (vs.state as Record<string, unknown>)?.['file'] as string | null ?? null,
                type: vs.type
            };
        }

        // Get current layout
        const wsInternal = workspace as unknown as ObsidianWorkspaceInternal;
        const layout = wsInternal.getLayout?.();
        if (!layout || !layout.main) {
            console.error('[next-tab-group] Failed to get layout');
            return;
        }

        const root = layout.main;

        // Detect if root is already wrapped
        const isWrapped = this.isAlreadyWrapped(root);

        let rotatedLayout: WorkspaceLayout;

        if (isWrapped) {
            // Already wrapped - rotate the wrapper content directly
            rotatedLayout = JSON.parse(JSON.stringify(layout)) as WorkspaceLayout;
            const wrapper = rotatedLayout.main.children?.[0];
            if (wrapper) {
                this.transformNodeForClockwiseRotation(wrapper, workspace);
                this.stripSplitIds(wrapper);
            }
        } else {
            // Not wrapped - need to wrap the rotated content
            const transformedRoot = JSON.parse(JSON.stringify(root)) as WorkspaceLayoutNode;
            this.transformNodeForClockwiseRotation(transformedRoot, workspace);
            this.stripSplitIds(transformedRoot);

            // Wrap in a new split container
            rotatedLayout = {
                ...layout,
                main: {
                    type: 'split',
                    direction: root.direction,
                    children: [transformedRoot]
                }
            };
        }

        // Apply the layout
        try {
            await wsInternal.setLayout(rotatedLayout);
        } catch (error) {
            console.error('[next-tab-group] Failed to apply layout:', error);
            return;
        }

        // Wait for layout to settle
        await new Promise(resolve => window.setTimeout(resolve, 100));

        // RESTORE: Active tab focus
        if (activeFileInfo) {
            this.restoreActiveTab(activeFileInfo, workspace);
        }
    }

    /**
     * Check if root is already wrapped (has single split child).
     */
    private isAlreadyWrapped(root: WorkspaceLayoutNode): boolean {
        if (!root || root.type !== 'split' || !Array.isArray(root.children)) {
            return false;
        }

        if (root.children.length === 1) {
            const child = root.children[0];
            return child !== undefined && child.type === 'split';
        }

        return false;
    }

    /**
     * Strip IDs from split nodes to force Obsidian to recreate them.
     * Keep IDs on leaf/tabs nodes to preserve tab contents.
     */
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

    /**
     * Transform a node for 90° clockwise rotation.
     * Rules: horizontal→vertical (reverse children), vertical→horizontal (keep order)
     */
    private transformNodeForClockwiseRotation(node: WorkspaceLayoutNode, workspace: Workspace): void {
        if (!node || typeof node !== 'object') return;

        if (node.type === 'split' && Array.isArray(node.children)) {
            let direction = node.direction;

            if (!direction) {
                const splitEl = this.findSplitElement(node.id ?? '', workspace);
                if (splitEl) {
                    direction = this.inferSplitDirection(splitEl) ?? undefined;
                }
                if (!direction) {
                    console.warn('[next-tab-group] Could not detect split direction, assuming vertical');
                    direction = 'vertical';
                }
            }

            const originalDirection = direction;

            if (originalDirection === 'horizontal') {
                node.direction = 'vertical';
                node.children.reverse();
            } else if (originalDirection === 'vertical') {
                node.direction = 'horizontal';
            }

            for (const child of node.children) {
                this.transformNodeForClockwiseRotation(child, workspace);
            }
        }
    }

    /**
     * Find the workspace split element by ID.
     */
    private findSplitElement(splitId: string, workspace: Workspace): WorkspaceContainerEl | null {
        if (!splitId) return null;
        const wsInternal = workspace as unknown as ObsidianWorkspaceInternal;
        if (wsInternal.rootSplit) {
            return this.findSplitById(wsInternal.rootSplit, splitId);
        }
        return null;
    }

    /**
     * Recursively search for a split by ID.
     */
    private findSplitById(split: WorkspaceContainerEl, targetId: string): WorkspaceContainerEl | null {
        if (!split) return null;
        if ((split as WorkspaceContainerEl & { id?: string }).id === targetId) return split;
        if (split.children) {
            for (const child of split.children) {
                const found = this.findSplitById(child, targetId);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Infer split direction from the workspace split object.
     */
    private inferSplitDirection(split: WorkspaceContainerEl): string | null {
        if (split.direction) return split.direction;
        const containerEl = split.containerEl;
        if (containerEl && containerEl.instanceOf(HTMLElement)) {
            if (containerEl.classList.contains('mod-vertical')) return 'vertical';
            if (containerEl.classList.contains('mod-horizontal')) return 'horizontal';
        }
        return null;
    }

    /**
     * Restore focus to the originally active tab.
     */
    private restoreActiveTab(activeFileInfo: { file: string | null, type: string }, workspace: Workspace) {
        let restored = false;
        workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            if (restored) return;
            const vs = leaf.getViewState();
            if (vs.type !== activeFileInfo.type) return;

            const leafFile = (vs.state as Record<string, unknown>)?.['file'] as string | undefined;
            if (activeFileInfo.file && leafFile === activeFileInfo.file) {
                workspace.setActiveLeaf(leaf, { focus: true });
                restored = true;
            } else if (!activeFileInfo.file && vs.type === activeFileInfo.type) {
                workspace.setActiveLeaf(leaf, { focus: true });
                restored = true;
            }
        });

        if (!restored) {
            console.warn(`[next-tab-group] Could not restore focus to: ${activeFileInfo.file || activeFileInfo.type}`);
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

        const leaves: WorkspaceLeaf[] = [];
        workspace.iterateRootLeaves((leaf) => {
            leaves.push(leaf);
        });
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
