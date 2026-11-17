import { defaultRangeExtractor, type Range as VirtualRange } from '@tanstack/vue-virtual';

/**
 * Heights straight from the DOM, unrounded so items stack exactly where normal flow put them. Without a
 * ResizeObserver entry (a re-render) TanStack's default returns the cached size, which misses changes it
 * skipped while a smooth scroll paused measuring. Must be rect height, not offsetHeight: the RO reports
 * fractions, and mixing in integers makes every render see a sub-pixel "resize".
 */
export function measureExact(el: Element, entry: ResizeObserverEntry | undefined) {
    return entry?.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
}

/** The visible range plus overscan, with `pinned` kept rendered wherever it is. */
export function rangeWithPinned(range: VirtualRange, pinned: number[]) {
    const indexes = defaultRangeExtractor(range);
    const extra = pinned.filter(i => i >= 0 && i < range.count && !indexes.includes(i));
    return extra.length ? [...indexes, ...extra].sort((a, b) => a - b) : indexes;
}
