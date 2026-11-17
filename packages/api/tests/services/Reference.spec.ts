import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_BASE_COMMITS, pickAncestorReference, validateBase } from '../../src/services/Reference';

const sha = (n: number) => n.toString(16).padStart(40, '0');

describe('pickAncestorReference', () => {
    it('picks the nearest base commit that has a build, not the newest build', () => {
        const builds = [{ commitHash: sha(1) }, { commitHash: sha(5) }, { commitHash: sha(9) }];
        assert.equal(pickAncestorReference([sha(7), sha(5), sha(1)], builds)?.commitHash, sha(5));
    });

    it('returns undefined when no base commit has a build', () => {
        assert.equal(pickAncestorReference([sha(2), sha(3)], [{ commitHash: sha(1) }]), undefined);
        assert.equal(pickAncestorReference([], [{ commitHash: sha(1) }]), undefined);
    });
});

describe('validateBase', () => {
    it('passes undefined through', () => {
        assert.equal(validateBase(undefined), undefined);
    });

    it('de-duplicates, keeping order', () => {
        assert.deepEqual(validateBase({ commits: [sha(2), sha(1), sha(2)], source: 'merge-base' }), {
            commits: [sha(2), sha(1)],
            source: 'merge-base'
        });
    });

    it('accepts sha-256 object names', () => {
        const long = 'a'.repeat(64);
        assert.deepEqual(validateBase({ commits: [long], source: 'override' })?.commits, [long]);
    });

    it('rejects bad commit lists and sources', () => {
        const bad = [
            { commits: [], source: 'merge-base' },
            { commits: Array.from({ length: MAX_BASE_COMMITS + 1 }, (_, i) => sha(i)), source: 'merge-base' },
            { commits: ['ABCDEF'.padEnd(40, '0')], source: 'merge-base' },
            { commits: ['not-a-sha'], source: 'merge-base' },
            { commits: [sha(1)], source: 'nope' },
            { commits: 'x', source: 'merge-base' }
        ];
        for (const b of bad) assert.throws(() => validateBase(b as never), /base\./);
    });

    it('accepts exactly the maximum', () => {
        const commits = Array.from({ length: MAX_BASE_COMMITS }, (_, i) => sha(i + 1));
        assert.equal(validateBase({ commits, source: 'first-parent' })?.commits.length, MAX_BASE_COMMITS);
    });
});
