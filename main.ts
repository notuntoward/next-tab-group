import {
    FuzzySuggestModal,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    WorkspaceLeaf,
} from 'obsidian';
import type { App, SettingDefinitionItem, WorkspaceParent } from 'obsidian';
import { updateElementPathDatasets } from './src/utils/dom';
import { registerEmacsMotionKeys, mapFuzzyMatchesToDisplayText, renderHighlightedText, addPickerHeader, closeOnEscapeFromOtherWindows, type PickerHeader } from './src/utils/modal';
import type { CollectChoice } from './src/ui/collect-tabs-modal';
import { CollectTabsModal, describeWindow as formatWindowDescription, getSessionWindowIndex } from './src/ui/collect-tabs-modal';
import { TargetHighlighter, type HighlightTarget } from './src/utils/target-highlight';
import { joinedSearch, renderJoinedHits, uniqueTitles, type JoinedSearch } from './src/utils/search';
import type { ScopeChoice } from './src/ui/collect-tabs-modal';
import { DiagLog, FreezeWatchdog, summarizeLayout } from './src/utils/diagnostics';
import { dirname, join } from 'path';
import { ringOrder, windowScreenRect, cyclicNeighbor, type Direction, type Rect } from 'commons/geometry';
import * as kit from 'commons/workspace';
import { neighborInTabStrip, LeafRecency } from 'commons/workspace';
import type { LeafLocation, TabEntry, TabGroup } from 'commons/workspace';
import { forEachWindow, ownerWindow, setTimeoutIn } from 'commons/windows';
import { raiseWindow } from 'commons/os';

export { ringOrder, windowScreenRect, cyclicNeighbor, neighborInTabStrip };
export type { Rect };

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

// ---------------------------------------------------------------------------
// Internal Obsidian structures not exposed in the public API
// ---------------------------------------------------------------------------

interface WorkspaceContainerEl extends WorkspaceParent {
    containerEl: HTMLElement;
    direction?: string;
    children?: WorkspaceContainerEl[];
}

const DIRECTION_PHRASES: Record<Direction, string> = {
    left: 'left group',
    right: 'right group',
    above: 'group above',
    below: 'group below',
};

interface TabGroupInfo extends TabGroup {
    label: string;
    relativeLabel: string | null;
    isCurrentGroup: boolean;
}

type TabInfo = TabEntry<TabGroupInfo>;

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
// Built by commons/workspace from one snapshot of editor leaves; the plugin
// adds display labels and its own ordering on top. A group's identity is
// (window, parent).
// ---------------------------------------------------------------------------

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


export default class NextTabGroupPlugin extends Plugin {
    private tabGroupActiveLeaves: Map<WorkspaceParent, WorkspaceLeaf> = new Map();
    private readonly recency = new LeafRecency();
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

        const win = this.getMainWindow();
        if (!win) {
            this.diag.log('WARN', 'Diagnostics unavailable: main window could not be resolved');
            return;
        }
        // Main-thread stall detector: logs when the event loop was blocked.
        let last = Date.now();
        const interval = win.setInterval(() => {
            const now = Date.now();
            if (now - last > 1500 && win.document.visibilityState === 'visible') this.diag.log('STALL', 'main thread blocked', { ms: now - last - 500 });
            last = now;
        }, 500);
        this.register(() => win.clearInterval(interval));

        if (path) {
            try {
                this.watchdog = new FreezeWatchdog();
                this.watchdog.start(path, join(dirname(path), 'heartbeat.txt'), () => this.diag.context(), (m) => this.diag.log('WARN', m), win);
            } catch (e) {
                this.diag.log('WARN', 'watchdog failed to start', { err: String(e) });
            }
        }

