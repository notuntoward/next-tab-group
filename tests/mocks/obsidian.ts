// Minimal mocks for the Obsidian API surface used by the tests.
// These are not full implementations — they only cover what the plugin touches.

export class MockContainerEl {
    classList = {
        contains: () => false,
    };

    getBoundingClientRect(): DOMRect {
        return {
            left: 0,
            top: 0,
            width: 100,
            height: 100,
            right: 100,
            bottom: 100,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        } as DOMRect;
    }

    instanceOf(ctor: typeof HTMLElement): boolean {
        return ctor === HTMLElement;
    }

    createEl(tag: string, _attrs?: Record<string, unknown>): HTMLElement {
        return document.createElement(tag);
    }

    createDiv(): HTMLElement {
        return document.createElement('div');
    }

    empty(): void {
        // no-op for mock
    }

    appendChild(_child: Node): void {
        // no-op for mock
    }

    addClass(): void { /* no-op */ }
}

export class MockWorkspaceContainer {
    id = 'container';
    win: Window;
    doc = globalThis.document;

    constructor(public name: 'root' | 'window' = 'root', win?: Window) {
        this.win = win ?? globalThis.window;
    }
}

export class MockWorkspaceParent {
    id = 'parent';
    containerEl = new MockContainerEl();
    children: MockWorkspaceLeaf[] = [];

    constructor(public container?: MockWorkspaceContainer) {}
}

export class MockWorkspaceLeaf {
    id = '';
    parent: MockWorkspaceParent | null = null;
    view: { file?: { path: string } | null } = { file: null };
    private viewState: { type: string; state?: Record<string, unknown> } = { type: 'markdown' };
    private container: MockWorkspaceContainer | null = null;
    detached = false;

    constructor(public filePath: string | null = null) {
        if (filePath) {
            this.view.file = { path: filePath };
            this.viewState = { type: 'markdown', state: { file: filePath } };
        }
    }

    setId(id: string): this {
        this.id = id;
        return this;
    }

    setParent(parent: MockWorkspaceParent): this {
        this.parent = parent;
        if (!parent.children.includes(this)) {
            parent.children.push(this);
        }
        return this;
    }

    setContainer(container: MockWorkspaceContainer): this {
        this.container = container;
        return this;
    }

    getContainer(): MockWorkspaceContainer | null {
        return this.container;
    }

    getRoot(): unknown {
        return this.container;
    }

    getViewState(): { type: string; state?: Record<string, unknown> } {
        return this.viewState;
    }

    getDisplayText(): string {
        return this.filePath ?? 'Untitled tab';
    }

    setViewState(type: string, state?: Record<string, unknown>): this {
        this.viewState = { type, ...(state ? { state } : {}) };
        return this;
    }

    detach(): void {
        this.detached = true;
        if (this.parent) {
            this.parent.children = this.parent.children.filter((c) => c !== this);
        }
    }
}

export class MockWorkspace {
    activeLeaf: MockWorkspaceLeaf | null = null;
    rootLeaves: MockWorkspaceLeaf[] = [];
    allLeaves: MockWorkspaceLeaf[] = [];
    rootSplit = Symbol('rootSplit');
    leftSplit = Symbol('leftSplit');
    rightSplit = Symbol('rightSplit');
    private eventHandlers: Map<string, Array<(...args: unknown[]) => void>> = new Map();

    setActiveLeaf(leaf: MockWorkspaceLeaf, _opts?: { focus?: boolean }): void {
        this.activeLeaf = leaf;
    }

    iterateRootLeaves(callback: (leaf: MockWorkspaceLeaf) => void): void {
        for (const leaf of this.rootLeaves) {
            callback(leaf);
        }
    }

    iterateAllLeaves(callback: (leaf: MockWorkspaceLeaf) => void): void {
        for (const leaf of this.allLeaves) {
            callback(leaf);
        }
    }

    getLeafById(id: string): MockWorkspaceLeaf | null {
        return this.allLeaves.find((l) => l.id === id) ?? null;
    }

    on(name: string, callback: (...args: unknown[]) => void): { unload: () => void } {
        const handlers = this.eventHandlers.get(name) ?? [];
        handlers.push(callback);
        this.eventHandlers.set(name, handlers);
        return { unload: () => void 0 };
    }

