/**
 * Synchronizes file path data attributes on a DOM element for compatibility
 * with style plugins like Page Color Prop and Supercharged Links.
 */
export function updateElementPathDatasets(
    el: HTMLElement,
    filePath: string | null | undefined,
): void {
    if (!filePath) {
        delete el.dataset.linkPath;
        delete el.dataset.path;
        delete el.dataset.href;
        delete el.dataset.linkDataHref;
        el.classList.remove('data-link-text');
        return;
    }

    el.dataset.linkPath = filePath;
    el.dataset.path = filePath;
    el.dataset.href = filePath;

    const hrefNoExt = filePath.replace(/\.md$/, '');
    el.dataset.linkDataHref = hrefNoExt;

    el.classList.add('data-link-text');
}