        // Uncaught errors in any window.
        this.registerDomEvent(win, 'error', (e: ErrorEvent) =>
            this.diag.log('ERROR', 'window error', { msg: e.message, src: e.filename, line: e.lineno }),
        );
        this.registerDomEvent(win, 'unhandledrejection', (e: PromiseRejectionEvent) =>
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
                id: leaf ? kit.getLeafId(leaf) : undefined,
                type: leaf?.view?.getViewType?.(),
            });
        }));
        const watchVisibility = (w: Window, label: string) => {
            this.registerDomEvent(w.document, 'visibilitychange', () =>
                this.diag.log('VIS', label, { state: w.document.visibilityState, focused: w.document.hasFocus() }));
            this.registerDomEvent(w, 'focus', () => this.diag.log('VIS', label + ' focus'));
            this.registerDomEvent(w, 'blur', () => this.diag.log('VIS', label + ' blur'));
        };
        watchVisibility(win, 'main');
        this.diag.log('VIS', 'initial', { state: win.document.visibilityState, focused: win.document.hasFocus() });
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
        forEachWindow(this, (win) => {
            this.applyActiveTabColorsToWindow(win);
            return () => this.clearActiveTabColorsFromWindow(win);
        });

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
                if (!leaf || kit.isLeafDetached(leaf) || this.isSidebarLeaf(leaf)) return;

                this.recency.touch(leaf);
                this.recency.prune(this.app);

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
    }

    /**
     * Pushes the configured active-tab colors onto every open window's body
     * element as CSS custom properties, and toggles the marker class so the
     * CSS rule only applies when the feature is enabled.
     */
    applyActiveTabColors(): void {
        const { colorActiveTabEnabled, activeTabColorLight, activeTabColorDark } = this.settings;

        for (const win of this.getOpenWindows()) {
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

    private clearActiveTabColorsFromWindow(win: Window): void {
        try {
            const body = win.document?.body;
            if (!body) return;
            body.classList.remove("ntg-color-active-tab");
            body.style.removeProperty("--ntg-active-tab-color-light");
            body.style.removeProperty("--ntg-active-tab-color-dark");
        } catch {
            return;
        }
    }

    /**
     * Activates a leaf and requests focus for its owning window, raising it to
     * the foreground via the OS-level `raiseWindow` from `commons/os` so that
     * the Windows foreground lock does not silently ignore the focus request.
     */
    private focusLeafAndWindow(leaf: WorkspaceLeaf): void {
        kit.focusLeafAndWindow(this.app, leaf, { raiseWindow });
    }

    private isLeafAttached(leaf: WorkspaceLeaf): boolean {
        return kit.isLeafAttached(leaf);
    }

    private pruneTabGroupActiveLeaves(): void {
        for (const [parent, leaf] of this.tabGroupActiveLeaves.entries()) {
            if (
                !leaf.parent ||
                leaf.parent !== parent ||
                kit.isLeafDetached(leaf) ||
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

    // ------------------------------------------------------------------------
    // Window-aware helpers
    // ------------------------------------------------------------------------

    private getMainWindow(): Window | undefined {
        return kit.getMainWindow(this.app);
    }

    private isMainLeaf(leaf: WorkspaceLeaf | null): boolean {
        return kit.isMainLeaf(this.app, leaf);
    }

    /**
     * Robustly resolves the native DOM Window hosting a leaf across Obsidian versions.
     */
    private getWindowForLeaf(
        leaf: WorkspaceLeaf | null,
    ): Window | undefined {
        return kit.getWindowForLeaf(leaf);
    }

    /**
     * Get the active leaf in the currently focused window. Falls back to
     * app.workspace.activeLeaf when the focused window cannot be determined.
     */
    private getActiveLeafInFocusedWindow(): WorkspaceLeaf | null {
        return kit.getActiveLeafInFocusedWindow(this.app);
    }


    // ------------------------------------------------------------------------
    // Tab group discovery & navigation
    // ------------------------------------------------------------------------

    /** Tab groups in clockwise ring order (see `ringOrder`), from their DOM rectangles. */
    private getRingGroups(groups: TabGroupInfo[]): TabGroupInfo[] {
        return ringOrder(
            groups,
            (g) => kit.getGroupRect(g.group),
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
        return kit.isSidebarLeaf(this.app, leaf);
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
        return kit.getEditorLeafLocations(this.app);
    }

    /** Every open native window: the main window plus each window the model sees. */
    private getOpenWindows(): Set<Window> {
        return kit.getOpenWindows(this.app);
    }

    /**
     * Tab groups from already-classified leaf locations: commons groups them by
     * (window, parent), decides which group is current and which direction the
     * others lie in; the plugin adds labels and orders by recency, then label.
     */
    private buildTabGroupInfos(
        locations: LeafLocation[],
        activeLeaf: WorkspaceLeaf | null,
    ): TabGroupInfo[] {
        return kit
            .buildTabGroups(locations, activeLeaf, this.recency)
            .map((group) => this.toTabGroupInfo(group))
            .sort((a, b) => b.lastActive - a.lastActive || a.label.localeCompare(b.label));
    }

    private toTabGroupInfo(group: TabGroup): TabGroupInfo {
        const relativeLabel = group.direction
            ? this.capitalizeFirst(DIRECTION_PHRASES[group.direction])
            : null;

        return {
            ...group,
            label: this.formatTabGroupLabel(
                group.representative,
                group.leaves.length,
                group.isCurrent,
                relativeLabel,
            ),
            relativeLabel,
            isCurrentGroup: group.isCurrent,
        };
    }

    private buildTabInfos(groups: TabGroupInfo[]): TabInfo[] {
        return kit.buildTabEntries(groups, this.recency);
    }

    private buildWindowInfos(
        groups: TabGroupInfo[],
        activeLeaf: WorkspaceLeaf | null,
    ): WindowInfo[] {
        return kit
            .buildWindowEntries(this.app, groups, activeLeaf, this.recency)
            .map((entry) => {
                const windowGroups = [...entry.groups].sort(
                    (a, b) => b.lastActive - a.lastActive || a.label.localeCompare(b.label),
                );
                const representative = windowGroups[0].representative;
                const role = entry.isMain ? 'Main window' : `Pop-out ${entry.popoutOrdinal}`;

                return {
                    window: entry.window,
                    groups: windowGroups,
                    representative,
                    lastActive: this.getLeafLastActive(representative),
                    label: this.formatWindowLabel(role, windowGroups, representative),
                    isCurrentWindow: entry.isCurrent,
                    isMainWindow: entry.isMain,
                };
            })
            .sort((a, b) => b.lastActive - a.lastActive || a.label.localeCompare(b.label));
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
        return kit.getGroupsInWindow(model, targetWindow);
    }

    private getTabsInWindow(
        model: WorkspaceNavigationModel,
        targetWindow: Window | undefined,
    ): TabInfo[] {
        return kit.getTabsInWindow(model, targetWindow);
    }

    private getGroupForLeaf(
        model: WorkspaceNavigationModel,
        leaf: WorkspaceLeaf | null,
    ): TabGroupInfo | null {
        return kit.getGroupForLeaf(model, leaf);
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

    /** Search text for a tab group row: every tab title (representative first), then its location. */
    private groupSearch(group: TabGroupInfo): JoinedSearch {
        const rep = group.representative.getDisplayText() || 'Untitled tab';
        const titles = uniqueTitles([rep, ...group.leaves.map((l) => l.getDisplayText())]);
        return joinedSearch(titles, this.getTabGroupLocation(group));
    }

    /** Search text for a window row: every tab title (representative first), then its number and HERE/MAIN. */
    private windowSearch(item: WindowInfo): JoinedSearch {
        const rep = item.representative.getDisplayText() || 'Untitled tab';
        const titles = uniqueTitles([rep, ...item.groups.flatMap((g) => g.leaves.map((l) => l.getDisplayText()))]);
        const words = [
            `Window ${getSessionWindowIndex(item)}`,
            ...(item.isCurrentWindow ? ['here'] : []),
            ...(item.isMainWindow ? ['main'] : []),
        ];
        return joinedSearch(titles, words.join(' '));
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
            ? Boolean(windowInfo.isMainWindow)
            : this.isMainLeaf(leaf);
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
        return labels.get(win) ?? (win && win === this.getMainWindow() ? "Main window" : "Pop-out");
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
        const search = this.groupSearch(group);
        const matches = mapFuzzyMatchesToDisplayText(
            search.text,
            title,
            0,
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
        renderJoinedHits(el, search, match?.match.matches ?? []);
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

        const search = this.windowSearch(item);
        const matches = mapFuzzyMatchesToDisplayText(
            search.text,
            recent,
            0,
            match?.match.matches ?? [],
        );
        const parts = [groupCount];
        this.renderGridRow(el, item.representative, item.window, recent, matches, parts.join(" · "), item, true);
        renderJoinedHits(el, search, match?.match.matches ?? []);
    }

    private renderInGroupTabSuggestion(
        leaf: WorkspaceLeaf,
        el: HTMLElement,
        match?: FuzzyMatch<WorkspaceLeaf>,
    ): void {
        // Every row is in the active group's own window, so no window badge or pills.
        this.renderGridRow(el, leaf, this.getWindowForLeaf(leaf), leaf.getDisplayText(), match?.match.matches ?? [], "", undefined, false);
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
                nothingCheckedNotice: 'No windows checked to collect.',
                windowRing: this.settings.switchLeftRightNavigation ? (wins) => this.getRingWindows(wins) : undefined,
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
                targets.push({ el: kit.getWindowContainerEl(winInfo.representative), cls: 'ntg-switch-target-window' });
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
        if (kit.closePopoutWindowIfEmpty(this.app, win)) {
            this.diag.log('STEP', 'closing popout window');
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
        if (!activeLeaf || this.isSidebarLeaf(activeLeaf) || kit.isLeafDetached(activeLeaf)) return;

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
                .filter((leaf) => leaf.parent !== targetParent && !this.isSidebarLeaf(leaf) && !kit.isLeafDetached(leaf));
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
                .filter((leaf) => leaf.parent !== targetParent && !this.isSidebarLeaf(leaf) && !kit.isLeafDetached(leaf));
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
                    .filter((leaf) => leaf.parent !== targetParent && !this.isSidebarLeaf(leaf) && !kit.isLeafDetached(leaf));
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

        if (tabsToMigrate.length === 0) {
            // Nothing to move is a correct outcome, but a silent no-op reads as a failure.
            new Notice(this.nothingToCollectMessage(scope, model, scope === 'multi' ? source ?? [] : []));
            return;
        }

        const targetParent = destLeaf.parent as any;
        if (!targetParent) return;

        if (this.collectInFlight > 0) this.diag.log('WARN', 'collectTabs re-entered while another is in flight', { inFlight: this.collectInFlight });
        this.collectInFlight++;
        const endCollect = this.diag.begin('collectTabs', { scope, tabs: tabsToMigrate.length, popouts: evacuatedPopouts.size });
        this.logLayout('collectTabs before');
        try {
            for (const leaf of tabsToMigrate) {
                this.diag.log('STEP', 'collect migrate leaf', { id: this.getLeafId(leaf) });
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
                this.diag.log('STEP', 'collect detach old leaf', { id: this.getLeafId(leaf) });
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

    /**
     * Toast for a Collect tabs run that found nothing to move: terse, and with
     * several windows it names the windows checked.
     */
    private nothingToCollectMessage(
        scope: 'current' | 'all' | 'multi',
        model: WorkspaceNavigationModel,
        checked: WindowInfo[],
    ): string {
        if (model.windows.length <= 1) return 'No tabs to collect.';
        if (scope === 'all') return 'No tabs to collect in any window.';
        const nums = checked.map((w) => getSessionWindowIndex(w));
        return `No tabs to collect in window${nums.length === 1 ? '' : 's'} ${nums.join(', ')}.`;
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
        return kit.getLeafFileKey(leaf);
    }

    private getLeafId(leaf: WorkspaceLeaf): string {
        return kit.getLeafId(leaf);
    }

    private getLeafLastActive(leaf: WorkspaceLeaf): number {
        return this.recency.get(leaf);
    }

    private pickMostRecent(leaves: WorkspaceLeaf[]): WorkspaceLeaf {
        return this.recency.pickMostRecent(leaves);
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
        const activeWindow = this.getWindowForLeaf(activeLeaf);

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

        if (activeWindow) {
            const inWindow = leaves.filter((l) => this.getWindowForLeaf(l) === activeWindow);
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
        removed: WorkspaceLeaf[],
        model: WorkspaceNavigationModel,
    ): HTMLElement {
        // Multi-window context safety: createElement using activeDocument
        const doc = activeDocument as unknown as Document;
        const root = doc.createElement('div');
        root.classList.add('ntg-dedupe-confirm');

        const removedIds = new Set(removed.map((l) => this.getLeafId(l)));
        const fileGroups = this.groupLeavesByFile(scope);
        const activeTabGroup = activeLeaf?.parent as WorkspaceParent | null;
        const activeWindow = this.getWindowForLeaf(activeLeaf);

        const entries: Array<{ file: string; count: number; parts: string[] }> = [];
        const sortedEntries = [...fileGroups.entries()].sort(([a], [b]) => a.localeCompare(b));
        for (const [file, leaves] of sortedEntries) {
            if (leaves.length <= 1) continue;
            const fileRemoved = leaves.filter((l) => removedIds.has(this.getLeafId(l)));
            if (fileRemoved.length === 0) continue;

            const currentWindowTabs: WorkspaceLeaf[] = [];
            const otherWindowTabs: WorkspaceLeaf[] = [];
            for (const leaf of fileRemoved) {
                if (activeWindow && this.getWindowForLeaf(leaf) !== activeWindow) {
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
                        const direction = this.getGroupForLeaf(model, leaf)?.direction;
                        const rel = direction ? DIRECTION_PHRASES[direction] : 'another group';
                        label = `${rel} (current window)`;
                    }
                    locationCounts.set(label, (locationCounts.get(label) ?? 0) + 1);
                }
                for (const [label, n] of locationCounts) {
                    parts.push(`${n} in ${label}`);
                }
            }
            if (otherWindowTabs.length > 0) {
                const distinctWindows = new Set(otherWindowTabs.map((l) => this.getWindowForLeaf(l)));
                const windowCount = distinctWindows.size;
                parts.push(`${otherWindowTabs.length} in ${windowCount} other window${windowCount === 1 ? '' : 's'}`);
            }

            // Say which copy stays, so a window full of duplicates is not
            // mistaken for one that is about to be closed.
            const kept = leaves.find((l) => !removedIds.has(this.getLeafId(l)));
            const keptInfo = kept ? model.windows.find((w) => w.window === this.getWindowForLeaf(kept)) : undefined;
            if (keptInfo && model.windows.length > 1) {
                parts.push(`keeps the copy in window ${getSessionWindowIndex(keptInfo)}`);
            } else if (kept) {
                parts.push('keeps one copy');
            }

            entries.push({ file, count: fileRemoved.length, parts });
        }

        const summary = doc.createElement('p');
        summary.classList.add('ntg-dedupe-summary');
        summary.textContent = `Will close ${this.describeClosures(removed, model)}, duplicates of ${entries.length} note${entries.length === 1 ? '' : 's'}. Red outlines in the workspace are closed, green are kept.`;
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

    private basename(path: string): string {
        const idx = path.lastIndexOf('/');
        return idx >= 0 ? path.slice(idx + 1) : path;
    }

    private askConfirmation(title: string, body: HTMLElement, targets: HighlightTarget[] = []): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new DedupeConfirmModal(this.app, title, body, resolve, targets);
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
        const mainWinInfo = model.windows.find((w) => w.isMainWindow);
        const scopeWindow = activeWindow ?? mainWinInfo?.window;
        const windowLeaves: WorkspaceLeaf[] = this.getTabsInWindow(model, scopeWindow).map((tab) => tab.leaf);
        scopes.push({
            id: 'window',
            kind: 'window',
            label: 'This window',
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
                label: `Window ${n}`,
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

        // One possible action and no confirmation wanted: just do it. When the
        // user wants to confirm, show the picker even for one action, because
        // it previews what closes (rows, tab/group outlines, footer) far
        // better than a plain confirmation dialog.
        if (scopes.length === 1 && !this.settings[scopes[0].confirmKey]) {
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
            const isMain = Boolean(scope.winInfo?.isMainWindow);
            const isHere = scope.kind === 'window' && Boolean(scope.winInfo);
            // Window numbers and HERE/MAIN only disambiguate with 2+ windows.
            const multi = model.windows.length > 1;
            const status = !multi ? undefined : isHere && isMain ? 'HERE · MAIN' : isHere ? 'HERE' : isMain ? 'MAIN' : undefined;
            const single = !multi && scope.kind === 'window';
            return {
                kind: 'scope' as const,
                id: scope.id,
                // The number badge and HERE/MAIN pill already name the window, so a
                // window row's text says what it holds instead of repeating its name.
                label: scope.kind === 'window' || scope.kind === 'other-window' ? this.describeWindowScope(scope) : scope.label,
                // Enter acts on the first row that would close something.
                checked: i === Math.max(0, firstNonEmpty),
                badge: single ? '⧉' : scope.badge,
                winInfo: scope.kind === 'window' || scope.kind === 'other-window' ? scope.winInfo : undefined,
                searchTitles: scope.leaves.map((l) => l.getDisplayText()),
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
                getSummary: (chosen) => this.dedupeSummary(pickerScopes, chosen.map((c) => ({ id: c.kind === 'scope' ? c.id : '' })), activeLeaf),
                getTargets: (chosen) => this.dedupeHighlightTargets(pickerScopes, chosen.map((c) => ({ id: c.kind === 'scope' ? c.id : '' })), activeLeaf),
                placeholder: 'Choose windows or groups to deduplicate across',
                nothingCheckedNotice: 'Nothing checked to deduplicate.',
                windowRing: this.settings.switchLeftRightNavigation ? (wins) => this.getRingWindows(wins) : undefined,
                actionLabel: 'Deduplicate',
                commandName: 'deduplicate-tabs',
                header: {
                    kind: 'dedupe',
                    title: 'Deduplicate tabs',
                    hint: 'Duplicates are matched across everything checked. Red outline = closed, green = kept.',
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
        return this.dedupePlanTargets(this.planDedupe(this.mergeScopeLeaves(scopes.filter((s) => ids.has(s.id))), activeLeaf));
    }

    /**
     * Workspace marks for one dedupe plan, shared by the picker preview and the
     * confirmation dialog so both show exactly what the action will do.
     */
    private dedupePlanTargets(plan: { toRemove: WorkspaceLeaf[]; survivors: WorkspaceLeaf[] } | null): HighlightTarget[] {
        const targets: HighlightTarget[] = [];
        for (const leaf of plan?.toRemove ?? []) {
            if (this.settings.highlightDedupeTabs) {
                targets.push({ el: kit.getTabHeaderEl(leaf), cls: 'ntg-dedupe-close' });
            }
            if (this.settings.highlightDedupeGroups) {
                targets.push({ el: (leaf.parent as WorkspaceContainerEl | null)?.containerEl, cls: 'ntg-dedupe-close-group' });
            }
        }
        if (this.settings.highlightDedupeSurvivors) {
            for (const leaf of plan?.survivors ?? []) {
                targets.push({ el: kit.getTabHeaderEl(leaf), cls: 'ntg-dedupe-keep' });
            }
        }
        return targets;
    }
    /**
     * One-line statement of what Enter would do right now: Enter acts on every
     * checked row plus the highlighted one, which the rows already show.
     */
    private dedupeSummary(
        scopes: Array<DedupeScope & { removeCount: number }>,
        chosen: Array<{ id: string }>,
        activeLeaf: WorkspaceLeaf | null,
    ): string {
        const ids = new Set(chosen.map((c) => c.id));
        const picked = scopes.filter((s) => ids.has(s.id));
        if (picked.length === 0) return 'Nothing checked.';
        const plan = this.planDedupe(this.mergeScopeLeaves(picked), activeLeaf);
        if (!plan) return 'Nothing to close.';
        return `Enter closes ${this.describeClosures(plan.toRemove, this.buildNavigationModel(activeLeaf))}`;
    }

    /**
     * "3 tabs, 1 tab group, 1 window": everything that disappears when
     * `toRemove` is detached. Obsidian closes a tab group once its last tab is
     * gone, and a pop-out window once its last tab group is gone. Only nonzero
     * group/window counts are mentioned.
     */
    private describeClosures(toRemove: WorkspaceLeaf[], model: WorkspaceNavigationModel): string {
        const n = toRemove.length;
        const { groups, windows } = this.dedupeEmptied(toRemove, model);
        return [
            `${n} tab${n === 1 ? '' : 's'}`,
            ...(groups > 0 ? [`${groups} tab group${groups === 1 ? '' : 's'}`] : []),
            ...(windows > 0 ? [`${windows} window${windows === 1 ? '' : 's'}`] : []),
        ].join(', ');
    }

    /**
     * How many tab groups and pop-out windows end up empty (and so are closed
     * by Obsidian) once `toRemove` is detached. The main window is never closed.
     */
    private dedupeEmptied(
        toRemove: WorkspaceLeaf[],
        model: WorkspaceNavigationModel = this.buildNavigationModel(null),
    ): { groups: number; windows: number } {
        const removing = new Set(toRemove);
        // The model's (window, parent) groups and its windows are the only
        // arrangement used here; no separate workspace scan.
        const emptied = model.groups.filter((g) => g.leaves.every((l) => removing.has(l)));
        const emptiedSet = new Set(emptied);
        const windows = model.windows.filter(
            (w) => !w.isMainWindow && w.groups.every((g) => emptiedSet.has(g)),
        ).length;
        return { groups: emptied.length, windows };
    }

    /** "5 tabs in 2 tab groups" for a window row; the badge/pill give the window's identity. */
    private describeWindowScope(scope: DedupeScope): string {
        const tabs = scope.leaves.length;
        const groups = scope.winInfo?.groups.length ?? 0;
        const tabText = `${tabs} tab${tabs === 1 ? '' : 's'}`;
        return groups > 0 ? `${tabText} in ${groups} tab group${groups === 1 ? '' : 's'}` : tabText;
    }

    private mergeScopeLeaves(chosen: DedupeScope[]): WorkspaceLeaf[] {
        const leaves: WorkspaceLeaf[] = [];
        for (const scope of chosen) {
            for (const leaf of scope.leaves) {
                if (!leaves.includes(leaf) && !kit.isLeafDetached(leaf)) leaves.push(leaf);
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
            const model = this.buildNavigationModel(activeLeaf);
            const ok = await this.askConfirmation(
                title,
                this.renderConfirmation(leaves, activeLeaf, plan.toRemove, model),
                this.dedupePlanTargets(plan),
            );
            if (!ok) return;
        }

        const endDedupe = this.diag.begin('dedupe detach', { n: plan.toRemove.length });
        for (const leaf of plan.toRemove) {
            this.diag.log('STEP', 'dedupe detach leaf', { id: this.getLeafId(leaf) });
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

        new NavigationSuggestModal(
            this.app,
            leaves,
            "Select a tab in this group",
            (leaf) => leaf.getDisplayText(),
            (leaf) => this.focusLeafAndWindow(leaf),
            (leaf, el, match) => this.renderInGroupTabSuggestion(leaf, el, match),
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
            targets.push({ el: kit.getTabHeaderEl(leaf), cls: 'ntg-switch-target' });
        }
        if (withGroup && this.settings.highlightSwitchGroup) {
            targets.push({ el: (leaf.parent as WorkspaceContainerEl | null)?.containerEl, cls: 'ntg-switch-target-group' });
        }
        if (withWindow && this.settings.highlightSwitchWindow) {
            targets.push({ el: kit.getWindowContainerEl(leaf), cls: 'ntg-switch-target-window' });
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
            (group) => this.groupSearch(group).text,
            (group) => this.activateTabGroup(group.group, group.representative),
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
      * Map each window to a stable display label. The model's main window
      * is "Main window"; every pop-out is numbered by its position in
     * the recency-ordered window list ("Pop-out 1", "Pop-out 2", …) so distinct
     * pop-outs are distinguishable from one another.
     */
    private buildWindowLabels(
        model: WorkspaceNavigationModel,
    ): Map<Window | undefined, string> {
        const labels = new Map<Window | undefined, string>();
        let popoutOrdinal = 0;

        for (const win of model.windows) {
            if (win.isMainWindow) {
                labels.set(win.window, "Main window");
            } else {
                popoutOrdinal += 1;
                labels.set(win.window, `Pop-out ${popoutOrdinal}`);
            }
        }

        return labels;
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
            (item) => this.windowSearch(item).text,
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
    private readonly highlighter = new TargetHighlighter();

    constructor(
        app: App,
        title: string,
        body: HTMLElement,
        resolve: (ok: boolean) => void,
        private readonly targets: HighlightTarget[] = [],
    ) {
        super(app);
        this.title = title;
        this.body = body;
        this.resolve = resolve;
    }

    onOpen() {
        // Outline, in the workspace, the tabs/groups that will close and the
        // copy that stays, exactly as the Deduplicate picker does.
        this.highlighter.set(this.targets);
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
        this.highlighter.clear();
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
    private cancelInitialSelection?: () => void;

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
        this.cancelInitialSelection?.();
        this.cancelInitialSelection = undefined;
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
        const win = ownerWindow(this.containerEl);
        if (win && this.initialIndex > 0 && this.initialIndex < this.items.length) {
            // Defer execution until after the modal renders its initial suggestions
            this.cancelInitialSelection = setTimeoutIn(win, () => {
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

    /**
     * Obsidian 1.14 removed per-control onChange; every control change now goes
     * through setControlValue. Re-apply the active-tab colors when one of theirs changes.
     */
    async setControlValue(key: string, value: unknown): Promise<void> {
        await super.setControlValue(key, value);
        if (key === 'colorActiveTabEnabled' || key === 'activeTabColorLight' || key === 'activeTabColorDark') {
            this.plugin.applyActiveTabColors();
        }
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
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
                        },
                    },
                    {
                        name: 'Active tab color (light mode)',
                        visible: () => this.plugin.settings.colorActiveTabEnabled,
                        control: {
                            type: 'color',
                            key: 'activeTabColorLight',
                        },
                    },
                    {
                        name: 'Active tab color (dark mode)',
                        visible: () => this.plugin.settings.colorActiveTabEnabled,
                        control: {
                            type: 'color',
                            key: 'activeTabColorDark',
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

