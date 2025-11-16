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
                    // In Obsidian’s layout JSON:
                    //  - vertical  → children act like columns (side-by-side)
                    //  - horizontal → children stacked
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
    // Rotate tab groups via layout JSON (toggle all split directions)
    // ------------------------------------------------------------------------

    private async rotateTabGroups() {
        const wsAny = this.app.workspace as any;
        if (typeof wsAny.getLayout !== 'function' || typeof wsAny.changeLayout !== 'function') {
            console.warn('[next-tab-group] rotateTabGroups: getLayout/changeLayout not available.');
            return;
        }

        const layout = wsAny.getLayout();
        if (!layout) {
            console.warn('[next-tab-group] rotateTabGroups: getLayout() returned null/undefined.');
            return;
        }

        const main = (layout as any).main ?? layout;

        const stats: LayoutRotationStats = { splitsVisited: 0, splitsFlipped: 0 };
        this.flipAllSplitsInLayout(main, false, 0, stats);

        console.log(
            `[next-tab-group] rotateTabGroups (layout): splitsVisited=${stats.splitsVisited}, splitsFlipped=${stats.splitsFlipped}`
        );

        if (stats.splitsFlipped === 0) {
            console.log('[next-tab-group] rotateTabGroups: no splits flipped; layout will not change.');
            return;
        }

        await wsAny.changeLayout(layout);
    }

    /**
     * Flip all split directions (horizontal <-> vertical) in the layout JSON tree.
     * We only walk `children` – this matches the simple version you had working
     * (side-by-side <-> stacked) without touching sidebars or other wrappers.
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

            if (after && before && after !== before) {
                if (dryRun) {
                    console.log(
                        `[next-tab-group] ${indent}Would flip split (layout): ${before} -> ${after}, children=${children?.length ?? 0}`
                    );
                } else {
                    console.log(
                        `[next-tab-group] ${indent}Flipping split (layout): ${before} -> ${after}, children=${children?.length ?? 0}`
                    );
                    (node as any).direction = after;
                }
                stats.splitsFlipped++;
            } else {
                console.log(
                    `[next-tab-group] ${indent}Split (layout) not flippable (direction=${before}); children=${children?.length ?? 0}`
                );
            }
        }

        if (Array.isArray(children)) {
            for (const child of children) {
                this.flipAllSplitsInLayout(child, dryRun, depth + 1, stats);
            }
        }
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
