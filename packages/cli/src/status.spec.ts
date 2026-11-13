import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PASSING, outcomeFor } from './status.js';

describe('outcomeFor', () => {
    it('exits 0 only for the allowlist', () => {
        assert.deepEqual([...PASSING].sort(), ['changes approved', 'no changes']);
        assert.equal(outcomeFor('no changes').code, 0);
        assert.equal(outcomeFor('changes approved').code, 0);
    });

    for (const status of ['needs review', 'changes rejected', 'failed', 'draft', 'processing', 'canceled', '', 'NO CHANGES', 'something new']) {
        it(`exits 1 for '${status}'`, () => {
            assert.equal(outcomeFor(status).code, 1);
        });
    }

    it('explains unknown statuses', () => {
        assert.equal(outcomeFor('weird').message, "Unexpected build status 'weird'; failing to be safe. Upgrade @zyno-io/pixelci-cli.");
    });
});
