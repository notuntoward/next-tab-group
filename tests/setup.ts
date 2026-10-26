import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';

(globalThis as any).activeDocument = globalThis.document;
(globalThis as any).activeWindow = globalThis.window;

let windowFocus: MockInstance<Window['focus']>;

beforeEach(() => {
    // jsdom cannot foreground an OS window; element focus remains real.
    windowFocus = vi.spyOn(window, 'focus').mockImplementation(() => {});
});

afterEach(() => {
    windowFocus.mockRestore();
});