    emit(name: string, ...args: unknown[]): void {
        for (const handler of this.eventHandlers.get(name) ?? []) {
            handler(...args);
        }
    }
}

export class MockApp {
    workspace = new MockWorkspace();
    vault = {
        adapter: {
            exists: async () => false,
            read: async () => '',
        },
    };
}

export class MockPlugin {
    app: MockApp;
    manifest = { dir: '' };
    settings: Record<string, unknown> = {};
    private intervals: Array<{ id: number }> = [];
    private domEvents: Array<{ element: unknown; type: string; callback: unknown }> = [];
    private events: Array<{ unload: () => void }> = [];
    private cleanup: Array<() => void> = [];

    constructor(app: MockApp = new MockApp()) {
        this.app = app;
    }
    async loadData(): Promise<Record<string, unknown>> {
        return this.settings;
    }

    async saveData(data: Record<string, unknown>): Promise<void> {
        this.settings = data;
    }

    addCommand(): void { /* no-op */ }
    addSettingTab(): void { /* no-op */ }
    addRibbonIcon(): void { /* no-op */ }
    addStatusBarItem(): void { /* no-op */ }
    registerView(): void { /* no-op */ }

    registerInterval(interval: number): void {
        this.intervals.push({ id: interval });
    }

    registerDomEvent(element: unknown, type: string, callback: unknown): void {
        this.domEvents.push({ element, type, callback });
    }

    registerEvent(event: { unload: () => void }): void {
        this.events.push(event);
    }

    register(callback: () => void): void {
        this.cleanup.push(callback);
    }

    loadStyleSheet(): void { /* no-op for mock */ }
}

export class MockPluginSettingTab {
    constructor(public app: MockApp, public plugin: MockPlugin) {}
    display(): void { /* no-op */ }
}

export class MockSetting {
    constructor(public containerEl: HTMLElement) {}
    setName(_name: string): this { return this; }
    setDesc(_desc: string): this { return this; }
    addToggle(_cb: (toggle: { setValue: (v: boolean) => unknown; onChange: (cb: (v: boolean) => void) => unknown }) => void): this { return this; }
}

export class MockModal {
    titleEl = document.createElement('div');
    contentEl = document.createElement('div');
    scope = { register: () => ({}) };
    private resolve?: (ok: boolean) => void;

    constructor(
        public app: MockApp,
        public title?: string,
        public body?: HTMLElement,
        resolve?: (ok: boolean) => void
    ) {
        this.resolve = resolve;
    }

    open(): void {
        // Tests can call confirm() / cancel() to resolve the modal.
    }

    close(): void { /* no-op */ }

    confirm(): void {
        if (this.resolve) this.resolve(true);
    }

    cancel(): void {
        if (this.resolve) this.resolve(false);
    }
}

export class MockSuggestModal<T> {
    app: MockApp;
    placeholder = '';

    constructor(app: MockApp) {
        this.app = app;
    }

    setPlaceholder(placeholder: string): void {
        this.placeholder = placeholder;
    }

    setSelectedItem(_index?: number): void { /* no-op for mock */ }
    open(): void { /* no-op */ }
    close(): void { /* no-op */ }
    getItems(): T[] { return []; }
    getItemText(_item: T): string { return String(_item); }
    onChooseItem(_item: T, _evt?: MouseEvent | KeyboardEvent): void { /* no-op */ }
}

export class MockFuzzySuggestModal<T> extends MockSuggestModal<T> {}

// Export aliases so that `import { Plugin, Modal, ... } from 'obsidian'` works.
export const Plugin = MockPlugin;
export const Modal = MockModal;
export const PluginSettingTab = MockPluginSettingTab;
export const Setting = MockSetting;
export const WorkspaceLeaf = MockWorkspaceLeaf;
export const SuggestModal = MockSuggestModal;
export const FuzzySuggestModal = MockFuzzySuggestModal;

// Type aliases for type-only imports.
export type App = MockApp;
export type WorkspaceParent = MockWorkspaceParent;
export type WorkspaceContainer = MockWorkspaceContainer;
