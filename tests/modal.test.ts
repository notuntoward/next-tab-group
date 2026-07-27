import { describe, it, expect, beforeEach } from 'vitest';
import { registerEmacsMotionKeys } from '../src/utils/modal';

interface MockScope {
    registrations: Array<{ modifiers: string[] | null; key: string | null; handler: (evt: KeyboardEvent) => false | void }>;
    register(modifiers: string[] | null, key: string | null, handler: (evt: KeyboardEvent) => false | void): void;
}

function createMockModal() {
    const inputEl = document.createElement('input');
    const scope: MockScope = {
        registrations: [],
        register(modifiers, key, handler) {
            this.registrations.push({ modifiers, key, handler });
        },
    };
    const chooser = {
        selectedItem: 0,
        values: ['a', 'b', 'c'],
        setSelectedItem: (index: number, _scrollIntoView: boolean) => {
            chooser.selectedItem = index;
        },
    };
    const modal = {
        inputEl,
        scope,
        chooser,
    } as unknown as Parameters<typeof registerEmacsMotionKeys>[0];
    return { modal, inputEl, scope, chooser };
}

function triggerKey(scope: MockScope, key: string, modifiers: string[] = ['Ctrl']): void {
    const registration = scope.registrations.find(
        (r) => r.key === key && JSON.stringify(r.modifiers) === JSON.stringify(modifiers),
    );
    if (!registration) {
        throw new Error(`No registration found for ${modifiers.join('+')}+${key}`);
    }
    registration.handler(new KeyboardEvent('keydown', { key }));
}

describe('registerEmacsMotionKeys', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('registers Ctrl+F, Ctrl+B, Ctrl+N, and Ctrl+P', () => {
        const { modal, scope } = createMockModal();
        registerEmacsMotionKeys(modal);

        const keys = scope.registrations.map((r) => r.key);
        expect(keys).toContain('F');
        expect(keys).toContain('B');
        expect(keys).toContain('N');
        expect(keys).toContain('P');
    });

    it('moves the cursor right with Ctrl+F', () => {
        const { modal, inputEl } = createMockModal();
        inputEl.value = 'hello';
        inputEl.setSelectionRange(1, 1);
        registerEmacsMotionKeys(modal);

        triggerKey(modal.scope as unknown as MockScope, 'F');

        expect(inputEl.selectionStart).toBe(2);
        expect(inputEl.selectionEnd).toBe(2);
    });

    it('moves the cursor left with Ctrl+B', () => {
        const { modal, inputEl } = createMockModal();
        inputEl.value = 'hello';
        inputEl.setSelectionRange(3, 3);
        registerEmacsMotionKeys(modal);

        triggerKey(modal.scope as unknown as MockScope, 'B');

        expect(inputEl.selectionStart).toBe(2);
        expect(inputEl.selectionEnd).toBe(2);
    });

    it('does not move the cursor past the end of the input', () => {
        const { modal, inputEl } = createMockModal();
        inputEl.value = 'hi';
        inputEl.setSelectionRange(2, 2);
        registerEmacsMotionKeys(modal);

        triggerKey(modal.scope as unknown as MockScope, 'F');

        expect(inputEl.selectionStart).toBe(2);
    });

    it('does not move the cursor before the start of the input', () => {
        const { modal, inputEl } = createMockModal();
        inputEl.value = 'hi';
        inputEl.setSelectionRange(0, 0);
        registerEmacsMotionKeys(modal);

        triggerKey(modal.scope as unknown as MockScope, 'B');

        expect(inputEl.selectionStart).toBe(0);
    });

    it('collapses a selection and moves to the right edge with Ctrl+F', () => {
        const { modal, inputEl } = createMockModal();
        inputEl.value = 'hello';
        inputEl.setSelectionRange(1, 4);
        registerEmacsMotionKeys(modal);

        triggerKey(modal.scope as unknown as MockScope, 'F');

        expect(inputEl.selectionStart).toBe(4);
        expect(inputEl.selectionEnd).toBe(4);
    });

    it('collapses a selection and moves to the left edge with Ctrl+B', () => {
        const { modal, inputEl } = createMockModal();
        inputEl.value = 'hello';
        inputEl.setSelectionRange(1, 4);
        registerEmacsMotionKeys(modal);

        triggerKey(modal.scope as unknown as MockScope, 'B');

        expect(inputEl.selectionStart).toBe(1);
        expect(inputEl.selectionEnd).toBe(1);
    });

    it('moves the selection down with Ctrl+N', () => {
        const { modal, chooser } = createMockModal();
        chooser.selectedItem = 0;
        registerEmacsMotionKeys(modal);

        triggerKey(modal.scope as unknown as MockScope, 'N');

        expect(chooser.selectedItem).toBe(1);
    });

    it('moves the selection up with Ctrl+P', () => {
        const { modal, chooser } = createMockModal();
        chooser.selectedItem = 2;
        registerEmacsMotionKeys(modal);

        triggerKey(modal.scope as unknown as MockScope, 'P');

        expect(chooser.selectedItem).toBe(1);
    });

    it('does not move the selection past the last suggestion', () => {
        const { modal, chooser } = createMockModal();
        chooser.selectedItem = 2;
        registerEmacsMotionKeys(modal);

        triggerKey(modal.scope as unknown as MockScope, 'N');

        expect(chooser.selectedItem).toBe(2);
    });

    it('does not move the selection before the first suggestion', () => {
        const { modal, chooser } = createMockModal();
        chooser.selectedItem = 0;
        registerEmacsMotionKeys(modal);

        triggerKey(modal.scope as unknown as MockScope, 'P');

        expect(chooser.selectedItem).toBe(0);
    });

    it('handles a missing chooser gracefully', () => {
        const { modal, inputEl } = createMockModal();
        (modal as unknown as { chooser?: unknown }).chooser = undefined;
        inputEl.value = 'test';
        inputEl.setSelectionRange(0, 0);
        registerEmacsMotionKeys(modal);

        expect(() => triggerKey(modal.scope as unknown as MockScope, 'N')).not.toThrow();
        expect(() => triggerKey(modal.scope as unknown as MockScope, 'P')).not.toThrow();
        expect(inputEl.selectionStart).toBe(0);
    });
});
