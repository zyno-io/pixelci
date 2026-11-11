import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isDeadlockError } from '../../src/controllers/Builds.controller';

describe('isDeadlockError', () => {
    it('detects Postgres deadlock errors by SQLSTATE or message', () => {
        assert.equal(isDeadlockError({ code: '40P01' }), true);
        assert.equal(isDeadlockError(new Error('deadlock detected')), true);
    });

    it('follows the cause chain', () => {
        assert.equal(isDeadlockError(new Error('wrapped', { cause: { code: '40P01' } })), true);
    });

    it('ignores other errors', () => {
        assert.equal(isDeadlockError({ code: '55P03' }), false);
        assert.equal(isDeadlockError(new Error('boom')), false);
        assert.equal(isDeadlockError(undefined), false);
    });
});
