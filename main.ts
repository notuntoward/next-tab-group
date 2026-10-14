import {
    FuzzySuggestModal,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    WorkspaceLeaf,
} from 'obsidian';
import type { App, WorkspaceParent } from 'obsidian';
import { updateElementPathDatasets } from './src/utils/dom';
import { registerEmacsMotionKeys, mapFuzzyMatchesToDisplayText, addPickerHeader, closeOnEscapeFromOtherWindows, type PickerHeader } from './src/utils/modal';
import type { CollectChoice } from './src/ui/collect-tabs-modal';
import { CollectTabsModal, describeWindow as formatWindowDescription, getSessionWindowIndex } from './src/ui/collect-tabs-modal';
import { TargetHighlighter, type HighlightTarget } from './src/utils/target-highlight';
import type { ScopeChoice } from './src/ui/collect-tabs-modal';
import { DiagLog, FreezeWatchdog, summarizeLayout } from './src/utils/diagnostics';
import { dirname, join } from 'path';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface NextTabGroupSettings {
    confirmDedupeGroup: boolean;
    confirmDedupeAllGroups: boolean;
    confirmDedupeAllWindows: boolean;
    groupSwitchByContext: boolean;
    colorActiveTabEnabled: boolean;
    activeTabColorLight: string;
    activeTabColorDark: string;
    highlightSwitchTarget: boolean;
    highlightCollectWindows: boolean;
    highlightCollectGroups: boolean;
    highlightSwitchGroup: boolean;
    highlightSwitchWindow: boolean;
    highlightDedupeTabs: boolean;
    highlightDedupeGroups: boolean;
    highlightDedupeSurvivors: boolean;
    switchLeftRightNavigation: boolean;
}

const DEFAULT_SETTINGS: NextTabGroupSettings = {
    confirmDedupeGroup: false,
    confirmDedupeAllGroups: true,
    confirmDedupeAllWindows: true,
    // When true, "switch to any tab" / "switch to tab group" cluster results by
    // window then tab group (current behavior). When false, everything is
    // sorted by pure recency instead.
    groupSwitchByContext: true,
    colorActiveTabEnabled: false,
    activeTabColorLight: "#e0edff",
    activeTabColorDark: "#33415c",
    highlightSwitchTarget: true,
    highlightCollectWindows: true,
    highlightCollectGroups: true,
    highlightSwitchGroup: true,
    highlightSwitchWindow: true,
    highlightDedupeTabs: true,
    highlightDedupeGroups: true,
    highlightDedupeSurvivors: true,
    // When true, Left/Right (and Ctrl+B/Ctrl+F) in the tab pickers select the
    // tab beside the highlighted one in its tab strip, while the search box
    // is empty.
    switchLeftRightNavigation: true,
};

/**
 * Returns the item whose leaf sits immediately left (-1) or right (+1) of the
 * given item's leaf in the same tab group's tab strip, or null at an edge or
 * when the neighbor is not among the picker's items.
 */
export function neighborInTabStrip<T>(
    items: T[],
    getLeaf: (item: T) => WorkspaceLeaf,
    item: T,
    direction: -1 | 1,
): T | null {
    const leaf = getLeaf(item);
    const siblings = (leaf.parent as unknown as { children?: unknown[] } | null)?.children;
    if (!Array.isArray(siblings)) return null;
    const at = siblings.indexOf(leaf);
    if (at < 0) return null;
    // Walk the strip in the given direction, wrapping at the ends, until a
    // sibling that is one of the picker's items turns up.
    const n = siblings.length;
    for (let step = 1; step < n; step++) {
        const candidateLeaf = siblings[(at + direction * step + n * step) % n];
        const match = items.find((candidate) => getLeaf(candidate) === candidateLeaf);
        if (match !== undefined) return match;
    }
    return null;
}

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * The one shared ring: orders items clockwise on screen. Used by Rotate tab
 * groups' sense of direction, Next/Previous tab group, and the Left/Right keys
 * of the group and window pickers.
 *
 * - The ring's center is the center of the bounding box of all rectangles.
 * - Items touching the bounding box's edge come first, sorted by the angle of
 *   their centers around that center (screen y grows downward, so increasing
 *   atan2 is clockwise); interior items follow in the same way, so the order is
 *   a clockwise spiral.
 * - When any rectangle is unknown, or two rectangles overlap heavily (stacked
 *   windows), geometry is meaningless and `fallback` gives a stable order.
 */
export function ringOrder<T>(
    items: T[],
    rect: (item: T) => Rect | null,
    fallback: (a: T, b: T) => number,
): T[] {
    const stable = () => [...items].sort(fallback);
    const entries = items.map((item) => ({ item, r: rect(item) }));
    if (entries.some((e) => !e.r || ![e.r.x, e.r.y, e.r.w, e.r.h].every(Number.isFinite))) return stable();
    if (entries.length < 2) return stable();
    const rs = entries.map((e) => e.r!);
    for (let i = 0; i < rs.length; i++) {
        for (let j = i + 1; j < rs.length; j++) {
            const a = rs[i];
            const b = rs[j];
            const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (ow > 0 && oh > 0 && ow * oh > 0.5 * Math.min(a.w * a.h, b.w * b.h)) return stable();
        }
    }
    const minX = Math.min(...rs.map((r) => r.x));
    const minY = Math.min(...rs.map((r) => r.y));
    const maxX = Math.max(...rs.map((r) => r.x + r.w));
    const maxY = Math.max(...rs.map((r) => r.y + r.h));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const tol = Math.min(10, 0.05 * Math.min(maxX - minX, maxY - minY));
    const keyed = entries.map((e) => {
        const r = e.r!;
        const px = r.x + r.w / 2;
        const py = r.y + r.h / 2;
        return {
            item: e.item,
            px,
            py,
            angle: Math.atan2(py - cy, px - cx),
            edge: r.x <= minX + tol || r.y <= minY + tol || r.x + r.w >= maxX - tol || r.y + r.h >= maxY - tol,
        };
    });
    keyed.sort((a, b) => {
        if (a.edge !== b.edge) return a.edge ? -1 : 1;
        const d = a.angle - b.angle;
        if (Math.abs(d) > 1e-9) return d;
        return a.px - b.px || a.py - b.py;
    });
    // Cyclic order is fixed by the sort; start the edge ring at its top-left
    // item so "first" is the reading-order start.
    const edgeCount = keyed.filter((k) => k.edge).length;
    let start = 0;
    let best = Infinity;
    for (let i = 0; i < edgeCount; i++) {
        const score = keyed[i].px - cx + (keyed[i].py - cy);
        if (score < best - 1e-9) {
            best = score;
            start = i;
        }
    }
    const ring = [...keyed.slice(start, edgeCount), ...keyed.slice(0, start), ...keyed.slice(edgeCount)];
    return ring.map((k) => k.item);
}

