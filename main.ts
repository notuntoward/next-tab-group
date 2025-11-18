import {
    Plugin,
    WorkspaceLeaf,
    WorkspaceTabs,
    ViewState
} from 'obsidian';
import type { WorkspaceParent } from 'obsidian';

export default class NextTabGroupPlugin extends Plugin {
    private tabGroupActiveLeaves: Map<WorkspaceParent, WorkspaceLeaf> = new Map();

    async onload() {
        this.addCommand({
            id: 'next-tab-group',
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
            id: 'preview-rotate-tab-groups-layout',
            name: 'Preview rotate tab groups (layout JSON, dry run)',
            callback: () => {
                this.previewRotateTabGroupsLayout();
            }
        });

        this.addCommand({
            id: 'log-layout-splits-layout',
            name: 'Log layout splits (layout JSON, debug)',
            callback: () => {
                this.logLayoutSplitsLayout();
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
        // Prefer real DOM geometry when available
        try {
            const containerEl = (leaf as any).containerEl;
            if (containerEl && containerEl.getBoundingClientRect) {
                const rect = containerEl.getBoundingClientRect();
                return { x: rect.left, y: rect.top };
            }
        } catch {
            // fall through
        }

        // Fallback: approximate via split hierarchy
        let x = 0;
        let y = 0;
        let parent: any = leaf.parent;
        let childRef: any = leaf;

        while (parent) {
            const children = (parent as any).children as any[] | undefined;
            if (parent && Array.isArray(children)) {
                const index = children.indexOf(childRef);
                if (index >= 0) {
                    const dir = (parent as any).direction;
                    // In Obsidian's layout JSON:
                    // - vertical → children act like columns (side-by-side)
                    // - horizontal → children stacked
                    if (dir === 'vertical') {
                        x += index * 1000;
                    } else if (dir === 'horizontal') {
                        y += index * 1000;
                    }
                }
            }
            childRef = parent;
            parent = parent.parent;
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
        const activeLeaf = this.app.workspace.activeLeaf;
        if (!activeLeaf) return;

        const activeTabGroup: any = activeLeaf.parent;
        if (!(activeTabGroup instanceof WorkspaceTabs)) {
            return;
        }

        const leavesToMove: WorkspaceLeaf[] = [];
        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            if (leaf.parent !== activeTabGroup) {
                leavesToMove.push(leaf);
            }
        });

        for (const leaf of leavesToMove) {
            const viewState = leaf.getViewState();
            const ephemeralState = leaf.getEphemeralState();

            const children = (activeTabGroup as any).children as WorkspaceLeaf[] | undefined;
            const index = Array.isArray(children) ? children.length : -1;

            const newLeaf = this.app.workspace.createLeafInParent(
                activeTabGroup,
                index
            );
            await newLeaf.setViewState(viewState, ephemeralState);
        }

        for (const leaf of leavesToMove) {
            leaf.detach();
        }

        this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
    }

    // ------------------------------------------------------------------------
    // Rotate tab groups by recreating the split structure
    // ------------------------------------------------------------------------

    private async rotateTabGroups() {
        const wsAny = this.app.workspace as any;
        // Get the root split
        let rootSplit = wsAny.rootSplit;
        if (!rootSplit) {
            console.warn('[next-tab-group] rotateTabGroups: no rootSplit found');
            return;
        }

        // If root split has only 1 child and that child is a split, use that child instead
        if (rootSplit.children && rootSplit.children.length === 1 && rootSplit.children[0].direction !== undefined) {
            console.log('[next-tab-group] Root split has single child split, using that as root');
            rootSplit = rootSplit.children[0];
        }

        if (!rootSplit.children || rootSplit.children.length < 2) {
            console.warn('[next-tab-group] rotateTabGroups: no valid split structure');
            return;
        }

        const oldDirection = rootSplit.direction;
        const newDirection = oldDirection === 'horizontal' ? 'vertical' : 'horizontal';
        console.log(`[next-tab-group] Rotating from ${oldDirection} to ${newDirection}`);

        // Save all leaf states and their tab group membership
        const tabGroups: Array<LeafState[]> = [];
        const seenTabGroups = new Set<WorkspaceParent>();

        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            const tabGroup = leaf.parent;
            if (!tabGroup || seenTabGroups.has(tabGroup)) return;
            seenTabGroups.add(tabGroup);

            const groupLeaves: LeafState[] = [];
            const children = (tabGroup as any).children as WorkspaceLeaf[] | undefined;
            if (Array.isArray(children)) {
                for (const childLeaf of children) {
                    const vs = childLeaf.getViewState();
                    if (!vs.type || vs.type === 'empty') continue;
                    groupLeaves.push({
                        viewState: vs,
                        ephemeralState: childLeaf.getEphemeralState(),
                        isActive: childLeaf === this.app.workspace.activeLeaf
                    });
                }
            }

            if (groupLeaves.length > 0) {
                tabGroups.push(groupLeaves);
            }
        });

        if (tabGroups.length === 0) {
            console.warn('[next-tab-group] No tab groups to rotate');
            return;
        }

        console.log(`[next-tab-group] Saved ${tabGroups.length} tab groups with [${tabGroups.map(g => g.length).join(', ')}] tabs`);

        // Collect all leaves to detach EXCEPT one that we'll use as base
        const allLeaves: WorkspaceLeaf[] = [];
        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            allLeaves.push(leaf);
        });

        // Keep the first leaf, detach the rest
        const baseLeaf = allLeaves[0];
        for (let i = 1; i < allLeaves.length; i++) {
            allLeaves[i].detach();
        }

        console.log('[next-tab-group] Detached extra leaves, keeping base leaf');

        // THE FIX: Set baseLeaf to empty FIRST, then split, then populate all leaves
        await baseLeaf.setViewState({ type: 'empty' });
        await new Promise(resolve => setTimeout(resolve, 50));

        // Now we have one empty leaf. Let's count how many groups we need
        const numGroups = tabGroups.length;

        // Create all the splits we need with empty leaves
        for (let i = 1; i < numGroups; i++) {
            const splitCommand = newDirection === 'vertical' ? 'workspace:split-vertical' : 'workspace:split-horizontal';
            this.app.workspace.setActiveLeaf(baseLeaf, { focus: false });
            (this.app as any).commands.executeCommandById(splitCommand);
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // Now collect all leaves (they should all be empty)
        const newLeaves: WorkspaceLeaf[] = [];
        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            newLeaves.push(leaf);
        });

        console.log(`[next-tab-group] Created ${newLeaves.length} empty leaves`);

        // Now populate each leaf with the correct content
        for (let groupIdx = 0; groupIdx < tabGroups.length && groupIdx < newLeaves.length; groupIdx++) {
            const group = tabGroups[groupIdx];
            const targetLeaf = newLeaves[groupIdx];

            // Set the first tab of this group
            await targetLeaf.setViewState(group[0].viewState, group[0].ephemeralState);
            const targetTabGroup = targetLeaf.parent;

            // Add remaining tabs to this group
            for (let i = 1; i < group.length; i++) {
                const leaf = this.app.workspace.createLeafInParent(targetTabGroup, i);
                await leaf.setViewState(group[i].viewState, group[i].ephemeralState);
            }

            console.log(`[next-tab-group] Group ${groupIdx} populated with ${group.length} tabs`);
        }

        // Restore active leaf
        let activeLeafRestored = false;
        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            const viewState = leaf.getViewState();
            for (const group of tabGroups) {
                for (const state of group) {
                    if (state.isActive && viewState.type === state.viewState.type) {
                        const stateFile = (state.viewState.state as any)?.file;
                        const leafFile = (viewState.state as any)?.file;
                        if (stateFile === leafFile) {
                            this.app.workspace.setActiveLeaf(leaf, { focus: true });
                            activeLeafRestored = true;
                            return;
                        }
                    }
                }
            }
        });

        console.log(`[next-tab-group] Rotation complete, active leaf restored: ${activeLeafRestored}`);
    }

    // ------------------------------------------------------------------------
    // Debug: preview & split logging on layout JSON
    // ------------------------------------------------------------------------

    private previewRotateTabGroupsLayout() {
        const wsAny = this.app.workspace as any;
        const layout = wsAny.getLayout?.();
        if (!layout) {
            console.log('[next-tab-group] previewRotateTabGroupsLayout: no layout.');
            return;
        }

        const main = (layout as any).main ?? layout;
        console.log('--- Preview: rotate tab groups (layout JSON, dry run) ---');

        const copy = JSON.parse(JSON.stringify(main));
        const stats: LayoutRotationStats = { splitsVisited: 0, splitsFlipped: 0 };
        this.flipAllSplitsInLayout(copy, true, 0, stats);

        console.log(
            `[next-tab-group] Preview (layout): splitsVisited=${stats.splitsVisited}, splitsFlipped=${stats.splitsFlipped}`
        );
        console.log('--- End of preview ---');
    }

    /**
     * Flip split directions in layout JSON (for preview/debug commands only)
     */
    private flipAllSplitsInLayout(
        node: any,
        dryRun: boolean,
        depth: number,
        stats: LayoutRotationStats
    ): void {
        if (!node || typeof node !== 'object') return;

        const indent = '  '.repeat(depth);
        const children = (node as any).children as any[] | undefined;

        if (node.type === 'split') {
            stats.splitsVisited++;
            const before: string | undefined = node.direction;
            let after = before;

            if (before === 'horizontal') after = 'vertical';
            else if (before === 'vertical') after = 'horizontal';

            if (dryRun) {
                console.log(
                    `[next-tab-group] ${indent}Would flip split (layout): ${before} -> ${after}, children=${children?.length ?? 0}`
                );
            } else {
                console.log(
                    `[next-tab-group] ${indent}Flipping split (layout): ${before} -> ${after}, children=${children?.length ?? 0}`
                );
                node.direction = after;
            }

            stats.splitsFlipped++;
        }

        if (Array.isArray(children)) {
            for (const child of children) {
                this.flipAllSplitsInLayout(child, dryRun, depth + 1, stats);
            }
        }
    }

    private logLayoutSplitsLayout() {
        const wsAny = this.app.workspace as any;
        const layout = wsAny.getLayout?.();
        if (!layout) {
            console.log('[next-tab-group] logLayoutSplitsLayout: no layout.');
            return;
        }

        const main = (layout as any).main ?? layout;
        console.log('--- Layout splits (layout JSON) ---');
        this.logSplitsInLayout(main, 0);
        console.log('--- End of layout splits ---');
    }

    private logSplitsInLayout(node: any, depth: number) {
        if (!node || typeof node !== 'object') return;

        const indent = '  '.repeat(depth);
        const children = (node as any).children as any[] | undefined;

        if (node.type === 'split') {
            console.log(
                `${indent}split: direction=${node.direction ?? 'undefined'}, children=${children?.length ?? 0}`
            );
        }

        if (Array.isArray(children)) {
            for (const child of children) {
                this.logSplitsInLayout(child, depth + 1);
            }
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

interface LayoutRotationStats {
    splitsVisited: number;
    splitsFlipped: number;
}

interface LeafState {
    viewState: ViewState;
    ephemeralState: any;
    isActive: boolean;
}
