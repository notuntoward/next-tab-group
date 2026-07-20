import { describe, it, expect, beforeEach } from 'vitest';
import { updateElementPathDatasets } from '../src/utils/dom';

describe('updateElementPathDatasets', () => {
    let element: HTMLElement;

    beforeEach(() => {
        element = document.createElement('div');
    });

    it('should set data-path, data-link-path, data-href, and data-link-data-href when a path is provided', () => {
        updateElementPathDatasets(element, 'Folder/Note.md');

        expect(element.dataset.path).toBe('Folder/Note.md');
        expect(element.dataset.linkPath).toBe('Folder/Note.md');
        expect(element.dataset.href).toBe('Folder/Note.md');
        expect(element.dataset.linkDataHref).toBe('Folder/Note');
    });

    it('should add data-link-text class when a path is provided', () => {
        updateElementPathDatasets(element, 'Folder/Note.md');

        expect(element.classList.contains('data-link-text')).toBe(true);
    });

    it('should remove all path dataset attributes and class when path is null', () => {
        element.dataset.path = 'Folder/Note.md';
        element.dataset.linkPath = 'Folder/Note.md';
        element.dataset.href = 'Folder/Note.md';
        element.dataset.linkDataHref = 'Folder/Note';
        element.classList.add('data-link-text');

        updateElementPathDatasets(element, null);

        expect(element.dataset.path).toBeUndefined();
        expect(element.dataset.linkPath).toBeUndefined();
        expect(element.dataset.href).toBeUndefined();
        expect(element.dataset.linkDataHref).toBeUndefined();
        expect(element.classList.contains('data-link-text')).toBe(false);
    });

    it('should remove all path dataset attributes and class when path is undefined', () => {
        element.dataset.href = 'OldNote.md';
        element.classList.add('data-link-text');

        updateElementPathDatasets(element, undefined);

        expect(element.dataset.href).toBeUndefined();
        expect(element.classList.contains('data-link-text')).toBe(false);
    });

    it('should strip .md extension for data-link-data-href', () => {
        updateElementPathDatasets(element, 'Note.md');

        expect(element.dataset.linkDataHref).toBe('Note');
    });
});
