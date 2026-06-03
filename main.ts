import {
    Plugin,
    WorkspaceLeaf,
} from 'obsidian';
import type { WorkspaceParent } from 'obsidian';

// Internal Obsidian structures not exposed in the public API
interface WorkspaceLeafInternal extends WorkspaceLeaf {
    id: string;
}

interface WorkspaceContainerEl extends WorkspaceParent {
    containerEl: HTMLElement;
    direction?: string;
    children?: WorkspaceContainerEl[];
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

export default class NextTabGroupPlugin extends Plugin {
    private tabGroupActiveLeaves: Map<WorkspaceParent, WorkspaceLeaf> = new Map();

    async onload() {
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
    }

    // ------------------------------------------------------------------------
    // Tab group discovery & navigation
    // ------------------------------------------------------------------------

    private collectLeavesWithPosition(): LeafPosition[] {
        const positions: LeafPosition[] = [];
        const allLeaves: WorkspaceLeaf[] = [];

        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
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
        const positions = this.collectLeavesWithPosition();
        if (positions.length <= 1) {
            return;
        }

        const sorted = this.sortLeavesSpatially(positions);
        const activeLeaf = this.app.workspace.activeLeaf;

        if (!activeLeaf) {
            this.focusTabGroup(sorted[0]);
            return;
        }

        const activeTabGroup = activeLeaf.parent as WorkspaceParent | null;
        if (activeTabGroup) {
            this.tabGroupActiveLeaves.set(activeTabGroup, activeLeaf);
        }

        const currentIndex = sorted.findIndex(pos => pos.tabGroup === activeTabGroup);
        if (currentIndex === -1) {
            this.focusTabGroup(sorted[0]);
            return;
        }

        const nextIndex = (currentIndex + 1) % sorted.length;
        this.focusTabGroup(sorted[nextIndex]);
    }

    private focusTabGroup(position: LeafPosition) {
        const tabGroup = position.tabGroup;
        const storedLeaf = this.tabGroupActiveLeaves.get(tabGroup);

        if (storedLeaf && storedLeaf.parent === tabGroup) {
            this.app.workspace.setActiveLeaf(storedLeaf, { focus: true });
            return;
        }

        this.app.workspace.setActiveLeaf(position.leaf, { focus: true });
    }

    // ------------------------------------------------------------------------
    // Collect tabs into the active tab group
    // ------------------------------------------------------------------------

    private async collectTabs() {
        const ws = this.app.workspace as unknown as ObsidianWorkspaceInternal;
        const activeLeaf = ws.activeLeaf;

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
        const activeLeafId = activeLeaf ? activeLeaf.id : null;

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
        const activeLeaf = this.app.workspace.activeLeaf;
        let activeFileInfo: { file: string | null, type: string } | null = null;
        if (activeLeaf) {
            const vs = activeLeaf.getViewState();
            activeFileInfo = {
                file: (vs.state as Record<string, unknown>)?.['file'] as string | null ?? null,
                type: vs.type
            };
        }

        // Get current layout
        const wsInternal = this.app.workspace as unknown as ObsidianWorkspaceInternal;
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
                this.transformNodeForClockwiseRotation(wrapper);
                this.stripSplitIds(wrapper);
            }
        } else {
            // Not wrapped - need to wrap the rotated content
            const transformedRoot = JSON.parse(JSON.stringify(root)) as WorkspaceLayoutNode;
            this.transformNodeForClockwiseRotation(transformedRoot);
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
            this.restoreActiveTab(activeFileInfo);
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
    private transformNodeForClockwiseRotation(node: WorkspaceLayoutNode): void {
        if (!node || typeof node !== 'object') return;

        if (node.type === 'split' && Array.isArray(node.children)) {
            let direction = node.direction;

            if (!direction) {
                const splitEl = this.findSplitElement(node.id ?? '');
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
                this.transformNodeForClockwiseRotation(child);
            }
        }
    }

    /**
     * Find the workspace split element by ID.
     */
    private findSplitElement(splitId: string): WorkspaceContainerEl | null {
        if (!splitId) return null;
        const wsInternal = this.app.workspace as unknown as ObsidianWorkspaceInternal;
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
    private restoreActiveTab(activeFileInfo: { file: string | null, type: string }) {
        let restored = false;
        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            if (restored) return;
            const vs = leaf.getViewState();
            if (vs.type !== activeFileInfo.type) return;

            const leafFile = (vs.state as Record<string, unknown>)?.['file'] as string | undefined;
            if (activeFileInfo.file && leafFile === activeFileInfo.file) {
                this.app.workspace.setActiveLeaf(leaf, { focus: true });
                restored = true;
            } else if (!activeFileInfo.file && vs.type === activeFileInfo.type) {
                this.app.workspace.setActiveLeaf(leaf, { focus: true });
                restored = true;
            }
        });

        if (!restored) {
            console.warn(`[next-tab-group] Could not restore focus to: ${activeFileInfo.file || activeFileInfo.type}`);
        }
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