/** Screen rectangle of a native window, or null when it is unknown. */
export function windowScreenRect(win: Window | undefined): Rect | null {
    if (!win) return null;
    const w = win as unknown as { screenX?: number; screenY?: number; outerWidth?: number; outerHeight?: number };
    if (![w.screenX, w.screenY, w.outerWidth, w.outerHeight].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    return { x: w.screenX!, y: w.screenY!, w: w.outerWidth!, h: w.outerHeight! };
}
/**
 * Returns the item `direction` steps (-1/+1) after `item` in `ordered`,
 * wrapping at the ends (the way cycling tab groups does), or null when there
 * is nowhere else to go. Used for the spatial Left/Right keys of the group
 * and window pickers: Right is forward ("clockwise"), Left is backward.
 */
export function cyclicNeighbor<T>(ordered: T[], item: T, direction: -1 | 1): T | null {
    const at = ordered.indexOf(item);
    if (at < 0 || ordered.length < 2) return null;
    return ordered[(at + direction + ordered.length) % ordered.length];
}

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

/** Tab header element of a leaf (undocumented Obsidian field; may be missing). */
function leafHeaderEl(leaf: WorkspaceLeaf): HTMLElement | null {
    return ((leaf as any)?.tabHeaderEl as HTMLElement | undefined) ?? null;
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

interface DedupeScope {
    id: string;
    kind: 'group' | 'window' | 'other-window' | 'all';
    label: string;
    badge: string;
    winInfo?: WindowInfo;
    leaves: WorkspaceLeaf[];
    confirmKey: 'confirmDedupeGroup' | 'confirmDedupeAllGroups' | 'confirmDedupeAllWindows';
    title: string;
}

export interface WindowInfo {
    window: Window | undefined;
    groups: TabGroupInfo[];
    representative: WorkspaceLeaf;
    lastActive: number;
    label: string;
    isCurrentWindow: boolean;
    isMainWindow?: boolean;
}

// ---------------------------------------------------------------------------
// Canonical workspace navigation model
//
// Every editor leaf is represented as a location that knows both its real
// native window and its parent group. Tab groups are always built from leaves
// that share both, so a group's identity is conceptually (window, parent).
// ---------------------------------------------------------------------------

interface LeafLocation {
    leaf: WorkspaceLeaf;
    window: Window | undefined;
    group: WorkspaceParent | null;
}

interface WorkspaceNavigationModel {
    locations: LeafLocation[];
    windows: WindowInfo[];
    groups: TabGroupInfo[];
    tabs: TabInfo[];
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface FuzzyMatch<T> {
    item: T;
    match: {
        score: number;
        matches: number[][];
    };
}

/**
 * Helper utility to break a string down by matching index pairs
 * and render bolded/highlighted HTML elements natively.
 */
export function renderHighlightedText(parentEl: HTMLElement, text: string, matches: number[][]): void {
    if (!matches || matches.length === 0) {
        parentEl.setText(text);
        return;
    }

    let lastIndex = 0;
    for (const [start, end] of matches) {
        // Append unmatched prefix string segment
        if (start > lastIndex) {
            parentEl.createSpan().setText(text.slice(lastIndex, start));
        }
        // Append highlighted match segment
        const highlightSpan = parentEl.createSpan({ cls: 'suggestion-highlight' });
        highlightSpan.setText(text.slice(start, end));

        lastIndex = end;
    }

    // Append trailing leftover text segment
    if (lastIndex < text.length) {
        parentEl.createSpan().setText(text.slice(lastIndex));
    }
}

export default class NextTabGroupPlugin extends Plugin {
    private tabGroupActiveLeaves: Map<WorkspaceParent, WorkspaceLeaf> = new Map();
    private leafLastActive: Map<string, number> = new Map();
    settings: NextTabGroupSettings = { ...DEFAULT_SETTINGS };

    diag: DiagLog = new DiagLog(null);
    private restoreExecuteCommand: (() => void) | null = null;
    private collectInFlight = 0;
    private watchdog: FreezeWatchdog | null = null;

    /** Logs a layout snapshot; anomalies are always logged, the full tree only when asked. */
    private logLayout(label: string, force = true): void {
        const { text, anomalies } = summarizeLayout(this.app.workspace);
        if (anomalies.length) this.diag.log('ANOMALY', label, { anomalies, layout: text });
        else if (force) this.diag.log('LAYOUT', label, text);
    }

    /** Wrap every command so each invocation is logged (sync part only). */
    addCommand(command: Parameters<Plugin['addCommand']>[0]) {
        const cb = command.callback;
        if (cb) {
            command.callback = () => {
                const end = this.diag.begin(`cmd ${command.id}`);
                try {
                    cb();
                } finally {
                    end();
                }
            };
        }
        return super.addCommand(command);
    }

    private startDiagnostics(): void {
        let path: string | null = null;
        try {
            const base = (this.app.vault.adapter as any).getBasePath?.();
            const dir = this.manifest.dir;
            if (base && dir) path = join(base, dir, 'diagnostics.log');
        } catch {
            // no filesystem adapter; diagnostics stay disabled
        }
        this.diag = new DiagLog(path);
        this.diag.log('SESSION', 'plugin load', {
            version: this.manifest.version,
            log: path,
        });

        // Main-thread stall detector: logs when the event loop was blocked.
        let last = Date.now();
        this.registerInterval(
            window.setInterval(() => {
                const now = Date.now();
                if (now - last > 1500 && document.visibilityState === 'visible') this.diag.log('STALL', 'main thread blocked', { ms: now - last - 500 });
                last = now;
            }, 500),
        );

        if (path) {
            try {
                this.watchdog = new FreezeWatchdog();
                this.watchdog.start(path, join(dirname(path), 'heartbeat.txt'), () => this.diag.context(), (m) => this.diag.log('WARN', m));
            } catch (e) {
                this.diag.log('WARN', 'watchdog failed to start', { err: String(e) });
            }
        }

        // Uncaught errors in any window.
        this.registerDomEvent(window, 'error', (e: ErrorEvent) =>
            this.diag.log('ERROR', 'window error', { msg: e.message, src: e.filename, line: e.lineno }),
        );
        this.registerDomEvent(window, 'unhandledrejection', (e: PromiseRejectionEvent) =>
            this.diag.log('ERROR', 'unhandled rejection', { reason: String(e.reason), stack: (e.reason as Error)?.stack }),
        );

        // Log EVERY Obsidian command (including built-in tab commands).
        try {
            const cmds = (this.app as any).commands;
            const orig = cmds?.executeCommandById;
            if (typeof orig === 'function') {
                const wrapped = (id: string, ...rest: unknown[]) => {
                    const end = this.diag.begin(`obsidian-cmd ${id}`);
                    try {
                        return orig.call(cmds, id, ...rest);
                    } finally {
                        end();
                    }
                };
                cmds.executeCommandById = wrapped;
                this.restoreExecuteCommand = () => {
                    if (cmds.executeCommandById === wrapped) cmds.executeCommandById = orig;
                };
            }
        } catch {
            // private API unavailable
        }

        // Workspace events, with storm detection.
        let burst = 0;
        let burstStart = Date.now();
        const storm = (name: string) => {
            const now = Date.now();
            if (now - burstStart > 1000) {
                burst = 0;
                burstStart = now;
            }
            if (++burst === 40) this.diag.log('STORM', `${name}: 40+ workspace events within 1s`);
        };
        const ws = this.app.workspace;
        this.registerEvent(ws.on('layout-change', () => {
            storm('layout-change');
            this.diag.lastEvent = 'layout-change@' + new Date().toISOString();
            this.diag.log('EVENT', 'layout-change');
            this.logLayout('after layout-change', false);
        }));
        this.registerEvent(ws.on('active-leaf-change', (leaf) => {
            storm('active-leaf-change');
            this.diag.lastEvent = 'active-leaf-change@' + new Date().toISOString();
            this.diag.log('EVENT', 'active-leaf-change', {
                id: (leaf as any)?.id,
                type: leaf?.view?.getViewType?.(),
            });
        }));
        const watchVisibility = (w: Window, label: string) => {
            this.registerDomEvent(w.document, 'visibilitychange', () =>
                this.diag.log('VIS', label, { state: w.document.visibilityState, focused: w.document.hasFocus() }));
            this.registerDomEvent(w, 'focus', () => this.diag.log('VIS', label + ' focus'));
            this.registerDomEvent(w, 'blur', () => this.diag.log('VIS', label + ' blur'));
        };
        watchVisibility(window, 'main');
        this.diag.log('VIS', 'initial', { state: document.visibilityState, focused: document.hasFocus() });
        this.registerEvent(ws.on('window-open', (_w, win) => {
            this.diag.log('EVENT', 'window-open');
            try { watchVisibility(win, 'popout'); } catch { /* window closing */ }
        }));
        this.registerEvent(ws.on('window-close', () => this.diag.log('EVENT', 'window-close')));
        this.app.workspace.onLayoutReady(() => this.logLayout('layout ready'));
    }

    async onload() {
        try {
            this.startDiagnostics();
        } catch (e) {
            // Diagnostics must never prevent the plugin from loading.
            console.error('next-tab-group: diagnostics failed to start', e);
        }
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.applyActiveTabColors();

        this.addCommand({
            id: 'next',
            // eslint-disable-next-line obsidianmd/commands/no-plugin-name-in-command-name
            name: 'Next tab group',
            callback: () => {
                this.cycleTabGroups();
            }
        });

        this.addCommand({
            id: 'previous',
            name: 'Previous tab group',
            callback: () => {
                this.cycleTabGroups(-1);
            }
        });

        this.addCommand({
            id: 'collect-tabs',
            name: 'Collect tabs',
            callback: () => {
                this.runCollectTabs();
            }
        });

        this.addCommand({
            id: 'rotate-tab-groups',
            name: 'Rotate tab groups',
            callback: () => {
                this.rotateTabGroups(1);
            }
        });

        this.addCommand({
            id: 'rotate-tab-groups-counterclockwise',
            name: 'Rotate tab groups counterclockwise',
            callback: () => {
                this.rotateTabGroups(-1);
            }
        });

        this.addCommand({
            id: 'dedupe-tabs',
            name: 'Deduplicate tabs',
            callback: () => {
                void this.runDedupeTabs();
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

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (!leaf || (leaf as any).detached || this.isSidebarLeaf(leaf)) return;

                const internal = leaf as WorkspaceLeafInternal;
                if (internal.id) {
                    this.leafLastActive.set(internal.id, Date.now());
                    this.pruneLeafLastActive();
                }

                if (leaf.parent && this.isLeafAttached(leaf)) {
                    this.tabGroupActiveLeaves.set(leaf.parent, leaf);
                }
            })
        );

        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.pruneTabGroupActiveLeaves();
            })
        );

        this.registerEvent(
            this.app.workspace.on('window-open', (_workspaceWin, newWindow) => {
                this.applyActiveTabColorsToWindow(newWindow);
            })
        );

        this.registerEvent(
            this.app.workspace.on('window-close', (_workspaceWin, closedWindow) => {
                this.cleanUpWindow(closedWindow);
            })
        );
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    onunload(): void {
        this.diag.log('SESSION', 'plugin unload');
        this.restoreExecuteCommand?.();
        this.watchdog?.stop();
        const windows = new Set<Window>();
        const mainWin = this.getMainWindow();
        if (mainWin && !mainWin.closed) windows.add(mainWin);
        this.app.workspace.iterateAllLeaves((leaf) => {
            const win = this.getWindowForLeaf(leaf);
            if (win && !win.closed) windows.add(win);
        });
        for (const win of windows) {
            try {
                const body = win.document?.body;
                if (!body) continue;
                body.classList.remove("ntg-color-active-tab");
                body.style.removeProperty("--ntg-active-tab-color-light");
                body.style.removeProperty("--ntg-active-tab-color-dark");
            } catch {
                // Ignore closed/unloading window
            }
        }
    }

    /**
     * Pushes the configured active-tab colors onto every open window's body
     * element as CSS custom properties, and toggles the marker class so the
     * CSS rule only applies when the feature is enabled.
     */
    applyActiveTabColors(): void {
        const { colorActiveTabEnabled, activeTabColorLight, activeTabColorDark } = this.settings;

        const windows = new Set<Window>();
        const mainWin = this.getMainWindow();
        if (mainWin && !mainWin.closed) windows.add(mainWin);

        this.app.workspace.iterateAllLeaves((leaf) => {
            const win = this.getWindowForLeaf(leaf);
            if (win && !win.closed) windows.add(win);
        });

        for (const win of windows) {
            this.applyActiveTabColorsToWindow(win, colorActiveTabEnabled, activeTabColorLight, activeTabColorDark);
        }
    }

    private applyActiveTabColorsToWindow(
        win: Window,
        enabled: boolean = this.settings.colorActiveTabEnabled,
        lightColor: string = this.settings.activeTabColorLight,
        darkColor: string = this.settings.activeTabColorDark,
    ): void {
        if (!win || win.closed) return;
        try {
            const body = win.document?.body;
            if (!body) return;
            body.classList.toggle("ntg-color-active-tab", enabled);
            body.style.setProperty("--ntg-active-tab-color-light", lightColor);
            body.style.setProperty("--ntg-active-tab-color-dark", darkColor);
        } catch {
            // Window is navigating or closing
        }
    }

    /**
     * Activates a leaf and guarantees OS-level window focus.
     */
    private focusLeafAndWindow(leaf: WorkspaceLeaf): void {
        if (!leaf || (leaf as any).detached) return;
        const targetWin = this.getWindowForLeaf(leaf);
        this.app.workspace.setActiveLeaf(leaf, { focus: true });

        if (
            targetWin &&
            !targetWin.closed &&
            typeof activeWindow !== 'undefined' &&
            targetWin !== activeWindow &&
            typeof targetWin.focus === 'function'
        ) {
            try {
                targetWin.focus();
            } catch {
                // Focus failed on closed or destroyed window
            }
        }
    }

    private isLeafAttached(leaf: WorkspaceLeaf): boolean {
        if (!leaf || (leaf as any).detached || !leaf.parent) return false;
        const win = this.getWindowForLeaf(leaf);
        if (!win || win.closed) return false;
        const children = (leaf.parent as any).children;
        if (Array.isArray(children) && !children.includes(leaf)) {
            return false;
        }
        return true;
    }

    private pruneTabGroupActiveLeaves(): void {
        for (const [parent, leaf] of this.tabGroupActiveLeaves.entries()) {
            if (
                !leaf.parent ||
                leaf.parent !== parent ||
                (leaf as any).detached ||
                !this.isLeafAttached(leaf)
            ) {
                this.tabGroupActiveLeaves.delete(parent);
            }
        }
    }

    private cleanUpWindow(closedWindow: Window | undefined): void {
        if (!closedWindow) return;
        for (const [parent, leaf] of this.tabGroupActiveLeaves.entries()) {
            const win = this.getWindowForLeaf(leaf);
            if (!win || win === closedWindow || win.closed) {
                this.tabGroupActiveLeaves.delete(parent);
            }
        }
    }

    private pruneLeafLastActive(): void {
        if (this.leafLastActive.size <= 200) return;
        const liveLeafIds = new Set<string>();
        this.app.workspace.iterateAllLeaves((l) => {
            const id = this.getLeafId(l);
            if (id) liveLeafIds.add(id);
        });
        for (const id of this.leafLastActive.keys()) {
            if (!liveLeafIds.has(id)) {
                this.leafLastActive.delete(id);
            }
        }
    }

    // ------------------------------------------------------------------------
    // Window-aware helpers
    // ------------------------------------------------------------------------

    private getMainWindow(): Window {
        try {
            const root = (this.app.workspace as any).rootSplit;
            if (root?.win && !root.win.closed) {
                return root.win;
            }
            const doc = this.app.workspace.containerEl?.ownerDocument;
            const win = doc?.defaultView ?? (typeof window !== 'undefined' ? window : ({} as Window));
            if (win && !win.closed) {
                return win;
            }
        } catch {
            // fall through
        }
        return (typeof window !== 'undefined' ? window : ({} as Window));
    }

    private isMainLeaf(leaf: WorkspaceLeaf | null): boolean {
        if (!leaf || (leaf as any).detached) return false;
        if (typeof leaf.getRoot === 'function') {
            const root = leaf.getRoot();
            if (root && root === (this.app.workspace as any).rootSplit) {
                return true;
            }
        }
        if (typeof leaf.getContainer === 'function') {
            const container = leaf.getContainer() as any;
            if (container && container.winType === 'root') {
                return true;
            }
        }
        const win = this.getWindowForLeaf(leaf);
        if (!win || win.closed) return false;
        const mainWin = this.getMainWindow();
        return win === mainWin;
    }

    /**
     * Robustly resolves the native DOM Window hosting a leaf across Obsidian versions.
     */
    private getWindowForLeaf(
        leaf: WorkspaceLeaf | null,
    ): Window | undefined {
        if (!leaf || (leaf as any).detached) return undefined;
        try {
            const container = leaf.getContainer?.() as any;
            const leafAny = leaf as any;
            const win: Window | undefined =
                container?.win ??
                container?.doc?.defaultView ??
                container?.containerEl?.win ??
                container?.containerEl?.ownerDocument?.defaultView ??
                leafAny.containerEl?.win ??
                leafAny.containerEl?.ownerDocument?.defaultView ??
                leafAny.view?.containerEl?.win ??
                leafAny.view?.containerEl?.ownerDocument?.defaultView;

            if (win && !win.closed) {
                return win;
            }
        } catch {
            // Window or container in detached/closing state
        }
        return undefined;
    }

    /**
     * Get the active leaf in the currently focused window. Falls back to
     * app.workspace.activeLeaf when the focused window cannot be determined.
     */
    private getActiveLeafInFocusedWindow(): WorkspaceLeaf | null {
        const globalActive = this.app.workspace.activeLeaf;

        if (typeof activeWindow === 'undefined' || activeWindow === undefined) {
            return globalActive && !this.isSidebarLeaf(globalActive) && !(globalActive as any).detached ? globalActive : null;
        }

        if (
            globalActive &&
            !(globalActive as any).detached &&
            this.getWindowForLeaf(globalActive) === activeWindow &&
            !this.isSidebarLeaf(globalActive)
        ) {
            return globalActive;
        }

        let leafInFocusedWindow: WorkspaceLeaf | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leafInFocusedWindow) return;
            if ((leaf as any).detached) return;
            if (this.isSidebarLeaf(leaf)) return;
            if (this.getWindowForLeaf(leaf) === activeWindow) {
                leafInFocusedWindow = leaf;
            }
        });

        if (leafInFocusedWindow) {
            return leafInFocusedWindow;
        }

        if (globalActive && !(globalActive as any).detached && !this.isSidebarLeaf(globalActive)) {
            return globalActive;
        }

        return null;
    }


    // ------------------------------------------------------------------------
    // Tab group discovery & navigation
    // ------------------------------------------------------------------------

    /** Tab groups in clockwise ring order (see `ringOrder`), from their DOM rectangles. */
    private getRingGroups(groups: TabGroupInfo[]): TabGroupInfo[] {
        return ringOrder(
            groups,
            (g) => this.getTabGroupRect(g.group as WorkspaceContainerEl),
            (a, b) => b.lastActive - a.lastActive || a.label.localeCompare(b.label),
        );
    }

    /** Windows in clockwise ring order, from their screen rectangles. */
    private getRingWindows(windows: WindowInfo[]): WindowInfo[] {
        return ringOrder(
            windows,
            (w) => windowScreenRect(w.window),
            (a, b) =>
                Number(!!b.isMainWindow) - Number(!!a.isMainWindow) ||
                b.lastActive - a.lastActive ||
                a.label.localeCompare(b.label),
        );
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

    /**
     * True when a leaf lives in the left or right sidebar (File Explorer,
     * Outline, Backlinks, etc.) rather than the main editor area. Such leaves
     * have a `WorkspaceParent` like editor tabs do, but they are not tab groups
     * and must not be offered as switch targets. A sidebar leaf's `getRoot()`
     * is the corresponding `WorkspaceSidedock`, whereas editor leaves root at
     * the main `WorkspaceRoot`.
     */
    private isSidebarLeaf(leaf: WorkspaceLeaf): boolean {
        const root = leaf.getRoot();
        const ws = this.app.workspace as unknown as {
            leftSplit?: unknown;
            rightSplit?: unknown;
        };
        return root === ws.leftSplit || root === ws.rightSplit;
    }

    /**
     * Central editor-leaf discovery for the canonical model. Enumerates every
     * editor leaf via `iterateAllLeaves()` (so pop-out/floating leaves are
     * included), records each leaf's real native window and parent group, and
     * excludes sidebar leaves exactly once. Commands must not re-check
     * `isSidebarLeaf()` or call `iterateRootLeaves()` for features that should
     * include pop-outs.
     */
    private getEditorLeafLocations(): LeafLocation[] {
        const locations: LeafLocation[] = [];

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (!leaf || (leaf as any).detached) return;
            if (this.isSidebarLeaf(leaf)) return;

            const win = this.getWindowForLeaf(leaf);
            if (!win || win.closed) return;

            locations.push({
                leaf,
                window: win,
                group: leaf.parent ?? null,
            });
        });

        return locations;
    }

    /**
     * Build tab groups from already-classified leaf locations. Grouping is by
     * (window, WorkspaceParent), never by parent alone: a leaf's window comes
     * from the bucket key, not from `representative.getContainer()?.win`. A
     * group is current only when both the parent and native window match the
     * active leaf. Relative labels are computed only among groups sharing the
     * active leaf's window.
     */
    private buildTabGroupInfos(
        locations: LeafLocation[],
        activeLeaf: WorkspaceLeaf | null,
    ): TabGroupInfo[] {
        const byWindow = new Map<
            Window | undefined,
            Map<WorkspaceParent, WorkspaceLeaf[]>
        >();

        for (const location of locations) {
            if (!location.group) continue;

            let groupsInWindow = byWindow.get(location.window);
            if (!groupsInWindow) {
                groupsInWindow = new Map<WorkspaceParent, WorkspaceLeaf[]>();
                byWindow.set(location.window, groupsInWindow);
            }

            const leaves = groupsInWindow.get(location.group);
            if (leaves) {
                leaves.push(location.leaf);
            } else {
                groupsInWindow.set(location.group, [location.leaf]);
            }
        }

        const activeWindow = this.getWindowForLeaf(activeLeaf);
        const activeGroup = activeLeaf?.parent ?? null;
        const activeGroupRect = activeGroup
            ? this.getTabGroupRect(activeGroup as WorkspaceContainerEl)
            : null;

        const infos: TabGroupInfo[] = [];

        for (const [groupWindow, groupsInWindow] of byWindow) {
            for (const [group, leaves] of groupsInWindow) {
                if (leaves.length === 0) continue;

                const representative = this.pickMostRecent(leaves);

                const isCurrentGroup =
                    groupWindow === activeWindow &&
                    group === activeGroup;

                const groupRect = this.getTabGroupRect(
                    group as WorkspaceContainerEl,
                );

                let relativeLabel: string | null = null;

                /*
                 * Spatial relationships only make sense within one native window.
                 * Do not label a pop-out group "left" or "below" the main window.
                 */
                if (
                    !isCurrentGroup &&
                    groupWindow === activeWindow &&
                    activeGroupRect &&
                    groupRect
                ) {
                    const relation = this.relativePosition(
                        groupRect,
                        activeGroupRect,
                    );

                    relativeLabel = relation === "another group"
                        ? null
                        : this.capitalizeFirst(relation);
                }

                infos.push({
                    group,
                    leaves,
                    representative,
                    lastActive: this.getLeafLastActive(representative),
                    label: this.formatTabGroupLabel(
                        representative,
                        leaves.length,
                        isCurrentGroup,
                        relativeLabel,
                    ),
                    relativeLabel,
                    isCurrentGroup,
                    window: groupWindow,
                });
            }
        }

        return infos.sort((a, b) => {
            const byRecency = b.lastActive - a.lastActive;
            if (byRecency !== 0) return byRecency;
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

    /**
     * The single source of truth for every tab/group/window switching command.
     * One canonical editor-leaf snapshot is classified into locations, then
     * expanded into groups, tabs, and windows. Commands choose a scope from
     * this model rather than running their own workspace scans.
     */
    private buildNavigationModel(
        activeLeaf: WorkspaceLeaf | null,
    ): WorkspaceNavigationModel {
        const locations = this.getEditorLeafLocations();
        const groups = this.buildTabGroupInfos(locations, activeLeaf);
        const tabs = this.buildTabInfos(groups);
        const windows = this.buildWindowInfos(groups, activeLeaf);

        const model: WorkspaceNavigationModel = {
            locations,
            groups,
            tabs,
            windows,
        };

        return model;
    }

    // ------------------------------------------------------------------------
    // Canonical model scope helpers
    // ------------------------------------------------------------------------

    private getGroupsInWindow(
        model: WorkspaceNavigationModel,
        targetWindow: Window | undefined,
    ): TabGroupInfo[] {
        return model.groups.filter((group) => group.window === targetWindow);
    }

    private getTabsInWindow(
        model: WorkspaceNavigationModel,
        targetWindow: Window | undefined,
    ): TabInfo[] {
        return model.tabs.filter((tab) => tab.group.window === targetWindow);
    }

    private getGroupForLeaf(
        model: WorkspaceNavigationModel,
        leaf: WorkspaceLeaf | null,
    ): TabGroupInfo | null {
        if (!leaf) return null;

        const leafWindow = this.getWindowForLeaf(leaf);

        return model.groups.find(
            (group) =>
                group.window === leafWindow &&
                group.group === leaf.parent,
        ) ?? null;
    }

    /**
     * Windows in display order, shared by "switch to any tab" and "switch to
     * tab group" so both present the same arrangement: the active window first,
     * then every other window ordered by recency of its most recent tab group.
     */
    private orderWindowsForDisplay(
        model: WorkspaceNavigationModel,
        activeWindow: Window | undefined,
    ): WindowInfo[] {
        return [...model.windows].sort((a, b) => {
            const aActive = a.window === activeWindow ? 1 : 0;
            const bActive = b.window === activeWindow ? 1 : 0;
            if (aActive !== bActive) return bActive - aActive;

            const recency = b.lastActive - a.lastActive;
            if (recency !== 0) return recency;
            return a.label.localeCompare(b.label);
        });
    }

    /**
     * Tab groups in display order, reused by "switch to tab group" (all
     * windows) and to expand the "switch to any tab" list: windows lead with the
     * active one (then others by recency), and within each window groups are
     * ordered by recency of their most recent tab.
     */
    private orderGroupsForDisplay(
        model: WorkspaceNavigationModel,
        activeWindow: Window | undefined,
    ): TabGroupInfo[] {
        const ordered: TabGroupInfo[] = [];

        for (const win of this.orderWindowsForDisplay(model, activeWindow)) {
            const windowGroups = this.sortByRecency(
                win.groups,
                (group) => group.lastActive,
                (a, b) => a.label.localeCompare(b.label),
            );
            ordered.push(...windowGroups);
        }

        return ordered;
    }

    /**
     * Tabs in display order for "switch to any tab": windows lead with the
     * active one (then others by recency), each window's groups are ordered by
     * recency of their most recent tab, and within a group tabs follow recency.
     * Built directly on top of `orderGroupsForDisplay` so the window/group
     * ordering is identical to "switch to tab group".
     */
    private orderTabsForDisplay(
        model: WorkspaceNavigationModel,
        activeWindow: Window | undefined,
    ): TabInfo[] {
        const tabByLeaf = new Map(model.tabs.map((tab) => [tab.leaf, tab]));

        const ordered: TabInfo[] = [];

        for (const group of this.orderGroupsForDisplay(model, activeWindow)) {
            const groupTabs = this.sortByRecency(
                group.leaves
                    .map((leaf) => tabByLeaf.get(leaf))
                    .filter((tab): tab is TabInfo => tab !== undefined),
                (tab) => tab.lastActive,
                (a, b) => a.group.label.localeCompare(b.group.label),
            );
            ordered.push(...groupTabs);
        }

        return ordered;
    }

    /**
     * Tabs sorted by pure recency across every window/group, used when the
     * "group by tab group and window" setting is off. The tiebreak keeps the
     * order deterministic. The default selection (most recent non-active tab)
     * is computed independently of display order, so it stays correct here.
     */
    private orderTabsByRecency(model: WorkspaceNavigationModel): TabInfo[] {
        return this.sortByRecency(
            model.tabs,
            (tab) => tab.lastActive,
            (a, b) => a.group.label.localeCompare(b.group.label),
        );
    }

    /**
     * Tab groups sorted by pure recency across every window, used when the
     * "group by tab group and window" setting is off.
     */
    private orderGroupsByRecency(model: WorkspaceNavigationModel): TabGroupInfo[] {
        return this.sortByRecency(
            model.groups,
            (group) => group.lastActive,
            (a, b) => a.label.localeCompare(b.label),
        );
    }

    /**
     * Sort items recency-first (newest first), preserving the active item's
     * natural position rather than pushing it to the bottom. `getRecency`
     * extracts the timestamp used for ordering; `tiebreak` breaks ties.
     */
    private sortByRecency<T>(
        items: T[],
        getRecency: (item: T) => number,
        tiebreak?: (a: T, b: T) => number,
    ): T[] {
        return [...items].sort((a, b) => {
            const diff = getRecency(b) - getRecency(a);
            if (diff !== 0) return diff;
            return tiebreak ? tiebreak(a, b) : 0;
        });
    }

    /**
     * Position in the display list of the most-recent item that is not active,
     * used to set the modal's initial selection so ENTER switches to it
     * immediately. The display list is grouped by window/tab group, not by pure
     * recency, so we must rank items by `recency` (higher = newer) to find the
     * true most-recent non-active item, then return where that item sits in the
     * already-grouped `items` array. Falls back to 0 when every item is active
     * (degenerate) or the list is empty.
     */
    private firstNonActiveIndex<T>(
        items: T[],
        isActive: (item: T) => boolean,
        recency: (item: T) => number,
    ): number {
        let bestItem: T | null = null;
        let bestRecency = -Infinity;

        for (const item of items) {
            if (isActive(item)) continue;
            const r = recency(item);
            if (r > bestRecency) {
                bestRecency = r;
                bestItem = item;
            }
        }

        if (bestItem === null) return 0;

        return items.indexOf(bestItem);
    }

    private getTabSearchText(tab: TabInfo): string {
        return `${tab.leaf.getDisplayText()} ${tab.group.label}`;
    }

    private getTabGroupLocation(group: TabGroupInfo): string {
        return group.isCurrentGroup
            ? "Current group"
            : group.relativeLabel || "Other group";
    }

    /** "Right group" / "Group below" / "Current group" -> "Right" / "Below" / "Current". */
    private shortGroupLocation(location: string): string {
        const short = location.replace(/\bgroup\b/i, "").replace(/\s+/g, " ").trim();
        return short ? short.charAt(0).toUpperCase() + short.slice(1) : location;
    }

    private getTabGroupMeta(tab: TabInfo): string {
        const group = tab.group;

        let location: string;
        if (group.isCurrentGroup) {
            location = "Current group";
        } else if (group.relativeLabel) {
            location = group.relativeLabel;
        } else {
            location = "Other group";
        }

        const count =
            `${group.leaves.length} ` +
            `tab${group.leaves.length === 1 ? "" : "s"}`;

        return `${location} · ${count}`;
    }

    private renderTabSuggestion(
        tab: TabInfo,
        el: HTMLElement,
        labels: Map<Window | undefined, string>,
        showGroup: boolean,
        showWindow: boolean,
        match?: FuzzyMatch<TabInfo>,
    ): void {
        const rawDisplayText = tab.leaf.getDisplayText();
        const matches = mapFuzzyMatchesToDisplayText(
            this.getTabSearchText(tab),
            rawDisplayText,
            0,
            match?.match.matches ?? [],
        );

        const parts: string[] = [];
        if (showGroup) parts.push(this.getTabGroupMeta(tab));

        this.renderGridRow(el, tab.leaf, tab.group.window, rawDisplayText, matches, parts.join(" · "), undefined, showWindow);
    }

    /**
     * Shared row layout for every switch picker, and the same grid the
     * Collect/Dedupe pickers use: window badge | title · detail | HERE/MAIN pill.
     */
    private renderGridRow(
        el: HTMLElement,
        leaf: WorkspaceLeaf,
        win: Window | undefined,
        title: string,
        matches: ReturnType<typeof mapFuzzyMatchesToDisplayText>,
        secondary: string,
        windowInfo: WindowInfo | undefined,
        showWindowId: boolean,
    ): void {
        el.empty();
        el.addClass("ntg-nav-row");
        el.addClass("ntg-grid-row");

        const filePath = this.getLeafFileKey(leaf);
        if (filePath) {
            updateElementPathDatasets(el, filePath);
        }

        const isMain = windowInfo
            ? Boolean(windowInfo.isMainWindow || windowInfo.window === window)
            : this.isMainLeaf(leaf) || win === window;
        const isCurrent = windowInfo
            ? windowInfo.isCurrentWindow
            : win === this.getWindowForLeaf(this.getActiveLeafInFocusedWindow());
        const info = windowInfo ?? ({ window: win, isMainWindow: isMain } as WindowInfo);

        // The window number and HERE/MAIN pill only disambiguate when more
        // than one window exists; with a single window they are noise.
        if (showWindowId) {
            el.createSpan({ cls: "ntg-col-badge" }).createSpan({
                cls: "ntg-window-badge",
                text: String(getSessionWindowIndex(info)),
            });
        }

        const colContent = el.createSpan({ cls: "ntg-col-content" });
        const primary = colContent.createSpan({
            cls: "ntg-desc-primary ntg-nav-primary data-link-text",
        });
        renderHighlightedText(primary, title, matches);
        if (secondary) colContent.createSpan({ cls: "ntg-desc-separator", text: "·" });
        colContent.createSpan({ cls: "ntg-desc-secondary ntg-nav-secondary" }).setText(secondary);

        if (!showWindowId) return;
        const colStatus = el.createSpan({ cls: "ntg-col-status" });
        const status = isCurrent ? (isMain ? "HERE · MAIN" : "HERE") : (isMain ? "MAIN" : "");
        if (status) {
            const cls = status === "HERE · MAIN" ? "ntg-pill-here-main" : status === "MAIN" ? "ntg-pill-main" : "ntg-pill-here";
            colStatus.createSpan({ cls: `ntg-status-pill ${cls}`, text: status });
        }
    }

    private getWindowLabel(
        win: Window | undefined,
        labels: Map<Window | undefined, string>,
    ): string {
        return labels.get(win) ?? (win === window ? "Main window" : "Pop-out");
    }

    private renderTabGroupSuggestion(
        group: TabGroupInfo,
        el: HTMLElement,
        labels: Map<Window | undefined, string>,
        showGroup: boolean,
        showWindow: boolean,
        match?: FuzzyMatch<TabGroupInfo>,
    ): void {
        const title = group.representative.getDisplayText() || "Untitled tab";

        const location = this.getTabGroupLocation(group);
        const searchText = location ? `${location} ${title}` : title;
        const displayOffset = location ? location.length + 1 : 0;
        const matches = mapFuzzyMatchesToDisplayText(
            searchText,
            title,
            displayOffset,
            match?.match.matches ?? [],
        );

        const parts: string[] = [];
        if (showGroup) {
            const count =
                `${group.leaves.length} ` +
                `tab${group.leaves.length === 1 ? "" : "s"}`;
            // The command already says "group"; drop the word from each row.
            parts.push(`${this.shortGroupLocation(location)} · ${count}`);
        }

        this.renderGridRow(el, group.representative, group.window, title, matches, parts.join(" · "), undefined, showWindow);
    }

    private renderWindowSuggestion(
        item: WindowInfo,
        el: HTMLElement,
        match?: FuzzyMatch<WindowInfo>,
    ): void {
        const groupCount =
            `${item.groups.length} ` +
            `group${item.groups.length === 1 ? "" : "s"}`;
        const recent = item.representative.getDisplayText() || "Untitled tab";
        // The number badge and the HERE/MAIN pills already identify the
        // window, so no "Main window" / "Pop-out N" text.

        const matches = mapFuzzyMatchesToDisplayText(
            `${item.label} ${recent}`,
            recent,
            item.label.length + 1,
            match?.match.matches ?? [],
        );
        const parts = [groupCount];
        this.renderGridRow(el, item.representative, item.window, recent, matches, parts.join(" · "), item, true);
    }

    private renderInGroupTabSuggestion(
        leaf: WorkspaceLeaf,
        el: HTMLElement,
        labels: Map<Window | undefined, string>,
        showWindow: boolean,
        match?: FuzzyMatch<WorkspaceLeaf>,
    ): void {
        // The window badge/pills identify the window; no extra text.
        this.renderGridRow(el, leaf, this.getWindowForLeaf(leaf), leaf.getDisplayText(), match?.match.matches ?? [], "", undefined, showWindow);
    }

    /** Steps to the next (+1, clockwise) or previous (-1) tab group on the window's ring. */
    private cycleTabGroups(direction: -1 | 1 = 1) {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const activeWindow = this.getWindowForLeaf(activeLeaf);

        // Scope cycling to the active leaf's window: never cycle from the main
        // window into a pop-out or vice versa. The model already buckets groups
        // by (window, parent), so we only need to filter on window here.
        const model = this.buildNavigationModel(activeLeaf);
        const windowGroups = this.getGroupsInWindow(model, activeWindow);

        if (windowGroups.length <= 1) {
            return;
        }

        const sorted = this.getRingGroups(windowGroups);

        if (!activeLeaf) {
            this.focusTabGroup(sorted[0]);
            return;
        }

        const activeTabGroup = activeLeaf.parent as WorkspaceParent | null;
        if (activeTabGroup) {
            this.tabGroupActiveLeaves.set(activeTabGroup, activeLeaf);
        }

        const currentIndex = sorted.findIndex((group) =>
            group.window === activeWindow &&
            group.group === activeTabGroup,
        );
        if (currentIndex === -1) {
            this.focusTabGroup(sorted[0]);
            return;
        }

        const nextIndex = (currentIndex + direction + sorted.length) % sorted.length;
        this.focusTabGroup(sorted[nextIndex]);
    }

    private focusTabGroup(group: TabGroupInfo) {
        const tabGroup = group.group;
        const storedLeaf = this.tabGroupActiveLeaves.get(tabGroup);

        if (storedLeaf && group.leaves.includes(storedLeaf) && this.isLeafAttached(storedLeaf)) {
            this.focusLeafAndWindow(storedLeaf);
            return;
        }

        this.focusLeafAndWindow(group.representative);
    }

    // ------------------------------------------------------------------------
    // Collect tabs into the active tab group
    // ------------------------------------------------------------------------

    /**
     * Describes a window by its active/representative tab's title, plus a
     * `+N more` count if other tabs are open in that window.
     */
    describeWindow(winOrInfo: WindowInfo | Window): string {
        if ('groups' in winOrInfo && 'representative' in winOrInfo) {
            return formatWindowDescription(winOrInfo);
        }

        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const model = this.buildNavigationModel(activeLeaf);
        const winInfo = model.windows.find((w) => w.window === winOrInfo);
        if (!winInfo) return 'Empty window';
        return formatWindowDescription(winInfo);
    }

    /**
     * Runs tab collection:
     * - If 1 window is open, consolidates editor tabs within the current window immediately.
     * - If 2+ windows are open, displays a single-select modal offering "This window",
     *   "All windows", or a specific other window.
     */
    private async runCollectTabs(): Promise<void> {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const model = this.buildNavigationModel(activeLeaf);

        if (model.windows.length <= 1) {
            await this.collectTabs('current');
            return;
        }

        const currentWinInfo = model.windows.find((w) => w.isCurrentWindow) ?? model.windows[0];
        const otherWindows = model.windows.filter((w) => w !== currentWinInfo);

        new CollectTabsModal(
            this.app,
            currentWinInfo,
            otherWindows,
            (result) => {
                if (Array.isArray(result)) {
                    if (result.some((c) => c.kind === 'all')) {
                        void this.collectTabs('all');
                        return;
                    }
                    const checkedWins: WindowInfo[] = [];
                    for (const c of result) {
                        if (c.kind === 'current' || c.kind === 'window') {
                            if (!checkedWins.some((w) => w.window === c.winInfo.window)) {
                                checkedWins.push(c.winInfo);
                            }
                        }
                    }
                    if (checkedWins.length > 0) {
                        void this.collectTabs('multi', checkedWins);
                    }
                } else {
                    if (result.kind === 'current') {
                        // Collect the window the modal was opened for, NOT a
                        // freshly re-queried "active window": live focus can move
                        // while the modal is up (e.g. the user clicks another
                        // window, or closing the modal restores focus elsewhere).
                        // Re-deriving here previously sent the collection to the
                        // wrong window and left the intended window untouched --
                        // the exact hazard AGENTS.md hard rule 5 warns about. A
                        // single checked/HERE window is a one-element instance of
                        // the same 'multi' algorithm the other branches use.
                        void this.collectTabs('multi', [currentWinInfo]);
                    } else if (result.kind === 'all') {
                        void this.collectTabs('all');
                    } else if (result.kind === 'window') {
                        // Collecting between the initiating window and exactly one
                        // other window is just a 2-element case of 'multi': share
                        // that single destination/merge algorithm rather than a
                        // separate implementation, using the same currentWinInfo
                        // snapshot captured when the modal opened.
                        void this.collectTabs('multi', [currentWinInfo, result.winInfo]);
                    }
                }
            },
            {
                getTargets: (chosen) => this.collectHighlightTargets(chosen, currentWinInfo, model.windows),
            },
        ).open();
    }

    /**
     * Outlines for the Collect tabs picker: every window whose tabs the
     * current selection would gather (frame around the window) and the tab
     * groups inside it. Mirrors the picker's execution: "All windows" means
     * every window; a single "other window" row means that window plus the
     * window the command was opened from; otherwise just the checked windows.
     */
    private collectHighlightTargets(
        chosen: CollectChoice[],
        currentWinInfo: WindowInfo,
        allWindows: WindowInfo[],
    ): HighlightTarget[] {
        let wins: WindowInfo[];
        if (chosen.some((c) => c.kind === 'all')) {
            wins = allWindows;
        } else {
            wins = [];
            for (const c of chosen) {
                if ((c.kind === 'current' || c.kind === 'window') && !wins.includes(c.winInfo)) wins.push(c.winInfo);
            }
            if (chosen.length === 1 && chosen[0].kind === 'window') wins.unshift(currentWinInfo);
        }
        const targets: HighlightTarget[] = [];
        for (const winInfo of wins) {
            if (this.settings.highlightCollectWindows) {
                const container = winInfo.representative.getContainer?.() as unknown as { containerEl?: HTMLElement } | undefined;
                targets.push({ el: container?.containerEl, cls: 'ntg-switch-target-window' });
            }
            if (this.settings.highlightCollectGroups) {
                for (const g of winInfo.groups) {
                    targets.push({ el: (g.group as WorkspaceContainerEl).containerEl, cls: 'ntg-switch-target-group' });
                }
            }
        }
        return targets;
    }

    private closePopoutWindowIfEmpty(win: Window): void {
        const mainWindow = this.getMainWindow();
        if (!win || win === mainWindow || win === window || win.closed) {
            return;
        }

        let hasLeaves = false;
        this.app.workspace.iterateAllLeaves((l) => {
            if (hasLeaves) return;
            if (this.getWindowForLeaf(l) === win && l.parent && !(l as any).detached) {
                hasLeaves = true;
            }
        });

        if (hasLeaves) return;

        // Obsidian's Modal.open() (e.g. the Settings dialog, including the
        // Community plugins tab) attaches to whatever window was active when it
        // was opened -- not necessarily the main window. A modal is not a
        // WorkspaceLeaf, so the hasLeaves check above cannot see it. Closing a
        // popout window out from under an open modal tears down that window's
        // document mid-render, which can leave the modal's renderer hung with a
        // blank/frozen window. Skip closing if this window still has an open
        // modal; it will naturally become eligible again once the modal closes.
        try {
            if (win.document?.body?.querySelector('.modal-container')) {
                return;
            }
        } catch {
            // window/document already torn down; fall through to the close attempts below
        }

        this.diag.log('STEP', 'closing popout window');
        try {
            const floating = (this.app.workspace as any).floatingSplit?.children ?? [];
            for (const child of floating) {
                const childWin =
                    child?.win ??
                    child?.getContainer?.()?.win ??
                    child?.doc?.defaultView ??
                    child?.containerEl?.win ??
                    child?.containerEl?.ownerDocument?.defaultView;

                if (childWin === win) {
                    if (typeof child.close === 'function') {
                        child.close();
                        return;
                    }
                }
            }
        } catch {
            // private API access failed or unavailable
        }

        try {
            if (typeof win.close === 'function') {
                win.close();
            }
        } catch {
            // ignore
        }
    }

    /**
     * Collect editor tabs into one tab group.
     * - 'current': Collects editor tabs in the focused window into its active group.
     * - 'all': Gathers all tabs from all popout windows into the main window's active group,
     *          deleting all evacuated popout windows.
     * - 'multi': Handles an arbitrary combination of checked windows (including the common
     *            2-window "collect this window and one other" case, which is just a
     *            2-element instance of the same destination/merge algorithm).
     */
    private async collectTabs(
        scope: 'current' | 'all' | 'multi' = 'current',
        source?: WindowInfo[],
    ) {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        if (!activeLeaf || this.isSidebarLeaf(activeLeaf) || (activeLeaf as any).detached) return;

        const model = this.buildNavigationModel(activeLeaf);
        const currentWinInfo = model.windows.find((w) => w.isCurrentWindow) ?? model.windows[0];
        const mainWinInfo = model.windows.find((w) => w.isMainWindow) ?? model.windows.find((w) => w.window === this.getMainWindow()) ?? model.windows[0];

        let destLeaf: WorkspaceLeaf = activeLeaf;
        let tabsToMigrate: WorkspaceLeaf[] = [];
        const evacuatedPopouts = new Set<Window>();

        if (scope === 'current') {
            const targetParent = activeLeaf.parent as any;
            if (!targetParent) return;

            tabsToMigrate = this.getTabsInWindow(model, currentWinInfo.window)
                .map((t) => t.leaf)
                .filter((leaf) => leaf.parent !== targetParent && !this.isSidebarLeaf(leaf) && !(leaf as any).detached);
        } else if (scope === 'all') {
            // Rule 1: When windows to be collected include the main window, collected tabs
            // must go to the main window, and all collected popup windows must be deleted.
            destLeaf = mainWinInfo.representative;
            const targetParent = destLeaf.parent as any;
            if (!targetParent) return;

            for (const winInfo of model.windows) {
                if (!winInfo.isMainWindow && winInfo.window && !winInfo.window.closed) {
                    evacuatedPopouts.add(winInfo.window);
                }
            }

            tabsToMigrate = model.tabs
                .map((t) => t.leaf)
                .filter((leaf) => leaf.parent !== targetParent && !this.isSidebarLeaf(leaf) && !(leaf as any).detached);
        } else if (scope === 'multi' && Array.isArray(source)) {
            const checkedWindows = source as WindowInfo[];
            if (checkedWindows.length === 0) return;

            const includesMain = checkedWindows.some(
                (w) => w.isMainWindow || w.window === this.getMainWindow()
            );

            // Destination window:
            // - Collecting a single window (the "This window" / HERE choice, or
            //   the one window the command was invoked from) always keeps that
            //   window's own snapshot -- and therefore its own representative
            //   group -- as the destination. Re-deriving it from a freshly
            //   rebuilt model can pick a different group after live focus moves.
            // - If the Main Window is among several checked windows, it is always
            //   the destination (popup windows never empty the Main Window).
            // - Otherwise, the destination is the window the command was actually
            //   invoked from (the modal's snapshot marks it isCurrentWindow at the
            //   time it was opened). This must NOT be re-derived from a freshly
            //   re-queried "active window" here: by the time this callback runs
            //   (e.g. right as the modal closes), live focus can have moved to a
            //   window that was never checked at all, which previously sent tabs
            //   to the wrong destination and could misidentify which window is
            //   safe to evacuate.
            const destWinInfo = checkedWindows.length === 1
                ? checkedWindows[0]
                : (includesMain
                    ? mainWinInfo
                    : (checkedWindows.find((w) => w.isCurrentWindow) ?? checkedWindows[0]));

            destLeaf = destWinInfo.representative;
            const targetParent = destLeaf.parent as any;
            if (!targetParent) return;

            // Merge every tab group from every checked window -- including the
            // destination window's OWN other tab groups -- into targetParent.
            // Collecting across windows always merges into a single group; a
            // window is never partially collected into just one of its own
            // several groups while leaving another untouched.
            for (const w of checkedWindows) {
                const leaves = this.getTabsInWindow(model, w.window)
                    .map((t) => t.leaf)
                    .filter((leaf) => leaf.parent !== targetParent && !this.isSidebarLeaf(leaf) && !(leaf as any).detached);
                tabsToMigrate.push(...leaves);
            }

            // Evacuate every checked window other than the destination (the Main
            // Window is never force-closed).
            for (const w of checkedWindows) {
                if (w.window !== destWinInfo.window && !w.isMainWindow && w.window && !w.window.closed) {
                    evacuatedPopouts.add(w.window);
                }
            }
        }

        if (tabsToMigrate.length === 0) return;

        const targetParent = destLeaf.parent as any;
        if (!targetParent) return;

        if (this.collectInFlight > 0) this.diag.log('WARN', 'collectTabs re-entered while another is in flight', { inFlight: this.collectInFlight });
        this.collectInFlight++;
        const endCollect = this.diag.begin('collectTabs', { scope, tabs: tabsToMigrate.length, popouts: evacuatedPopouts.size });
        this.logLayout('collectTabs before');
        try {
            for (const leaf of tabsToMigrate) {
                this.diag.log('STEP', 'collect migrate leaf', { id: (leaf as any).id });
                const state = leaf.getViewState();
                const ephemeralState = typeof (leaf as any).getEphemeralState === 'function'
                    ? (leaf as any).getEphemeralState()
                    : undefined;

                const newLeaf = this.app.workspace.createLeafInParent(targetParent, -1);
                const cleanState = {
                    ...state,
                    active: false,
                    group: undefined,
                };
                await newLeaf.setViewState(cleanState, ephemeralState);
                this.diag.log('STEP', 'collect detach old leaf', { id: (leaf as any).id });
                leaf.detach();
            }

            for (const win of evacuatedPopouts) {
                this.closePopoutWindowIfEmpty(win);
            }
        } catch (err) {
            console.error('Failed to collect tabs:', err);
            this.diag.log('ERROR', 'collectTabs failed', { err: String(err), stack: (err as Error)?.stack });
        } finally {
            this.collectInFlight--;
            if (destLeaf.parent && this.isLeafAttached(destLeaf)) {
                this.tabGroupActiveLeaves.set(destLeaf.parent, destLeaf);
            }
            this.focusLeafAndWindow(destLeaf);
            this.logLayout('collectTabs after');
            endCollect();
        }
    }

    // ------------------------------------------------------------------------
    // ------------------------------------------------------------------------
    // Rotate tab groups — safe in-place split orientation toggle.
    //
    // Swapping every tab group's nesting orientation (vertical <-> horizontal)
    // does NOT require tearing down the workspace. Detaching every leaf destroys
    // the layout tree, leaving `createLeafBySplit` with no valid parent and
    // wiping selections, history, and scroll. Instead we mutate the live
    // `direction` property and the corresponding `mod-horizontal`/`mod-vertical`
    // CSS class on each captured split object, then ask Obsidian to re-flow.
    // Nothing is recreated, so 100% of workspace state is preserved.
    // ------------------------------------------------------------------------

    /**
     * Rotates the tab group split tree 90 degrees within the focused window:
     * clockwise for spin 1, counterclockwise for spin -1.
     * Replaces simple direction flipping with true tree transposition + child reversal.
     */
    private async rotateTabGroups(spin: 1 | -1 = 1) {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        if (!activeLeaf) return;

        const activeWin = this.getWindowForLeaf(activeLeaf);

        // Walk up from the active leaf to find the root split in the active window
        let rootSplit: any = activeLeaf.parent;
        let highestSplit: any = null;

        while (rootSplit) {
            if (rootSplit.type === 'split') {
                highestSplit = rootSplit;
            }
            rootSplit = rootSplit.parent;
        }

        // If there are no split containers (e.g., in a single-group popup window), inform the user
        if (!highestSplit) {
            new Notice("Cannot rotate: current window has no split groups.");
            return;
        }

        // Perform recursive 90-degree rotation on the split tree
        this.logLayout('rotate before');
        this.rotateSplit(highestSplit, activeWin, spin);
        this.logLayout('rotate after');

        // Notify Obsidian to re-render layout bounds and tab header containers
        if (typeof (this.app.workspace as any).trigger === 'function') {
            (this.app.workspace as any).trigger('layout-change');
        } else if (typeof (this.app.workspace as any).onLayoutChange === 'function') {
            (this.app.workspace as any).onLayoutChange();
        }
    }

    /**
     * Recursively transforms a split node 90 degrees (spin 1 clockwise, -1
     * counterclockwise). The two spins are the same transpose; only the child
     * reversal differs, so one spin undoes the other.
     * 1. Inverts direction ('vertical' <-> 'horizontal')
     * 2. Reverses child order array on one transition (see below)
     * 3. Re-orders containerEl child DOM nodes to match
     */
    public rotateSplit(node: any, activeWin?: Window, spin: 1 | -1 = 1): void {
        if (!node) return;

        // Verify that the target node belongs to the currently active window context
        if (activeWin && node.containerEl) {
            const nodeWin = node.containerEl.ownerDocument?.defaultView;
            if (nodeWin && nodeWin !== activeWin) return;
        }

        // Check if current node is a Split container with children
        if (node.children && Array.isArray(node.children) && node.direction) {
            // 1. Recurse into child splits first (post-order) so nested
            //    rotations are applied before this node is transposed.
            for (const child of node.children) {
                this.rotateSplit(child, activeWin, spin);
            }

            const oldDirection = node.direction;
            if (oldDirection === 'vertical' || oldDirection === 'horizontal') {
                const newDirection: 'horizontal' | 'vertical' =
                    oldDirection === 'vertical' ? 'horizontal' : 'vertical';

                // 2. Update internal split direction flag and CSS modifier class
                node.direction = newDirection;
                if (node.containerEl) {
                    node.containerEl.classList.remove(`mod-${oldDirection}`);
                    node.containerEl.classList.add(`mod-${newDirection}`);
                }

                // 3. For true clockwise rotation matching Emacs transpose-frame:
                //    Reversing when converting horizontal to vertical turns
                //    Top/Bottom into Right/Left (Clockwise 90°).
                //    Counterclockwise reverses on the other transition
                //    (vertical to horizontal) instead.
                if (
                    spin === 1
                        ? oldDirection === 'horizontal'
                        : oldDirection === 'vertical'
                ) {
                    node.children.reverse();
                }

                // 4. Re-order actual DOM elements to match the (possibly reversed) array order
                if (node.containerEl && node.containerEl.children) {
                    for (const child of node.children) {
                        if (child.containerEl) {
                            node.containerEl.appendChild(child.containerEl);
                        }
                    }
                }
            }
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
    ): { toRemove: WorkspaceLeaf[]; survivors: WorkspaceLeaf[]; notesAffected: number } | null {
        const groups = this.groupLeavesByFile(scope);
        const toRemove: WorkspaceLeaf[] = [];
        const survivors: WorkspaceLeaf[] = [];
        let notesAffected = 0;
        for (const [, leaves] of groups) {
            if (leaves.length <= 1) continue;
            notesAffected++;
            const survivor = this.pickSurvivor(leaves, activeLeaf);
            survivors.push(survivor);
            for (const leaf of leaves) {
                if (leaf !== survivor) {
                    toRemove.push(leaf);
                }
            }
        }
        if (toRemove.length === 0) return null;
        return { toRemove, survivors, notesAffected };
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
        // Multi-window context safety: createElement using activeDocument
        const doc = activeDocument as unknown as Document;
        const root = doc.createElement('div');
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

        const summary = doc.createElement('p');
        summary.classList.add('ntg-dedupe-summary');
        summary.textContent = `Will close ${totalRemoved} duplicate tab${totalRemoved === 1 ? '' : 's'} of ${entries.length} note${entries.length === 1 ? '' : 's'}.`;
        root.appendChild(summary);

        if (entries.length > 0) {
            const list = doc.createElement('ul');
            list.classList.add('ntg-dedupe-list');
            root.appendChild(list);
            for (const entry of entries) {
                const li = doc.createElement('li');
                li.classList.add('ntg-dedupe-item');
                list.appendChild(li);

                const name = doc.createElement('span');
                name.classList.add('ntg-dedupe-name');
                name.textContent = this.basename(entry.file);
                li.appendChild(name);

                const tail = doc.createElement('span');
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

    /**
     * Build every deduplication scope that could apply to the current
     * workspace: the active tab group, each window individually (the active
     * one first), and all windows. Each scope carries the exact leaves it
     * covers, captured now, so a later modal callback never re-derives "the
     * active window" (AGENTS.md hard rule 5).
     */
    private buildDedupeScopes(
        activeLeaf: WorkspaceLeaf | null,
        model: WorkspaceNavigationModel,
    ): DedupeScope[] {
        const scopes: DedupeScope[] = [];
        const activeWindow = this.getWindowForLeaf(activeLeaf);

        // "In group" means the exact group in the exact window of the active
        // leaf. The model already excludes sidebar leaves, so this never
        // includes unexpected workspace items from activeLeaf.parent.children.
        const activeGroup = this.getGroupForLeaf(model, activeLeaf);
        if (activeGroup && activeGroup.leaves.length > 0) {
            scopes.push({
                id: 'group',
                kind: 'group',
                label: 'This tab group',
                badge: 'G',
                leaves: [...activeGroup.leaves],
                confirmKey: 'confirmDedupeGroup',
                title: 'Deduplicate tabs in group',
            });
        }

        // The active window: every editor group in the active leaf's actual
        // window. With no active leaf to identify a window, fall back to the
        // main layout's root leaves so scope never silently expands to all
        // windows.
        const currentWin = activeWindow ? model.windows.find((w) => w.window === activeWindow) : undefined;
        const windowLeaves: WorkspaceLeaf[] = [];
        if (activeWindow) {
            for (const tab of this.getTabsInWindow(model, activeWindow)) {
                windowLeaves.push(tab.leaf);
            }
        } else {
            this.app.workspace.iterateRootLeaves((leaf) => {
                windowLeaves.push(leaf);
            });
        }
        scopes.push({
            id: 'window',
            kind: 'window',
            label: currentWin ? `Inside window ${getSessionWindowIndex(currentWin)}` : 'This window',
            badge: currentWin ? String(getSessionWindowIndex(currentWin)) : 'W',
            winInfo: currentWin,
            leaves: windowLeaves,
            confirmKey: 'confirmDedupeAllGroups',
            title: 'Deduplicate tabs in all groups',
        });

        // Other windows, each individually (like the Collect tabs modal).
        for (const winInfo of model.windows) {
            if (winInfo === currentWin || (activeWindow && winInfo.window === activeWindow)) continue;
            const n = getSessionWindowIndex(winInfo);
            scopes.push({
                id: `window:${n}`,
                kind: 'other-window',
                label: `Inside window ${n}`,
                badge: String(n),
                winInfo,
                leaves: this.getTabsInWindow(model, winInfo.window).map((t) => t.leaf),
                confirmKey: 'confirmDedupeAllGroups',
                title: 'Deduplicate tabs in window',
            });
        }

        // All windows, built from the canonical model so sidebar leaves are
        // excluded consistently.
        scopes.push({
            id: 'all',
            kind: 'all',
            label: 'Across all windows',
            badge: '⧉',
            leaves: model.tabs.map((tab) => tab.leaf),
            confirmKey: 'confirmDedupeAllWindows',
            title: 'Deduplicate tabs in all windows',
        });

        return scopes;
    }

    /**
     * Rows for the picker. Unlike the direct-run decision this keeps window
     * rows that have nothing to close on their own (checking several windows
     * dedupes across them), but drops rows that add no choice: "All windows"
     * with a single window, a tab-group row equal to its window, and any row
     * whose non-empty outcome is identical to an earlier row's.
     */
    private pickerDedupeScopes(
        scopes: DedupeScope[],
        activeLeaf: WorkspaceLeaf | null,
    ): Array<DedupeScope & { removeCount: number; removed: WorkspaceLeaf[]; kept: WorkspaceLeaf[] }> {
        const windowScopes = scopes.filter((s) => s.kind === 'window' || s.kind === 'other-window');
        const seen = new Set<string>();
        const rows: Array<DedupeScope & { removeCount: number; removed: WorkspaceLeaf[]; kept: WorkspaceLeaf[] }> = [];
        for (const scope of scopes) {
            if (scope.kind === 'all' && windowScopes.length <= 1) continue;
            const plan = this.planDedupe(scope.leaves, activeLeaf);
            const removed = plan?.toRemove ?? [];
            if (scope.kind === 'group') {
                const win = scopes.find((s) => s.kind === 'window');
                if (win && win.leaves.length === scope.leaves.length) continue;
            }
            if (removed.length > 0) {
                const key = removed.map((l) => this.getLeafId(l)).sort().join('|');
                if (seen.has(key)) continue;
                seen.add(key);
            }
            rows.push({ ...scope, removeCount: removed.length, removed, kept: plan?.survivors ?? [] });
        }
        // As in Collect tabs, "All windows" is the second most likely choice,
        // so it goes right after the first row.
        const allIdx = rows.findIndex((r) => r.kind === 'all');
        if (allIdx > 1) rows.splice(1, 0, ...rows.splice(allIdx, 1));
        return rows;
    }
    /**
     * Keep only scopes that would actually close something, and drop any scope
     * whose outcome is identical to a narrower one already kept (e.g. "This
     * window" when the window has a single group, or "All windows" when there
     * is only one window). What remains is the set of genuinely distinct
     * actions available right now.
     */
    private distinctDedupeScopes(
        scopes: DedupeScope[],
        activeLeaf: WorkspaceLeaf | null,
    ): Array<DedupeScope & { removeCount: number }> {
        const seen = new Set<string>();
        const result: Array<DedupeScope & { removeCount: number }> = [];
        for (const scope of scopes) {
            const plan = this.planDedupe(scope.leaves, activeLeaf);
            if (!plan) continue;
            const key = plan.toRemove.map((l) => this.getLeafId(l)).sort().join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            result.push({ ...scope, removeCount: plan.toRemove.length });
        }
        return result;
    }

    /**
     * Deduplicate tabs. Decides what is possible given the workspace:
     * - nothing to deduplicate: shows a notice;
     * - exactly one distinct action: runs it directly (honoring the matching
     *   "confirm before deduplicating" setting) without a picker;
     * - otherwise: a multi-select picker of scopes, like Collect tabs.
     */
    private async runDedupeTabs(): Promise<void> {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const model = this.buildNavigationModel(activeLeaf);
        const scopes = this.distinctDedupeScopes(this.buildDedupeScopes(activeLeaf, model), activeLeaf);

        if (scopes.length === 0) {
            new Notice('No duplicate tabs to close.');
            return;
        }

        if (scopes.length === 1) {
            await this.runDedupeScope(scopes[0], activeLeaf);
            return;
        }

        const pickerScopes = this.pickerDedupeScopes(this.buildDedupeScopes(activeLeaf, model), activeLeaf);
        const spansWindows = (s: DedupeScope) => s.kind === 'all';
        const leafName = (leaf: WorkspaceLeaf, withWindow: boolean) => {
            const title = leaf.getDisplayText() || 'Untitled';
            if (!withWindow) return title;
            const win = this.getWindowForLeaf(leaf);
            const info = model.windows.find((w) => w.window === win);
            return info ? `${title} (window ${getSessionWindowIndex(info)})` : title;
        };
        const firstNonEmpty = pickerScopes.findIndex((s) => s.removeCount > 0);
        const rows: ScopeChoice[] = pickerScopes.map((scope, i) => {
            const isMain = Boolean(scope.winInfo?.isMainWindow || (scope.winInfo?.window && scope.winInfo.window === window));
            const isHere = scope.kind === 'window' && Boolean(scope.winInfo);
            // Window numbers and HERE/MAIN only disambiguate with 2+ windows.
            const multi = model.windows.length > 1;
            const status = !multi ? undefined : isHere && isMain ? 'HERE · MAIN' : isHere ? 'HERE' : isMain ? 'MAIN' : undefined;
            const single = !multi && scope.kind === 'window';
            return {
                kind: 'scope' as const,
                id: scope.id,
                // The badge and HERE/MAIN pill name the window; the text says what is cleaned.
                label: scope.kind === 'window' || scope.kind === 'other-window' ? 'All tab groups' : scope.label,
                // Enter acts on the first row that would close something.
                checked: i === Math.max(0, firstNonEmpty),
                badge: single ? '⧉' : scope.badge,
                status,
                detail: scope.removeCount > 0 ? `${scope.removeCount} to close` : 'no duplicates inside',
                items: [
                    ...scope.removed.map((l) => ({ kind: 'close' as const, text: leafName(l, spansWindows(scope)) })),
                    ...scope.kept.map((l) => ({ kind: 'keep' as const, text: leafName(l, model.windows.length > 1) })),
                ],
            };
        });

        new CollectTabsModal(
            this.app,
            null,
            [],
            (result) => {
                const picked = new Set((Array.isArray(result) ? result : [result]).map((c) => (c.kind === 'scope' ? c.id : '')));
                const chosen = pickerScopes.filter((s) => picked.has(s.id));
                if (chosen.length === 0) return;
                const leaves = this.mergeScopeLeaves(chosen);
                // The picker rows already show what will be closed.
                void this.runDedupe(leaves, activeLeaf, false, 'Deduplicate tabs');
            },
            {
                scopeRows: rows,
                getSummary: (chosen, checked) => this.dedupeSummary(pickerScopes, chosen.map((c) => ({ id: c.kind === 'scope' ? c.id : '' })), activeLeaf, checked.map((c) => (c.kind === 'scope' ? c.id : ''))),
                getTargets: (chosen) => this.dedupeHighlightTargets(pickerScopes, chosen.map((c) => ({ id: c.kind === 'scope' ? c.id : '' })), activeLeaf),
                placeholder: 'Select where to close duplicates',
                actionLabel: 'Deduplicate',
                commandName: 'deduplicate-tabs',
                header: {
                    kind: 'dedupe',
                    title: 'Deduplicate tabs',
                    hint: 'Check where to close duplicates. Red outline = closed, green = kept.',
                    icon: 'copy-minus',
                },
            },
        ).open();
    }

    /**
     * Elements to mark for the picker's current selection: the headers of the
     * tabs the selection would close, the one tab kept for each note
     * (different color), and the tab groups holding the closing tabs. The
     * plan is the same one the action runs, so the preview cannot drift from
     * what is actually closed. Checking several windows merges their leaves,
     * so duplicates across those windows are previewed too.
     */
    private dedupeHighlightTargets(
        scopes: DedupeScope[],
        chosen: Array<{ id: string }>,
        activeLeaf: WorkspaceLeaf | null,
    ): HighlightTarget[] {
        const ids = new Set(chosen.map((c) => c.id));
        const plan = this.planDedupe(this.mergeScopeLeaves(scopes.filter((s) => ids.has(s.id))), activeLeaf);
        const targets: HighlightTarget[] = [];
        for (const leaf of plan?.toRemove ?? []) {
            if (this.settings.highlightDedupeTabs) {
                targets.push({ el: leafHeaderEl(leaf), cls: 'ntg-dedupe-close' });
            }
            if (this.settings.highlightDedupeGroups) {
                targets.push({ el: (leaf.parent as WorkspaceContainerEl | null)?.containerEl, cls: 'ntg-dedupe-close-group' });
            }
        }
        if (this.settings.highlightDedupeSurvivors) {
            for (const leaf of plan?.survivors ?? []) {
                targets.push({ el: leafHeaderEl(leaf), cls: 'ntg-dedupe-keep' });
            }
        }
        return targets;
    }
    /**
     * One-line statement of what Enter would do right now, so the picker never
     * leaves it ambiguous: Enter acts on every checked row plus the
     * highlighted one.
     */
    private dedupeSummary(
        scopes: Array<DedupeScope & { removeCount: number }>,
        chosen: Array<{ id: string }>,
        activeLeaf: WorkspaceLeaf | null,
        checkedIds: string[] = [],
    ): string {
        const ids = new Set(chosen.map((c) => c.id));
        const picked = scopes.filter((s) => ids.has(s.id));
        const plan = this.planDedupe(this.mergeScopeLeaves(picked), activeLeaf);
        const checkedSet = new Set(checkedIds);
        const where = picked.map((s) => (checkedSet.has(s.id) ? s.label : s.label + ' (highlighted)')).join(' + ');
        if (!plan) return `Nothing to close in: ${where}.`;
        const n = plan.toRemove.length;
        const k = plan.survivors.length;
        return `Enter closes ${n} tab${n === 1 ? '' : 's'} (red) and keeps ${k} (green) in: ${where}.`;
    }

    private mergeScopeLeaves(chosen: DedupeScope[]): WorkspaceLeaf[] {
        const leaves: WorkspaceLeaf[] = [];
        for (const scope of chosen) {
            for (const leaf of scope.leaves) {
                if (!leaves.includes(leaf) && !(leaf as any).detached) leaves.push(leaf);
            }
        }
        return leaves;
    }

    private async runDedupeScope(scope: DedupeScope, activeLeaf: WorkspaceLeaf | null): Promise<void> {
        await this.runDedupe(scope.leaves, activeLeaf, this.settings[scope.confirmKey], scope.title);
    }

    /** Deduplicate within the active tab group only. */
    async dedupeInGroup() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        if (!activeLeaf) return;
        const scope = this.buildDedupeScopes(activeLeaf, this.buildNavigationModel(activeLeaf)).find((s) => s.kind === 'group');
        if (scope) await this.runDedupeScope(scope, activeLeaf);
    }

    /** Deduplicate across all groups of the active window. */
    async dedupeInAllGroups() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const scope = this.buildDedupeScopes(activeLeaf, this.buildNavigationModel(activeLeaf)).find((s) => s.kind === 'window');
        if (scope) await this.runDedupeScope(scope, activeLeaf);
    }

    /** Deduplicate across every window. */
    async dedupeInAllWindows() {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const scope = this.buildDedupeScopes(activeLeaf, this.buildNavigationModel(activeLeaf)).find((s) => s.kind === 'all');
        if (scope) await this.runDedupeScope(scope, activeLeaf);
    }
    private async runDedupe(leaves: WorkspaceLeaf[], activeLeaf: WorkspaceLeaf | null, confirm: boolean, title: string) {
        const plan = this.planDedupe(leaves, activeLeaf);
        if (!plan) return;

        if (confirm) {
            const ok = await this.askConfirmation(title, this.renderConfirmation(leaves, activeLeaf, plan.toRemove));
            if (!ok) return;
        }

        const endDedupe = this.diag.begin('dedupe detach', { n: plan.toRemove.length });
        for (const leaf of plan.toRemove) {
            this.diag.log('STEP', 'dedupe detach leaf', { id: (leaf as any).id });
            leaf.detach();
        }
        this.logLayout('dedupe after');
        endDedupe();
    }

    // ------------------------------------------------------------------------
    // Switch to tab in group
    // ------------------------------------------------------------------------


    /**
     * A picker is only worth showing when there is a real choice. With zero
     * or one possible destination (everything except the current item) this
     * explains or just does the action and returns true; the caller then
     * skips the picker.
     */
    private skipPickerIfTrivial<T>(
        items: T[],
        isCurrent: (item: T) => boolean,
        go: (item: T) => void,
        nothingToSwitchTo: string,
    ): boolean {
        const others = items.filter((item) => !isCurrent(item));
        if (others.length === 0) {
            new Notice(nothingToSwitchTo);
            return true;
        }
        if (others.length === 1) {
            go(others[0]);
            return true;
        }
        return false;
    }

    private switchToTabInGroup(): void {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const model = this.buildNavigationModel(activeLeaf);
        const activeGroup = this.getGroupForLeaf(model, activeLeaf);

        if (!activeGroup || activeGroup.leaves.length === 0) {
            new Notice("No tabs in the active tab group to switch to.");
            return;
        }

        const leaves = this.sortByRecency(
            activeGroup.leaves,
            (leaf) => this.getLeafLastActive(leaf),
            (a, b) => this.getLeafId(a).localeCompare(this.getLeafId(b)),
        );

        if (this.skipPickerIfTrivial(leaves, (leaf) => leaf === activeLeaf, (leaf) => this.focusLeafAndWindow(leaf), "This tab group has only one tab.")) return;

        // The active group is the only group in this modal, so its name is
        // never needed; the window is named only when more than one exists.
        const showWindow =
            model.windows.length > 1;
        const windowLabels = this.buildWindowLabels(model);

        new NavigationSuggestModal(
            this.app,
            leaves,
            "Select a tab in this group",
            (leaf) => leaf.getDisplayText(),
            (leaf) => this.focusLeafAndWindow(leaf),
            (leaf, el, match) => this.renderInGroupTabSuggestion(leaf, el, windowLabels, showWindow, match),
            this.firstNonActiveIndex(
                leaves,
                (leaf) => leaf === activeLeaf,
                (leaf) => this.getLeafLastActive(leaf),
            ),
            (leaf) => this.getLeafFileKey(leaf),
            (leaf) => this.switchTargets(leaf, false, false),
            this.settings.switchLeftRightNavigation
                ? (leaf, direction) => neighborInTabStrip(leaves, (l) => l, leaf, direction)
                : undefined,
        ).withHeader({ kind: 'tab-in-group', title: 'Switch to tab in group', hint: 'Pick a tab in this tab group.', icon: 'layout-list' })
            .withKeyHints({ upDown: 'recent', leftRight: 'neighbor tab', enter: 'switch' }).open();
    }

    /**
     * Workspace elements to outline for the row a switch picker will activate:
     * the tab header, the tab group holding it and the window holding it.
     * Group and window outlines are only worth drawing when there is more than
     * one of them (otherwise the outline would just frame everything).
     */
    private switchTargets(
        leaf: WorkspaceLeaf,
        withGroup: boolean,
        withWindow: boolean,
        withTab = true,
    ): HighlightTarget[] {
        const targets: HighlightTarget[] = [];
        if (withTab && this.settings.highlightSwitchTarget) {
            targets.push({ el: leafHeaderEl(leaf), cls: 'ntg-switch-target' });
        }
        if (withGroup && this.settings.highlightSwitchGroup) {
            targets.push({ el: (leaf.parent as WorkspaceContainerEl | null)?.containerEl, cls: 'ntg-switch-target-group' });
        }
        if (withWindow && this.settings.highlightSwitchWindow) {
            const container = leaf.getContainer?.() as unknown as { containerEl?: HTMLElement } | undefined;
            targets.push({ el: container?.containerEl, cls: 'ntg-switch-target-window' });
        }
        return targets;
    }

    private switchToAnyTab(): void {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const model = this.buildNavigationModel(activeLeaf);
        const activeWindow = this.getWindowForLeaf(activeLeaf);

        if (model.tabs.length === 0) {
            new Notice("No editor tabs to switch to.");
            return;
        }

        if (this.skipPickerIfTrivial(model.tabs, (tab) => tab.leaf === activeLeaf, (tab) => this.focusLeafAndWindow(tab.leaf), "There is only one tab open.")) return;

        // When the setting is on, tabs are grouped by tab group within each
        // window and windows (and their groups) are ordered by recency so the
        // freshest contexts sit at the top. When off, everything is a single
        // pure-recency list. The most-recent non-active tab is selected by
        // default either way, so ENTER switches to it immediately.
        const tabs = this.settings.groupSwitchByContext
            ? this.orderTabsForDisplay(model, activeWindow)
            : this.orderTabsByRecency(model);

        const multipleWindows =
            model.windows.length > 1;
        const showGroup = model.groups.length > 1;
        const windowLabels = this.buildWindowLabels(model);

        new NavigationSuggestModal(
            this.app,
            tabs,
            "Select a tab",
            (tab) => this.getTabSearchText(tab),
            (tab) => this.focusLeafAndWindow(tab.leaf),
            (tab, el, match) => this.renderTabSuggestion(tab, el, windowLabels, showGroup, multipleWindows, match),
            this.firstNonActiveIndex(
                tabs,
                (tab) => tab.leaf === activeLeaf,
                (tab) => tab.lastActive,
            ),
            (tab) => this.getLeafFileKey(tab.leaf),
            (tab) => this.switchTargets(tab.leaf, showGroup, multipleWindows),
            this.settings.switchLeftRightNavigation
                ? (tab, direction) => neighborInTabStrip(tabs, (t) => t.leaf, tab, direction)
                : undefined,
        ).withHeader({ kind: 'any-tab', title: 'Switch to any tab', hint: 'Pick any tab in any window.', icon: 'files' })
            .withKeyHints({ upDown: this.settings.groupSwitchByContext ? 'recent, by group' : 'recent', leftRight: 'neighbor tab', enter: 'switch' }).open();
    }

    private activateTabGroup(
        group: WorkspaceParent,
        fallbackLeaf: WorkspaceLeaf,
    ): void {
        const storedLeaf = this.tabGroupActiveLeaves.get(group);

        if (storedLeaf && storedLeaf.parent === group && this.isLeafAttached(storedLeaf)) {
            this.focusLeafAndWindow(storedLeaf);
            return;
        }

        this.focusLeafAndWindow(fallbackLeaf);
    }

    private switchToTabGroup(): void {
        const activeLeaf = this.getActiveLeafInFocusedWindow();
        const model = this.buildNavigationModel(activeLeaf);
        const activeWindow = this.getWindowForLeaf(activeLeaf);

        // When the setting is on, groups are ordered the same way as "switch
        // to any tab": the active window first, then other windows by recency,
        // with each window's groups ordered by recency of their most recent
        // tab. When off, every group is in a single pure-recency list across
        // all windows.
        const orderedGroups = this.settings.groupSwitchByContext
            ? this.orderGroupsForDisplay(model, activeWindow)
            : this.orderGroupsByRecency(model);

        if (orderedGroups.length === 0) {
            new Notice("No tab groups to switch to.");
            return;
        }

        // One or zero other groups: nothing to choose, so no picker.
        // activateTabGroup focuses the target's window when it is a pop-out.
        if (this.skipPickerIfTrivial(
            orderedGroups,
            (group) => group.window === activeWindow && group.group === activeLeaf?.parent,
            (group) => this.activateTabGroup(group.group, group.representative),
            "There is only one tab group.",
        )) return;

        const multipleWindows =
            model.windows.length > 1;
        const showGroup = model.groups.length > 1;
        const windowLabels = this.buildWindowLabels(model);

        new NavigationSuggestModal(
            this.app,
            orderedGroups,
            "Select a tab group",
            (group) => {
                const title = group.representative.getDisplayText() || "Untitled tab";
                const location = this.getTabGroupLocation(group);
                return location ? `${location} ${title}` : title;
            },            (group) => this.activateTabGroup(group.group, group.representative),
            (group, el, match) => this.renderTabGroupSuggestion(group, el, windowLabels, showGroup, multipleWindows, match),
            this.firstNonActiveIndex(
                orderedGroups,
                (group) =>
                    group.window === activeWindow &&
                    group.group === activeLeaf?.parent,
                (group) => group.lastActive,
            ),
            (group) => this.getLeafFileKey(group.representative),
            (group) => [
                // The tab-group picker's own outline stays under the original
                // "highlight the tab you will switch to" setting.
                ...(this.settings.highlightSwitchTarget
                    ? [{ el: (group.group as WorkspaceContainerEl).containerEl, cls: 'ntg-switch-target-group' }]
                    : []),
                ...this.switchTargets(group.representative, false, multipleWindows, false),
            ],
            // Left/Right walk the highlighted group's window clockwise (the
            // sense of Rotate tab groups), wrapping; Left goes counterclockwise.
            this.settings.switchLeftRightNavigation
                ? (group, direction) => {
                    const inWindow = orderedGroups.filter((g) => g.window === group.window);
                    return cyclicNeighbor(this.getRingGroups(inWindow), group, direction);
                }
                : undefined,
        ).withHeader({ kind: 'tab-group', title: 'Switch to tab group', hint: 'Pick a tab group to jump to.', icon: 'layout-panel-left' })
            .withKeyHints({ upDown: this.settings.groupSwitchByContext ? 'recent, by window' : 'recent', leftRight: 'neighbor group', enter: 'switch' }).open();
    }

    private formatWindowLabel(
        role: string,
        groups: TabGroupInfo[],
        representative: WorkspaceLeaf,
    ): string {
        const title = representative.getDisplayText() || "Untitled tab";

        if (role === "Main window") return `${role} — ${title}`;

        const count = `${groups.length} group${groups.length === 1 ? "" : "s"}`;
        return `${role} — ${title} · ${count}`;
    }

    /**
     * Map each window to a stable display label. The main window (the global
     * `window`) is "Main window"; every pop-out is numbered by its position in
     * the recency-ordered window list ("Pop-out 1", "Pop-out 2", …) so distinct
     * pop-outs are distinguishable from one another.
     */
    private buildWindowLabels(
        model: WorkspaceNavigationModel,
    ): Map<Window | undefined, string> {
        const labels = new Map<Window | undefined, string>();
        let popoutOrdinal = 0;

        for (const win of model.windows) {
            if (win.isMainWindow || win.window === window) {
                labels.set(win.window, "Main window");
            } else {
                popoutOrdinal += 1;
                labels.set(win.window, `Pop-out ${popoutOrdinal}`);
            }
        }

        return labels;
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

        const currentWin = this.getWindowForLeaf(activeLeaf);
        const mainWin = this.getMainWindow();

        const windows: WindowInfo[] = [];
        let popoutOrdinal = 0;

        for (const [win, windowGroups] of byWindow) {
            const sortedGroups = [...windowGroups].sort((a, b) => {
                const recency = b.lastActive - a.lastActive;
                if (recency !== 0) return recency;
                return a.label.localeCompare(b.label);
            });

            const representative = sortedGroups[0].representative;

            const hasMainLeaves = sortedGroups.some((g) =>
                g.leaves.some((l) => this.isMainLeaf(l)),
            );
            const isMain = hasMainLeaves || (!windows.some((w) => w.isMainWindow) && (win === mainWin || win === window || !win));

            const role = isMain
                ? "Main window"
                : `Pop-out ${(popoutOrdinal += 1)}`;

            windows.push({
                window: win,
                groups: sortedGroups,
                representative,
                lastActive: this.getLeafLastActive(representative),
                label: this.formatWindowLabel(role, sortedGroups, representative),
                isCurrentWindow: win === currentWin,
                isMainWindow: isMain,
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
        const model = this.buildNavigationModel(activeLeaf);
        const activeWindow = this.getWindowForLeaf(activeLeaf);

        if (model.windows.length === 0) {
            new Notice("No Obsidian windows to switch to.");
            return;
        }

        const windows = this.sortByRecency(
            model.windows,
            (item) => item.lastActive,
            (a, b) => a.label.localeCompare(b.label),
        );

        if (windows.length === 0) {
            new Notice("No Obsidian windows to switch to.");
            return;
        }

        if (this.skipPickerIfTrivial(
            windows,
            (item) => item.isCurrentWindow,
            (item) => this.focusLeafAndWindow(item.representative),
            "There is only one window.",
        )) return;

        new NavigationSuggestModal(
            this.app,
            windows,
            "Select a window",
            (item) => `${item.label} ${item.representative.getDisplayText()}`,
            (item) => this.focusLeafAndWindow(item.representative),
            (item, el, match) => this.renderWindowSuggestion(item, el, match),
            this.firstNonActiveIndex(
                windows,
                (item) => item.window === activeWindow,
                (item) => item.lastActive,
            ),
            (item) => this.getLeafFileKey(item.representative),
            (item) => this.switchTargets(item.representative, false, true, false),
            // Left/Right step clockwise/counterclockwise around the windows' ring, wrapping.
            this.settings.switchLeftRightNavigation
                ? (item, direction) => cyclicNeighbor(this.getRingWindows(windows), item, direction)
                : undefined,
        ).withHeader({ kind: 'window', title: 'Switch to window', hint: 'Pick a window to bring forward.', icon: 'app-window' })
            .withKeyHints({ upDown: 'recent', leftRight: 'neighbor window', enter: 'switch' }).open();
    }

}

// ---------------------------------------------------------------------------
// Confirmation modal
// ---------------------------------------------------------------------------

class DedupeConfirmModal extends Modal {
    private readonly title: string;
    private readonly body: HTMLElement;
    private readonly resolve: (ok: boolean) => void;
    private settled = false;
    private stopEscape?: () => void;

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
        this.modalEl.classList.add('ntg-compact-dialog');
        this.contentEl.appendChild(this.body);

        const finish = (ok: boolean) => {
            this.settle(ok);
            this.close();
        };
        this.stopEscape = closeOnEscapeFromOtherWindows(this);

        // Standardized abstraction row replaces manual div + button setups
        new Setting(this.contentEl)
            .addButton((btn) =>
                btn.setButtonText('Cancel')
                   .onClick(() => finish(false))
            )
            .addButton((btn) =>
                btn.setButtonText('Close tabs')
                   .setWarning()
                   .setCta()
                   .onClick(() => finish(true))
            );

        // Bind core accessibility commands
        this.scope.register([], 'Escape', () => { finish(false); return false; });
        this.scope.register([], 'Enter', () => { finish(true); return false; });
    }

    /** Resolves exactly once; any dismissal that is not a button counts as Cancel. */
    private settle(ok: boolean): void {
        if (this.settled) return;
        this.settled = true;
        this.resolve(ok);
    }

    onClose() {
        this.stopEscape?.();
        this.stopEscape = undefined;
        this.settle(false);
        super.onClose();
    }
}

// ---------------------------------------------------------------------------
// Reusable suggestion modal
// ---------------------------------------------------------------------------

type SuggestionRenderer<T> = (item: T, el: HTMLElement, match: FuzzyMatch<T>) => void;

class NavigationSuggestModal<T> extends FuzzySuggestModal<T> {
    constructor(
        app: App,
        private readonly items: T[],
        placeholder: string,
        private readonly getSearchText: (item: T) => string,
        private readonly onChoose: (item: T) => void,
        private readonly renderItem?: SuggestionRenderer<T>,
        private readonly initialIndex = 0,
        private readonly getFilePath?: (item: T) => string | null,
        private readonly getTargets?: (item: T) => HighlightTarget[],
        private readonly getNeighbor?: (item: T, direction: -1 | 1) => T | null,
    ) {
        super(app);
        this.setPlaceholder(placeholder);
    }

    private readonly rowItems = new WeakMap<HTMLElement, T>();
    private readonly highlighter = new TargetHighlighter();
    private header?: PickerHeader;
    private stopEscape?: () => void;

    /** Gives this picker a title/icon/accent so it is distinguishable from the others. */
    withHeader(header: PickerHeader): this {
        this.header = header;
        return this;
    }

    private keyHints?: { upDown: string; leftRight?: string; enter: string };

    /**
     * Footer hint naming the dimension each key moves: Up/Down walks the
     * list (`upDown` says in what order) and Left/Right (only when this
     * picker has a neighbor function, and only while the search box is empty)
     * moves spatially (`leftRight` says to what).
     */
    withKeyHints(hints: { upDown: string; leftRight?: string; enter: string }): this {
        this.keyHints = hints;
        return this;
    }

    private renderKeyHints(): void {
        const hints = this.keyHints;
        if (!hints) return;
        try {
            const instructions = [{ command: '↑↓', purpose: hints.upDown }];
            if (hints.leftRight && this.getNeighbor && this.inputEl.value === '') {
                instructions.push({ command: '←→', purpose: hints.leftRight });
            }
            instructions.push({ command: '↵', purpose: hints.enter }, { command: 'esc', purpose: 'dismiss' });
            this.setInstructions(instructions);
        } catch {
            // hints are cosmetic
        }
    }
    private selectionObserver: MutationObserver | null = null;

    /**
     * Marks the workspace element (tab header or tab group) of the row ENTER
     * would switch to. Reads only DOM state (the .is-selected row), not
     * Obsidian's private chooser fields.
     */
    private syncTargetHighlight(): void {
        let targets: HighlightTarget[] = [];
        try {
            const row = this.resultContainerEl?.querySelector<HTMLElement>('.suggestion-item.is-selected');
            if (row && this.rowItems.has(row)) {
                targets = this.getTargets?.(this.rowItems.get(row) as T) ?? [];
            }
        } catch {
            targets = [];
        }
        this.highlighter.set(targets);
    }

    onClose() {
        this.stopEscape?.();
        this.stopEscape = undefined;
        this.selectionObserver?.disconnect();
        this.selectionObserver = null;
        this.highlighter.clear();
        super.onClose();
    }

    onOpen() {
        super.onOpen();
        this.stopEscape = closeOnEscapeFromOtherWindows(this);

        this.renderKeyHints();
        this.inputEl?.addEventListener('input', () => this.renderKeyHints());

        this.modalEl?.classList.add('ntg-compact-prompt');
        if (this.header) addPickerHeader(this.modalEl, this.header);

        registerEmacsMotionKeys(
            this,
            this.getNeighbor
                ? { neighbor: (item, direction) => this.getNeighbor!(item as T, direction) }
                : {},
        );

        if (this.getTargets && this.resultContainerEl && typeof MutationObserver !== 'undefined') {
            this.selectionObserver = new MutationObserver(() => this.syncTargetHighlight());
            this.selectionObserver.observe(this.resultContainerEl, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['class'],
            });
            // Mark the initially selected row; the observer only reacts to
            // later changes.
            this.syncTargetHighlight();
        }

        // Keep the list in recency order (the active item stays in its slot)
        // but select the most-recent item that is not the active one so ENTER
        // immediately switches to it.
        if (this.initialIndex > 0 && this.initialIndex < this.items.length) {
            // Defer execution until after the modal renders its initial suggestions
            window.setTimeout(() => {
                // Access Obsidian's internal chooser object
                const chooser = (this as any).chooser;
                if (chooser && typeof chooser.setSelectedItem === 'function') {
                    // Real Obsidian's setSelectedItem(index, event?) expects an
                    // Event (or undefined) as its second argument, not a boolean
                    // "scroll into view" flag. Passing a boolean (confirmed on
                    // 1.13.7) can throw internally ("t.instanceOf is not a
                    // function") -- this is an undocumented private API, so call
                    // it with no second argument and never let a failure here
                    // propagate uncaught out of this deferred timer callback.
                    try {
                        chooser.setSelectedItem(this.initialIndex);
                    } catch {
                        chooser.selectedItem = this.initialIndex;
                    }
                }
            }, 0);
        }
    }

    getItems(): T[] {
        return this.items;
    }

    getItemText(item: T): string {
        return this.getSearchText(item);
    }

    renderSuggestion(match: FuzzyMatch<T>, el: HTMLElement): void {
        if (this.getFilePath) {
            const filePath = this.getFilePath(match.item);
            updateElementPathDatasets(el, filePath);
        } else {
            updateElementPathDatasets(el, null);
        }

        if (this.getTargets) this.rowItems.set(el, match.item);

        if (this.renderItem) {
            el.empty();
            this.renderItem(match.item, el, match);
            return;
        }

        el.setText(this.getItemText(match.item));
    }

    onChooseItem(item: T): void {
        this.onChoose(item);
    }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

export class NextTabGroupSettingTab extends PluginSettingTab {
    private readonly plugin: NextTabGroupPlugin;

    constructor(app: App, plugin: NextTabGroupPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        // Handled by getSettingDefinitions() in Obsidian 1.13+
    }

    getSettingDefinitions() {
        return [
            {
                type: 'group',
                heading: 'Deduplicate tabs',
                items: [
                    {
                        name: 'Confirm before deduplicating in group',
                        desc: 'Show a confirmation dialog listing the tabs to be removed when running "Deduplicate tabs in group". Off by default; enable to prompt before closing tabs in the current group.',
                        control: {
                            type: 'toggle',
                            key: 'confirmDedupeGroup',
                        },
                    },
                    {
                        name: 'Confirm before deduplicating in all groups',
                        desc: 'Show a confirmation dialog listing the tabs to be removed when running "Deduplicate tabs in all groups". Disable to run without prompting.',
                        control: {
                            type: 'toggle',
                            key: 'confirmDedupeAllGroups',
                        },
                    },
                    {
                        name: 'Confirm before deduplicating in all windows',
                        desc: 'Show a confirmation dialog listing the tabs to be removed when running "Deduplicate tabs in all windows". Disable to run without prompting.',
                        control: {
                            type: 'toggle',
                            key: 'confirmDedupeAllWindows',
                        },
                    },
                ],
            },
            {
                type: 'group',
                heading: 'Switch tabs',
                items: [
                    {
                        name: 'Group results by tab group and window',
                        desc: 'When on, "Switch to any tab" and "Switch to tab group" cluster results by window and tab group (freshest first). When off, every result is listed in a single pure recency order, newest at the top.',
                        control: {
                            type: 'toggle',
                            key: 'groupSwitchByContext',
                        },
                    },
                    {
                        name: 'Left/Right keys move to adjacent tabs',
                        desc: 'In the switch pickers, the Left/Right arrows and Ctrl+B/Ctrl+F move spatially while the search box is empty: to the neighboring tab (any tab, tab in group), tab group, or window, wrapping at the ends. Once you type, they move the text cursor as usual. Up/Down always move through the list.',
                        control: {
                            type: 'toggle',
                            key: 'switchLeftRightNavigation',
                        },
                    },
                ],
            },
            {
                type: 'group',
                heading: 'Tab highlighting',
                items: [
                    {
                        name: 'Color the active tab',
                        desc: 'Highlight the active tab with a custom color in light and dark mode.',
                        control: {
                            type: 'toggle',
                            key: 'colorActiveTabEnabled',
                            onChange: () => {
                                this.plugin.applyActiveTabColors();
                            },
                        },
                    },
                    {
                        name: 'Active tab color (light mode)',
                        visible: () => this.plugin.settings.colorActiveTabEnabled,
                        control: {
                            type: 'color',
                            key: 'activeTabColorLight',
                            onChange: () => {
                                this.plugin.applyActiveTabColors();
                            },
                        },
                    },
                    {
                        name: 'Active tab color (dark mode)',
                        visible: () => this.plugin.settings.colorActiveTabEnabled,
                        control: {
                            type: 'color',
                            key: 'activeTabColorDark',
                            onChange: () => {
                                this.plugin.applyActiveTabColors();
                            },
                        },
                    },
                    {
                        name: 'Highlight the tab you will switch to',
                        desc: 'While a "Switch to tab" modal is open, subtly outline the tab that ENTER will switch to.',
                        control: {
                            type: 'toggle',
                            key: 'highlightSwitchTarget',
                        },
                    },
                    {
                        name: 'Also outline the tab group you will switch to',
                        desc: 'In "Switch to any tab", outline the tab group of the tab ENTER will switch to (only when there is more than one tab group).',
                        control: {
                            type: 'toggle',
                            key: 'highlightSwitchGroup',
                        },
                    },
                    {
                        name: 'Also outline the window you will switch to',
                        desc: 'In "Switch to any tab" and "Switch to tab group", outline the window that ENTER will switch to (only when there is more than one window).',
                        control: {
                            type: 'toggle',
                            key: 'highlightSwitchWindow',
                        },
                    },
                    {
                        name: 'Highlight the windows Collect tabs will gather',
                        desc: 'While the "Collect tabs" picker is open, outline each window whose tabs the selection will collect.',
                        control: {
                            type: 'toggle',
                            key: 'highlightCollectWindows',
                        },
                    },
                    {
                        name: 'Highlight the tab groups Collect tabs will gather',
                        desc: 'While the "Collect tabs" picker is open, outline each tab group inside the windows the selection will collect.',
                        control: {
                            type: 'toggle',
                            key: 'highlightCollectGroups',
                        },
                    },
                    {
                        name: 'Highlight the tabs Deduplicate tabs will close',
                        desc: 'While the "Deduplicate tabs" picker is open, outline the duplicate tabs that the selected option(s) will close.',
                        control: {
                            type: 'toggle',
                            key: 'highlightDedupeTabs',
                        },
                    },
                    {
                        name: 'Highlight the tab Deduplicate tabs will keep',
                        desc: 'While the "Deduplicate tabs" picker is open, outline the one tab that is kept for each duplicated note, in a different color from the tabs that will be closed.',
                        control: {
                            type: 'toggle',
                            key: 'highlightDedupeSurvivors',
                        },
                    },
                    {
                        name: 'Highlight the tab groups Deduplicate tabs will clean',
                        desc: 'While the "Deduplicate tabs" picker is open, outline each tab group that contains tabs the selected option(s) will close.',
                        control: {
                            type: 'toggle',
                            key: 'highlightDedupeGroups',
                        },
                    },
                ],
            },
        ];
    }
}

