import { describe, it, expect, vi } from 'vitest';
import { closeOnEscapeFromOtherWindows } from '../src/utils/modal';

function fakeModal(home: Document, others: Document[]) {
    const containerEl = home.createElement('div');
    home.body.appendChild(containerEl);
    const windowOpen: Array<(ws: unknown, win: { document: Document }) => void> = [];
    return {
        windowOpen,
        modal: {
            containerEl,
            close: vi.fn(),
            app: {
                workspace: {
                    iterateAllLeaves: (cb: (leaf: unknown) => void) =>
                        others.forEach((d) => cb({ view: { containerEl: d.body } })),
                    on: (_name: string, cb: (ws: unknown, win: { document: Document }) => void) => {
                        windowOpen.push(cb);
                        return cb;
                    },
                    offref: vi.fn(),
                },
            },
        },
    };
}

const esc = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

describe('closeOnEscapeFromOtherWindows', () => {
    it('closes the modal when Escape is pressed in another window, including one opened later', () => {
        const home = document.implementation.createHTMLDocument('home');
        const popout = document.implementation.createHTMLDocument('popout');
        const later = document.implementation.createHTMLDocument('later');
        const { modal, windowOpen } = fakeModal(home, [popout]);

        const stop = closeOnEscapeFromOtherWindows(modal as never);
        popout.body.dispatchEvent(esc());
        expect(modal.close).toHaveBeenCalledTimes(1);

        windowOpen[0]({}, { document: later });
        later.body.dispatchEvent(esc());
        expect(modal.close).toHaveBeenCalledTimes(2);

        stop();
        popout.body.dispatchEvent(esc());
        expect(modal.close).toHaveBeenCalledTimes(2);
    });

    it('does not listen in the modal\'s own window (Obsidian\'s Scope already handles it)', () => {
        const home = document.implementation.createHTMLDocument('home');
        const { modal } = fakeModal(home, [home]);
        closeOnEscapeFromOtherWindows(modal as never);
        home.body.dispatchEvent(esc());
        expect(modal.close).not.toHaveBeenCalled();
    });
});
