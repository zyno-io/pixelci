import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { BoundedTtlCache } from '../../src/helpers/BoundedTtlCache';

describe('BoundedTtlCache', () => {
    afterEach(() => mock.restoreAll());

    function mockNow(initial: number) {
        let now = initial;
        mock.method(Date, 'now', () => now);
        return (ms: number) => void (now += ms);
    }

    it('stores and returns values', () => {
        const cache = new BoundedTtlCache<number>(10);
        cache.set('a', 1);
        assert.equal(cache.get('a'), 1);
        assert.equal(cache.get('missing'), undefined);
        assert.equal(cache.size, 1);
    });

    it('evicts the least recently used entry beyond max', () => {
        const cache = new BoundedTtlCache<number>(2);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.get('a'); // refresh a, so b is now the oldest
        cache.set('c', 3);
        assert.equal(cache.size, 2);
        assert.equal(cache.get('b'), undefined);
        assert.equal(cache.get('a'), 1);
        assert.equal(cache.get('c'), 3);
    });

    it('re-setting a key refreshes its recency', () => {
        const cache = new BoundedTtlCache<number>(2);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('a', 10);
        cache.set('c', 3);
        assert.equal(cache.get('b'), undefined);
        assert.equal(cache.get('a'), 10);
    });

    it('expires entries after the default ttl and removes them', () => {
        const advance = mockNow(1_000);
        const cache = new BoundedTtlCache<number>(10, 100);
        cache.set('a', 1);
        advance(99);
        assert.equal(cache.get('a'), 1);
        advance(1);
        assert.equal(cache.get('a'), undefined);
        assert.equal(cache.size, 0);
    });

    it('honours a per-entry ttl over the default', () => {
        const advance = mockNow(1_000);
        const cache = new BoundedTtlCache<number>(10, 100);
        cache.set('short', 1, 10);
        cache.set('long', 2, 1_000);
        advance(50);
        assert.equal(cache.get('short'), undefined);
        assert.equal(cache.get('long'), 2);
    });

    it('does not extend ttl when an entry is read', () => {
        const advance = mockNow(0);
        const cache = new BoundedTtlCache<number>(10, 100);
        cache.set('a', 1);
        advance(60);
        assert.equal(cache.get('a'), 1);
        advance(60);
        assert.equal(cache.get('a'), undefined);
    });

    it('supports delete and clear', () => {
        const cache = new BoundedTtlCache<number>(10);
        cache.set('a', 1);
        cache.set('b', 2);
        assert.equal(cache.delete('a'), true);
        assert.equal(cache.delete('a'), false);
        cache.clear();
        assert.equal(cache.size, 0);
    });
});
