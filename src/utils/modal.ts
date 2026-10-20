// Thin shim over the shared library. The implementation lives in commons/modal;
// this file only supplies this plugin's CSS prefix.
import { addPickerHeader as addPickerHeaderCommon, type PickerHeader } from 'commons/modal';

export * from 'commons/modal';
export const addPickerHeader = (modalEl: HTMLElement | undefined, header: PickerHeader): void =>
    addPickerHeaderCommon(modalEl, header, 'ntg');
