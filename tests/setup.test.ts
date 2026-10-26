import { describe, expect, it, vi } from 'vitest';

describe('jsdom window focus setup', () => {
    it('records window focus requests without calling the unsupported implementation', () => {
        const error = vi.spyOn(console, 'error');
        try {
            window.focus();

            expect(window.focus).toHaveBeenCalledOnce();
            expect(error).not.toHaveBeenCalled();
        } finally {
            error.mockRestore();
        }
    });

    it('starts each test with a fresh window focus spy', () => {
        expect(vi.isMockFunction(window.focus)).toBe(true);
        expect(window.focus).not.toHaveBeenCalled();
    });

    it('preserves real DOM element focus', () => {
        const input = document.createElement('input');
        document.body.append(input);
        try {
            input.focus();

            expect(document.activeElement).toBe(input);
            expect(window.focus).not.toHaveBeenCalled();
        } finally {
            input.remove();
        }
    });
});
