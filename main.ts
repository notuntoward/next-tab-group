import { Plugin, WorkspaceLeaf, WorkspaceSplit, WorkspaceParent, WorkspaceTabs } from 'obsidian';

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
    }

    private collectLeavesWithPosition(): LeafPosition[] {
        const positions: LeafPosition[] = [];
        const getTabGroup = (leaf: WorkspaceLeaf): WorkspaceParent | null => {
            return leaf.parent;
        };

        const allLeaves: WorkspaceLeaf[] = [];
        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            allLeaves.push(leaf);
        });

        const seenTabGroups = new Set();
        for (const leaf of allLeaves) {
            const tabGroup = getTabGroup(leaf);
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

    private getRelativePosition(leaf: WorkspaceLeaf): { x: number, y: number } {
        try {
            const containerEl = (leaf as any).containerEl;
            if (containerEl && containerEl.getBoundingClientRect) {
                const rect = containerEl.getBoundingClientRect();
                return { x: rect.left, y: rect.top };
            }
        } catch (e) {
            // Fallback to parent tree position
        }

        let x = 0;
        let y = 0;
        let parent = leaf.parent;
        while (parent) {
            if (parent instanceof WorkspaceSplit) {
                const children = (parent as any).children;
                if (children) {
                    const index = children.indexOf(leaf.parent);
                    if (index >= 0) {
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

    private sortLeavesSpatially(positions: LeafPosition[]): LeafPosition[] {
        return positions.sort((a, b) => {
            const yDiff = a.position.y - b.position.y;
            if (Math.abs(yDiff) > 50) return yDiff;
            return a.position.x - b.position.x;
        });
    }

    private cycleTabGroups() {
        const positions = this.collectLeavesWithPosition();
        if (positions.length === 0) {
            console.log('No tab groups found');
            return;
        }

        if (positions.length === 1) {
            return;
        }

        const sorted = this.sortLeavesSpatially(positions);
        const activeLeaf = this.app.workspace.activeLeaf;

        if (!activeLeaf) {
            this.focusTabGroup(sorted[0]);
            return;
        }

        // Store the currently active leaf before switching away
        const activeTabGroup = activeLeaf.parent;
        this.tabGroupActiveLeaves.set(activeTabGroup, activeLeaf);

        const currentIndex = sorted.findIndex(pos => pos.tabGroup === activeTabGroup);
        if (currentIndex === -1) {
            this.focusTabGroup(sorted[0]);
            return;
        }

        // Move to next tab group
        const nextIndex = (currentIndex + 1) % sorted.length;
        this.focusTabGroup(sorted[nextIndex]);
    }

    private async collectTabs() {
        const activeLeaf = this.app.workspace.activeLeaf;
        if (!activeLeaf) {
            return;
        }

        const activeTabGroup = activeLeaf.parent;
        if (!(activeTabGroup instanceof WorkspaceTabs)) {
            return;
        }

        // Collect all leaves that need to be moved (not in active group)
        const leavesToMove: WorkspaceLeaf[] = [];
        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            if (leaf.parent !== activeTabGroup) {
                leavesToMove.push(leaf);
            }
        });

        // First, copy all leaves to the active tab group
        for (const leaf of leavesToMove) {
            // Capture the view state
            const viewState = leaf.getViewState();
            const ephemeralState = leaf.getEphemeralState();

            // Create a new leaf in the active tab group
            const newLeaf = this.app.workspace.createLeafInParent(
                activeTabGroup, 
                (activeTabGroup as any).children.length
            );

            // Set the view state on the new leaf
            await newLeaf.setViewState(viewState, ephemeralState);
        }

        // Then, detach all the old leaves from their original groups
        // This will automatically remove the empty tab groups
        for (const leaf of leavesToMove) {
            leaf.detach();
        }

        // Restore focus to the originally active leaf
        this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
    }

    private focusTabGroup(position: LeafPosition) {
        const tabGroup = position.tabGroup;

        // Check if we have a previously stored active leaf for this group
        const storedLeaf = this.tabGroupActiveLeaves.get(tabGroup);
        if (storedLeaf && storedLeaf.parent === tabGroup) {
            this.app.workspace.setActiveLeaf(storedLeaf, { focus: true });
            return;
        }

        // Fallback: use the provided leaf if no history exists
        let targetLeaf = position.leaf;
        this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
    }
}

interface LeafPosition {
    leaf: WorkspaceLeaf;
    tabGroup: WorkspaceParent;
    position: { x: number, y: number };
}
