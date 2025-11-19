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
        // Use real DOM boundaries
        try {
            const tabGroup = leaf.parent;
            const containerEl = (tabGroup as any).containerEl;
            if (containerEl && containerEl.getBoundingClientRect) {
                const rect = containerEl.getBoundingClientRect();
                return { x: rect.left, y: rect.top };
            }
        } catch {
            // fall through to fallback
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
    // Rotate tab groups - COMPLETE FIX
    // ------------------------------------------------------------------------

    private async rotateTabGroups() {
        console.log('[next-tab-group] ===== ROTATION START =====');

        // SAVE: Active tab info for restoration
        const activeLeaf = this.app.workspace.activeLeaf;
        let activeFileInfo: {file: string | null, type: string} | null = null;
        if (activeLeaf) {
            const vs = activeLeaf.getViewState();
            activeFileInfo = {
                file: (vs.state as any)?.file || null,
                type: vs.type
            };
            console.log(`[next-tab-group] Active tab: ${activeFileInfo.file || activeFileInfo.type}`);
        }

        // Build spatial grid using DOM boundaries
        const grid = this.buildSpatialGrid();

        if (!grid || grid.length === 0) {
            console.error('[next-tab-group] Failed to build spatial grid');
            return;
        }

        const rows = grid.length;
        const cols = grid[0].length;
        console.log(`[next-tab-group] Current: ${rows} rows × ${cols} cols`);

        // Rotate grid 90° clockwise
        const rotatedGrid = this.rotateGrid90Clockwise(grid);
        const newRows = rotatedGrid.length;
        const newCols = rotatedGrid[0].length;
        console.log(`[next-tab-group] Target: ${newRows} rows × ${newCols} cols`);

        // Rebuild using two-pass approach to avoid overwriting
        await this.rebuildFromGrid(rotatedGrid);

        // RESTORE: Active tab focus
        if (activeFileInfo) {
            this.restoreActiveTab(activeFileInfo);
        }

        console.log('[next-tab-group] ===== ROTATION COMPLETE =====');
    }

    /**
     * Build spatial grid using DOM boundaries
     */
    private buildSpatialGrid(): LeafState[][][] | null {
        const groupsWithPos: Array<{
            group: LeafState[], 
            pos: {x: number, y: number},
            bounds: {left: number, top: number, right: number, bottom: number}
        }> = [];
        const seenTabGroups = new Set<WorkspaceParent>();

        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            const tabGroup = leaf.parent;
            if (!tabGroup || seenTabGroups.has(tabGroup)) return;
            seenTabGroups.add(tabGroup);

            // Get DOM boundaries
            const containerEl = (tabGroup as any).containerEl;
            let bounds = {left: 0, top: 0, right: 0, bottom: 0};
            let position = {x: 0, y: 0};

            if (containerEl && containerEl.getBoundingClientRect) {
                const rect = containerEl.getBoundingClientRect();
                bounds = {
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom
                };
                position = {x: rect.left, y: rect.top};
            } else {
                position = this.getRelativePosition(leaf);
            }

            // Collect all tabs in this group
            const groupLeaves: LeafState[] = [];
            const children = (tabGroup as any).children as WorkspaceLeaf[] | undefined;

            if (Array.isArray(children)) {
                for (const childLeaf of children) {
                    const vs = childLeaf.getViewState();
                    if (!vs || !vs.type || vs.type === 'empty') continue;
                    groupLeaves.push({
                        viewState: vs,
                        ephemeralState: childLeaf.getEphemeralState(),
                        isActive: childLeaf === this.app.workspace.activeLeaf
                    });
                }
            }

            if (groupLeaves.length > 0) {
                groupsWithPos.push({ group: groupLeaves, pos: position, bounds });
            }
        });

        if (groupsWithPos.length === 0) return null;

        // Sort by Y then X
        groupsWithPos.sort((a, b) => {
            const yDiff = a.pos.y - b.pos.y;
            if (Math.abs(yDiff) > 10) return yDiff;
            return a.pos.x - b.pos.x;
        });

        // Build rows based on Y coordinates
        const grid: LeafState[][][] = [];
        let currentRow: LeafState[][] = [];
        let lastY = groupsWithPos[0].pos.y;

        for (const item of groupsWithPos) {
            if (Math.abs(item.pos.y - lastY) > 10) {
                if (currentRow.length > 0) grid.push(currentRow);
                currentRow = [];
                lastY = item.pos.y;
            }
            currentRow.push(item.group);
        }
        if (currentRow.length > 0) grid.push(currentRow);

        return grid;
    }

    /**
     * Rotate grid 90° clockwise: grid[row][col] → rotated[col][rows-1-row]
     */
    private rotateGrid90Clockwise(grid: LeafState[][][]): LeafState[][][] {
        const rows = grid.length;
        const cols = grid[0].length;

        const rotated: LeafState[][][] = Array.from({length: cols}, () => []);

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const newRow = col;
                const newCol = rows - 1 - row;
                rotated[newRow][newCol] = grid[row][col];
            }
        }

        return rotated;
    }

    /**
     * Rebuild workspace from grid using TWO-PASS approach
     */
    private async rebuildFromGrid(grid: LeafState[][][]) {
        // Detach all but base leaf
        const allLeaves: WorkspaceLeaf[] = [];
        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            allLeaves.push(leaf);
        });

        const baseLeaf = allLeaves[0];
        for (let i = 1; i < allLeaves.length; i++) {
            allLeaves[i].detach();
        }

        await baseLeaf.setViewState({ type: 'empty' });
        await new Promise(resolve => setTimeout(resolve, 50));

        const rows = grid.length;
        const cols = grid[0].length;

        console.log(`[next-tab-group] Rebuilding ${rows}×${cols} grid`);

        // PASS 1: Build split structure with empty leaves
        const leafMap = new Map<WorkspaceLeaf, LeafState[]>();
        await this.buildGridStructure(baseLeaf, rows, cols, 0, 0, rows, cols, grid, leafMap);

        console.log(`[next-tab-group] Pass 1: Created ${leafMap.size} empty leaves`);

        // PASS 2: Populate all leaves with content
        for (const [leaf, group] of leafMap.entries()) {
            if (group.length === 0) continue;

            await leaf.setViewState(group[0].viewState, group[0].ephemeralState);
            const tabGroup = leaf.parent;

            for (let i = 1; i < group.length; i++) {
                const newLeaf = this.app.workspace.createLeafInParent(tabGroup, i);
                await newLeaf.setViewState(group[i].viewState, group[i].ephemeralState);
            }
        }

        console.log(`[next-tab-group] Pass 2: Populated ${leafMap.size} leaves`);
    }

    /**
     * Recursively build grid structure
     */
    private async buildGridStructure(
        currentLeaf: WorkspaceLeaf,
        totalRows: number,
        totalCols: number,
        startRow: number,
        startCol: number,
        numRows: number,
        numCols: number,
        grid: LeafState[][][],
        leafMap: Map<WorkspaceLeaf, LeafState[]>
    ): Promise<void> {
        // Base case: single cell
        if (numRows === 1 && numCols === 1) {
            leafMap.set(currentLeaf, grid[startRow][startCol]);
            return;
        }

        // Recursive case: split the region
        if (numRows > 1) {
            // Split horizontally (top/bottom)
            const splitRow = Math.floor(numRows / 2);

            await this.buildGridStructure(currentLeaf, totalRows, totalCols, startRow, startCol, splitRow, numCols, grid, leafMap);

            this.app.workspace.setActiveLeaf(currentLeaf, { focus: false });
            (this.app as any).commands.executeCommandById('workspace:split-horizontal');
            await new Promise(resolve => setTimeout(resolve, 50));

            const newLeaf = this.app.workspace.activeLeaf;
            if (newLeaf) {
                await this.buildGridStructure(newLeaf, totalRows, totalCols, startRow + splitRow, startCol, numRows - splitRow, numCols, grid, leafMap);
            }
        } else {
            // Split vertically (left/right)
            const splitCol = Math.floor(numCols / 2);

            await this.buildGridStructure(currentLeaf, totalRows, totalCols, startRow, startCol, numRows, splitCol, grid, leafMap);

            this.app.workspace.setActiveLeaf(currentLeaf, { focus: false });
            (this.app as any).commands.executeCommandById('workspace:split-vertical');
            await new Promise(resolve => setTimeout(resolve, 50));

            const newLeaf = this.app.workspace.activeLeaf;
            if (newLeaf) {
                await this.buildGridStructure(newLeaf, totalRows, totalCols, startRow, startCol + splitCol, numRows, numCols - splitCol, grid, leafMap);
            }
        }
    }

    /**
     * Restore focus to the originally active tab
     */
    private restoreActiveTab(activeFileInfo: {file: string | null, type: string}) {
        let restored = false;

        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            if (restored) return;

            const vs = leaf.getViewState();
            if (vs.type !== activeFileInfo.type) return;

            const leafFile = (vs.state as any)?.file;
            if (activeFileInfo.file && leafFile === activeFileInfo.file) {
                this.app.workspace.setActiveLeaf(leaf, { focus: true });
                console.log(`[next-tab-group] ✓ Focus restored to: ${activeFileInfo.file}`);
                restored = true;
            } else if (!activeFileInfo.file && vs.type === activeFileInfo.type) {
                this.app.workspace.setActiveLeaf(leaf, { focus: true });
                console.log(`[next-tab-group] ✓ Focus restored to: ${activeFileInfo.type}`);
                restored = true;
            }
        });

        if (!restored) {
            console.warn(`[next-tab-group] Could not restore focus to: ${activeFileInfo.file || activeFileInfo.type}`);
        }
    }

    // ------------------------------------------------------------------------
    // Debug commands
    // ------------------------------------------------------------------------

    private previewRotateTabGroupsLayout() {
        const wsAny = this.app.workspace as any;
        const layout = wsAny.getLayout?.();
        if (!layout) return;

        const main = (layout as any).main ?? layout;
        console.log('--- Preview ---');
        const stats: LayoutRotationStats = { splitsVisited: 0, splitsFlipped: 0 };
        this.flipAllSplitsInLayout(main, true, 0, stats);
        console.log('--- End ---');
    }

    private flipAllSplitsInLayout(node: any, dryRun: boolean, depth: number, stats: LayoutRotationStats): void {
        if (!node || typeof node !== 'object') return;

        if (node.type === 'split') {
            stats.splitsVisited++;
            const before = node.direction;
            const after = before === 'horizontal' ? 'vertical' : 'horizontal';
            if (dryRun) {
                console.log(`${'  '.repeat(depth)}Would flip: ${before} -> ${after}`);
            }
            stats.splitsFlipped++;
        }

        const children = (node as any).children;
        if (Array.isArray(children)) {
            for (const child of children) {
                this.flipAllSplitsInLayout(child, dryRun, depth + 1, stats);
            }
        }
    }

    private logLayoutSplitsLayout() {
        const wsAny = this.app.workspace as any;
        const layout = wsAny.getLayout?.();
        if (!layout) return;

        const main = (layout as any).main ?? layout;
        console.log('--- Layout ---');
        this.logSplitsInLayout(main, 0);
        console.log('--- End ---');
    }

    private logSplitsInLayout(node: any, depth: number) {
        if (!node || typeof node !== 'object') return;

        if (node.type === 'split') {
            console.log(`${'  '.repeat(depth)}split: ${node.direction}`);
        }

        const children = (node as any).children;
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
