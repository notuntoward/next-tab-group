import type { WorkspaceLeaf } from 'obsidian';
import type { LeafRecency } from 'commons/workspace';

export function setLastActive(plugin: object, id: string, time: number): void {
    (plugin as unknown as { recency: LeafRecency }).recency.touch({ id } as unknown as WorkspaceLeaf, time);
}
