import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { screenManifestHash } from '../../src/services/ScreenManifest';

// Shared test vector: the CLI's screenManifestHash must produce the same hash for the same names.
const VECTOR = ['b', 'a', 'é', 'A', 'a b'];
const VECTOR_HASH = '881942208df3d3f7215ddc61b36b5690f91cbbbb5ae24485c4fa69f533d40f34';

describe('screenManifestHash', () => {
    it('matches the shared test vector (sorted by JS code-unit order, joined with newlines)', () => {
        assert.equal(screenManifestHash(VECTOR), VECTOR_HASH);
    });

    it('is order-independent and does not mutate its input', () => {
        const input = [...VECTOR].reverse();
        const copy = [...input];
        assert.equal(screenManifestHash(input), VECTOR_HASH);
        assert.deepEqual(input, copy);
    });

    it('hashes the empty list as sha256 of the empty string', () => {
        assert.equal(screenManifestHash([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
});
