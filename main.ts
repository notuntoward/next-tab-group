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

        this.addCommand({
            id: 'rotate-tab-groups',
            name: 'Rotate tab groups',
            callback: () => {
                this.rotateTabGroups();
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

        const seenTabGroups = new Set<WorkspaceParent>();
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
                const splitAny = parent as any;
                const children = splitAny.children as any[];
                if (children) {
                    let childIndex = -1;
                    if (leaf.parent === parent) {
                        childIndex = children.indexOf(leaf);
                    } else {
                        childIndex = children.indexOf(leaf.parent);
                    }

                    if (childIndex === -1 && leaf.parent instanceof WorkspaceTabs) {
                        childIndex = children.indexOf(leaf.parent);
                    }

                    if (childIndex >= 0) {
                        if (splitAny.direction === 'horizontal') {
                            x += childIndex * 1000;
                        } else {
                            y += childIndex * 1000;
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
            console.log('plugin:next-tab-group No tab groups found');
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

        const activeTabGroup = activeLeaf.parent;
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

    private async collectTabs() {
        const activeLeaf = this.app.workspace.activeLeaf;
        if (!activeLeaf) {
            return;
        }

        const activeTabGroup = activeLeaf.parent;
        if (!(activeTabGroup instanceof WorkspaceTabs)) {
            return;
        }

        const leavesToMove: WorkspaceLeaf[] = [];
        this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
            if (leaf.parent !== activeTabGroup) {
                leavesToMove.push(leaf);
            }
        });

        // Copy all leaves into the active tab group
        for (const leaf of leavesToMove) {
            const viewState = leaf.getViewState();
            const ephemeralState = leaf.getEphemeralState();

            const newLeaf = this.app.workspace.createLeafInParent(
                activeTabGroup,
                (activeTabGroup as any).children?.length ?? true
            );
            await newLeaf.setViewState(viewState, ephemeralState);
        }

        // Detach originals
        for (const leaf of leavesToMove) {
            leaf.detach();
        }

        // Restore focus
        this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
    }

    /**
     * NEW VERSION: rotate using workspace.getLayout() / changeLayout()
     * instead of mutating live WorkspaceSplit internals.
     */
    private async rotateTabGroups() {
        const ws: any = this.app.workspace as any;

        if (typeof ws.getLayout !== 'function' || typeof ws.changeLayout !== 'function') {
            console.warn('plugin:next-tab-group rotateTabGroups: workspace.getLayout/changeLayout not available; aborting.');
            return;
        }

        const layout = ws.getLayout();
        if (!layout) {
            console.warn('plugin:next-tab-group rotateTabGroups: getLayout() returned null/undefined; aborting.');
            return;
        }

        // Only touch the main editing area; leave sidebars alone.
        const mainRoot = layout.main ?? layout;

        console.log('plugin:next-tab-group --- Preview: rotate tab groups (layout JSON) ---');
        const previewMain = JSON.parse(JSON.stringify(mainRoot));
        const previewChanged = this.rotateSplitsInLayout(previewMain, true);
        if (!previewChanged) {
            console.log('plugin:next-tab-group (preview) No eligible editor splits found to rotate.');
        }
        console.log('plugin:next-tab-group --- End of preview ---');

        const changed = this.rotateSplitsInLayout(mainRoot, false);
        if (!changed) {
            console.log('plugin:next-tab-group rotateTabGroups: nothing to rotate; aborting.');
            return;
        }

        console.log('plugin:next-tab-group Applying rotated layout via workspace.changeLayout()');
        await ws.changeLayout(layout);
    }

    /**
     * Recursively rotates split nodes in a layout JSON tree.
     * Returns true if any split was actually changed.
     */

    private rotateSplitsInLayout(node: any, dryRun: boolean, depth: number = 0): boolean {
      if (!node || typeof node !== 'object') return false;

      let changed = false;
      const indent = '  '.repeat(depth);

      if (node.type === 'split' && Array.isArray(node.children)) {
        if (this.splitSubtreeHasEditorTabsInLayout(node)) {
          const before: string | undefined = node.direction;
          let after = before;
          if (before === 'vertical') after = 'horizontal';
          else if (before === 'horizontal') after = 'vertical';

          if (after && before && after !== before) {
            if (dryRun) {
              console.log(
                `plugin:next-tab-group ${indent}Would toggle split direction (layout): ${before} -> ${after}, children=${node.children.length}`
              );
            } else {
              console.log(
                `plugin:next-tab-group ${indent}Toggling split direction (layout): ${before} -> ${after}, children=${node.children.length}`
              );
              node.direction = after;
              // NOTE: we NO LONGER reverse node.children here.
              // This avoids swapping the positions of the tab groups.
            }
            changed = true;
          }
        }
      }

      const children: any[] = Array.isArray((node as any).children) ? (node as any).children : [];
      for (const child of children) {
        if (this.rotateSplitsInLayout(child, dryRun, depth + 1)) {
          changed = true;
        }
      }

      return changed;
    }

    /**
     * Heuristic: only rotate splits that actually contain editor-ish tabs.
     * This avoids messing with pure sidebar trees.
     */
    private splitSubtreeHasEditorTabsInLayout(node: any): boolean {
        if (!node || typeof node !== 'object') return false;

        if (node.type === 'tabs' && Array.isArray(node.children)) {
            for (const leaf of node.children) {
                const viewType = leaf?.state?.type;
                if (
                    viewType === 'markdown' ||
                    viewType === 'canvas' ||
                    viewType === 'image' ||
                    viewType === 'empty' ||
                    viewType === 'search' ||
                    viewType === 'outline'
                ) {
                    return true;
                }
            }
        }

        if (Array.isArray(node.children)) {
            return node.children.some((child: any) => this.splitSubtreeHasEditorTabsInLayout(child));
        }

        return false;
    }

    // Old helper is still here but now unused; it just mutates live splits.
    // Left around in case you want to experiment, but rotateTabGroups()
    // no longer calls it.
    private rotateSplitRecursive(split: WorkspaceSplit | WorkspaceParent) {
        if (!(split instanceof WorkspaceSplit)) {
            return;
        }

        const splitAny = split as any;
        const currentDirection = splitAny.direction;

        if (currentDirection === 'horizontal') {
            splitAny.direction = 'vertical';
        } else if (currentDirection === 'vertical') {
            splitAny.direction = 'horizontal';
        }

        if (currentDirection === 'vertical') {
            const children = splitAny.children;
            if (children && Array.isArray(children)) {
                children.reverse();
            }
        }

        const children = splitAny.children;
        if (children && Array.isArray(children)) {
            for (const child of children) {
                if (child instanceof WorkspaceSplit) {
                    this.rotateSplitRecursive(child);
                }
            }
        }
    }

    private focusTabGroup(position: LeafPosition) {
        const tabGroup = position.tabGroup;

        const storedLeaf = this.tabGroupActiveLeaves.get(tabGroup);
        if (storedLeaf && storedLeaf.parent === tabGroup) {
            this.app.workspace.setActiveLeaf(storedLeaf, { focus: true });
            return;
        }

        const targetLeaf = position.leaf;
        this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
    }
}

interface LeafPosition {
    leaf: WorkspaceLeaf;
    tabGroup: WorkspaceParent;
    position: { x: number, y: number };
}

interface TabGroupData {
    tabGroup: WorkspaceParent;
    position: { x: number, y: number };
    leaves: WorkspaceLeaf[];
    isActive: boolean;
}

interface LeafState {
    viewState: any;
    ephemeralState: any;
    isActive: boolean;
}

interface GroupState {
    leafStates: LeafState[];
    position: { x: number; y: number };
}

interface RotatedGroup {
    x: number;
    y: number;
    leafStates: LeafState[];
}
