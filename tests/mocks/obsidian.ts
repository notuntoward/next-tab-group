// Minimal mocks for the Obsidian API surface used by the tests.
// These are not full implementations — they only cover what the plugin touches.

export class MockContainerEl {
    ownerDocument: { defaultView: Window } | undefined;
    private classes = new Set<string>();
    classList = {
        contains: (c: string) => this.classes.has(c),
        add: (c: string) => this.classes.add(c),
        remove: (c: string) => this.classes.delete(c),
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

// Polyfill Obsidian DOM extension methods on HTMLElement in the test jsdom environment
if (typeof HTMLElement !== 'undefined') {
    const proto = HTMLElement.prototype as any;
    if (!proto.empty) {
        proto.empty = function () {
            while (this.firstChild) {
                this.removeChild(this.firstChild);
            }
        };
    }
    if (!proto.createDiv) {
        proto.createDiv = function (opts?: { cls?: string; text?: string }) {
            const div = document.createElement('div');
            if (opts?.cls) div.className = opts.cls;
            if (opts?.text) div.textContent = opts.text;
            this.appendChild(div);
            return div;
        };
    }
    if (!proto.createSpan) {
        proto.createSpan = function (opts?: { cls?: string; text?: string }) {
            const span = document.createElement('span');
            if (opts?.cls) span.className = opts.cls;
            if (opts?.text) span.textContent = opts.text;
            this.appendChild(span);
            return span;
        };
    }
    if (!proto.createEl) {
        proto.createEl = function (tag: string, opts?: { cls?: string; text?: string; type?: string; attr?: Record<string, string> }) {
            const el = document.createElement(tag);
            if (opts?.cls) el.className = opts.cls;
            if (opts?.text) el.textContent = opts.text;
            if (opts?.type && 'type' in el) (el as HTMLInputElement).type = opts.type;
            if (opts?.attr) {
                for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
            }
            this.appendChild(el);
            return el;
        };
    }
    if (!proto.setText) {
        proto.setText = function (text: string) {
            this.textContent = text;
        };
    }
    if (!proto.addClass) {
        proto.addClass = function (...classes: string[]) {
            for (const c of classes) {
                if (c) this.classList.add(c);
            }
        };
    }
    if (!proto.removeClass) {
        proto.removeClass = function (...classes: string[]) {
            for (const c of classes) {
                if (c) this.classList.remove(c);
            }
        };
    }
    if (!proto.hasClass) {
        proto.hasClass = function (cls: string) {
            return this.classList.contains(cls);
        };
    }
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
    view: { file?: { path: string } | null; containerEl?: HTMLElement } = { file: null, containerEl: document.createElement('div') };
    containerEl: HTMLElement = document.createElement('div');
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

    getParent(): MockWorkspaceParent | null {
        return this.parent;
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

    ephemeralState: Record<string, unknown> = {};
    lastSetViewStateArg: unknown = null;
    lastSetEphemeralStateArg: unknown = null;

    getEphemeralState(): Record<string, unknown> {
        return this.ephemeralState;
    }

    setEphemeralState(state: Record<string, unknown>): this {
        this.ephemeralState = state;
        return this;
    }

    setViewState(
        typeOrViewState: string | { type: string; state?: Record<string, unknown>; [key: string]: unknown },
        stateOrEphemeral?: Record<string, unknown>
    ): Promise<void> {
        if (typeof typeOrViewState === 'string') {
            this.viewState = { type: typeOrViewState, ...(stateOrEphemeral ? { state: stateOrEphemeral } : {}) };
            this.lastSetViewStateArg = this.viewState;
        } else {
            this.viewState = typeOrViewState;
            this.lastSetViewStateArg = typeOrViewState;
            if (stateOrEphemeral) {
                this.ephemeralState = stateOrEphemeral;
                this.lastSetEphemeralStateArg = stateOrEphemeral;
            }
        }
        return Promise.resolve();
    }

    detach(): void {
        this.detached = true;
        if (this.parent) {
            this.parent.children = this.parent.children.filter((c) => c !== this);
        }
        this.parent = null;
    }
}

export class MockWorkspaceWindow {
    closed = false;
    doc = globalThis.document;
    constructor(public win: Window = {} as Window) {}
    close(): void {
        this.closed = true;
    }
    getContainer(): { win: Window } {
        return { win: this.win };
    }
}

export class MockWorkspace {
    activeLeaf: MockWorkspaceLeaf | null = null;
    rootLeaves: MockWorkspaceLeaf[] = [];
    allLeaves: MockWorkspaceLeaf[] = [];
    rootSplit = Symbol('rootSplit');
    leftSplit = Symbol('leftSplit');
    rightSplit = Symbol('rightSplit');
    floatingSplit = {
        children: [] as MockWorkspaceWindow[],
    };
    private eventHandlers: Map<string, Array<(...args: unknown[]) => void>> = new Map();

    setActiveLeaf(leaf: MockWorkspaceLeaf, _opts?: { focus?: boolean }): void {
        this.activeLeaf = leaf;
    }

    onLayoutChange(): void {
        this.trigger('layout-change');
    }

    trigger(name: string, ...args: unknown[]): void {
        const handlers = this.eventHandlers.get(name) ?? [];
        for (const handler of handlers) {
            handler(...args);
        }
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

    /**
     * Spawn a new leaf and register it. `'tab'` produces a sibling leaf in the
     * currently active group (its parent becomes that of the active leaf when
     * one exists); any other argument produces a child leaf that is wired to a
     * fresh `MockWorkspaceParent` so `createLeafBySplit` can anchor off it.
     */
    getLeaf(type: 'tab' | 'split'): MockWorkspaceLeaf {
        const leaf = new MockWorkspaceLeaf(null);
        leaf.setId(`leaf_${this.allLeaves.length}`);
        if (type === 'tab') {
            const activeParent = this.activeLeaf?.parent as MockWorkspaceParent | null;
            if (activeParent) leaf.setParent(activeParent);
        } else {
            leaf.setParent(new MockWorkspaceParent(this.activeLeaf?.getContainer() ?? undefined));
        }
        this.allLeaves.push(leaf);
        return leaf;
    }

    createLeafBySplit(
        anchor: MockWorkspaceLeaf,
        _direction: 'horizontal' | 'vertical',
    ): MockWorkspaceLeaf {
        const split = new MockWorkspaceParent(anchor.getContainer() ?? undefined);
        anchor.setParent(split);
        const leaf = new MockWorkspaceLeaf(null);
        leaf.setId(`leaf_${this.allLeaves.length}`);
        leaf.setParent(split);
        this.allLeaves.push(leaf);
        return leaf;
    }

    createLeafInParent(parent: MockWorkspaceParent, _index: number): MockWorkspaceLeaf {
        const leaf = new MockWorkspaceLeaf(null);
        leaf.setId(`leaf_${this.allLeaves.length}`);
        leaf.setParent(parent);
        this.allLeaves.push(leaf);
        return leaf;
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

    commands: Array<Record<string, unknown>> = [];
    addCommand(cmd: Record<string, unknown>): void {
        this.commands.push(cmd);
    }
    addSettingTab(tab: unknown): void {
        this.settingTab = tab;
    }
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
    instructions: Array<{ command: string; purpose: string }> = [];
    emptyStateText = '';
    isOpen = false;
    contentEl: HTMLElement = document.createElement('div');
    resultContainerEl: HTMLElement = document.createElement('div');
    inputEl: HTMLInputElement = document.createElement('input');
    scope = {
        registrations: [] as Array<{
            modifiers: string[] | null;
            key: string | null;
            func: (evt: KeyboardEvent) => false | void;
        }>,
        register(
            modifiers: string[] | null,
            key: string | null,
            func: (evt: KeyboardEvent) => false | void,
        ) {
            this.registrations.push({ modifiers, key, func });
            return { unload: () => {} };
        },
    };

    constructor(app: MockApp) {
        this.app = app;
    }

    setPlaceholder(placeholder: string): void {
        this.placeholder = placeholder;
    }

    setInstructions(instructions: Array<{ command: string; purpose: string }>): void {
        this.instructions = instructions;
    }

    setSelectedItem(_index?: number): void { /* no-op for mock */ }

    open(): void {
        this.isOpen = true;
        this.onOpen();
    }

    onOpen(): void { /* can be overridden */ }

    close(): void {
        this.isOpen = false;
        this.onClose();
    }

    onClose(): void { /* can be overridden */ }

    getSuggestions(_query: string): T[] { return []; }
    renderSuggestion(_item: T, _el: HTMLElement): void { /* no-op */ }
    selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
        this.onChooseSuggestion(value, evt);
        this.close();
    }
    onChooseSuggestion(_item: T, _evt?: MouseEvent | KeyboardEvent): void { /* no-op */ }

    getItems(): T[] { return []; }
    getItemText(_item: T): string { return String(_item); }
    onChooseItem(_item: T, _evt?: MouseEvent | KeyboardEvent): void { /* no-op */ }
}

export class MockNotice {
    constructor(public message: string, _timeout?: number) {}
}
export const Notice = MockNotice;

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
