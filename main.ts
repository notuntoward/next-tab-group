import { Plugin, WorkspaceLeaf, WorkspaceSplit, WorkspaceParent } from 'obsidian';

export default class NextTabGroupPlugin extends Plugin {
    async onload() {
        // Single command: Cycle to next tab group in main workspace
        this.addCommand({
            id: 'next-tab-group',
            name: 'Next tab group',
            callback: () => {
                this.cycleTabGroups();
            }
        });
    }

    /**
     * Get all leaves with their spatial information
     */
    private collectLeavesWithPosition(): LeafPosition[] {
        const positions: LeafPosition[] = [];
        
        // Helper to get tab group container for a leaf
        const getTabGroup = (leaf: WorkspaceLeaf): WorkspaceParent | null => {
            return leaf.parent;
        };

        // Collect all leaves from main workspace only
        const allLeaves: WorkspaceLeaf[] = [];
        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            allLeaves.push(leaf);
        });

        // Build position information for each unique tab group
        const seenTabGroups = new Set<WorkspaceParent>();
        
        for (const leaf of allLeaves) {
            const tabGroup = getTabGroup(leaf);
            if (!tabGroup || seenTabGroups.has(tabGroup)) continue;
            
            seenTabGroups.add(tabGroup);
            
            // Get spatial position
            const position = this.getRelativePosition(leaf);
            
            positions.push({
                leaf,
                tabGroup,
                position
            });
        }

        return positions;
    }

    /**
     * Get relative position of a leaf
     * Returns coordinates for spatial sorting
     */
    private getRelativePosition(leaf: WorkspaceLeaf): { x: number, y: number } {
        try {
            // Try to get DOM element for spatial positioning
            const containerEl = (leaf as any).containerEl;
            if (containerEl && containerEl.getBoundingClientRect) {
                const rect = containerEl.getBoundingClientRect();
                return { x: rect.left, y: rect.top };
            }
        } catch (e) {
            // Fallback to parent tree position
        }

        // Fallback: use parent tree structure to estimate position
        let x = 0;
        let y = 0;
        
        let parent = leaf.parent;
        while (parent) {
            if (parent instanceof WorkspaceSplit) {
                const children = (parent as any).children;
                if (children) {
                    const index = children.indexOf(leaf.parent);
                    if (index >= 0) {
                        // Estimate based on split direction
                        if ((parent as any).direction === 'horizontal') {
                            x += index * 1000;
                        } else {
                            y += index * 1000;
                        }
                    }
                }
            }
            parent = parent.parent;
        }

        return { x, y };
    }

    /**
     * Sort leaves spatially: left to right, top to bottom
     */
    private sortLeavesSpatially(positions: LeafPosition[]): LeafPosition[] {
        return positions.sort((a, b) => {
            // Sort by vertical position (top to bottom)
            const yDiff = a.position.y - b.position.y;
            if (Math.abs(yDiff) > 50) return yDiff;
            
            // If roughly same vertical position, sort by horizontal (left to right)
            return a.position.x - b.position.x;
        });
    }

    /**
     * Main cycling function
     */
    private cycleTabGroups() {
        // Collect all tab groups with position information
        const positions = this.collectLeavesWithPosition();
        
        if (positions.length === 0) {
            console.log('No tab groups found');
            return;
        }

        if (positions.length === 1) {
            // Only one tab group, nothing to cycle
            return;
        }

        // Sort spatially
        const sorted = this.sortLeavesSpatially(positions);

        // Find current active leaf's tab group
        const activeLeaf = this.app.workspace.activeLeaf;
        if (!activeLeaf) {
            // No active leaf, focus on first tab group
            this.focusTabGroup(sorted[0]);
            return;
        }

        const activeTabGroup = activeLeaf.parent;
        const currentIndex = sorted.findIndex(pos => pos.tabGroup === activeTabGroup);

        if (currentIndex === -1) {
            // Current tab group not in list (shouldn't happen), go to first
            this.focusTabGroup(sorted[0]);
            return;
        }

        // Move to next tab group (wrap around)
        const nextIndex = (currentIndex + 1) % sorted.length;
        this.focusTabGroup(sorted[nextIndex]);
    }

    /**
     * Focus on a tab group by setting its first leaf as active
     */
    private focusTabGroup(position: LeafPosition) {
        const tabGroup = position.tabGroup;
        
        // Find a leaf within this tab group
        let targetLeaf = position.leaf;
        
        // If the tab group has multiple tabs, try to find the first one
        const children = (tabGroup as any).children;
        if (children && Array.isArray(children)) {
            for (const child of children) {
                if (child instanceof WorkspaceLeaf) {
                    targetLeaf = child;
                    break;
                }
            }
        }

        // Set focus
        this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
    }
}

interface LeafPosition {
    leaf: WorkspaceLeaf;
    tabGroup: WorkspaceParent;
    position: { x: number, y: number };
}
