import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from './error.js';
import { assertUniqueNames, buildManifest, screenManifestHash } from './manifest.js';

// Shared test vector: the server's ScreenManifest.spec.ts uses the same input and expected hash.
const VECTOR = ['b', 'a', 'é', 'A', 'a b'];
const VECTOR_HASH = '881942208df3d3f7215ddc61b36b5690f91cbbbb5ae24485c4fa69f533d40f34';

describe('screenManifestHash', () => {
    it('matches the shared vector', () => {
        assert.equal(screenManifestHash(VECTOR), VECTOR_HASH);
    });

    it('is order independent and does not mutate its input', () => {
        const input = [...VECTOR];
        assert.equal(screenManifestHash(input.reverse()), VECTOR_HASH);
        assert.deepEqual(input, [...VECTOR].reverse());
    });

    it('hashes the empty set', () => {
        assert.equal(screenManifestHash([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
});

describe('buildManifest', () => {
    it('returns count and hash', () => {
        assert.deepEqual(buildManifest(VECTOR), { count: 5, hash: VECTOR_HASH });
    });
});

describe('assertUniqueNames', () => {
    it('accepts distinct names', () => {
        assertUniqueNames([
            { name: 'a', file: 'a.png' },
            { name: 'b', file: 'b.png' }
        ]);
    });

    it('rejects collisions such as a/b.png vs "a - b.png"', () => {
        assert.throws(
            () =>
                assertUniqueNames([
                    { name: 'a - b', file: 'a/b.png' },
                    { name: 'a - b', file: 'a - b.png' }
                ]),
            AppError
        );
    });
});
